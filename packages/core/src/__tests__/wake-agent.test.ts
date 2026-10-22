/**
 * `runtime.wakeAgent`: one way to start a turn nobody asked for.
 *
 * Before it, only subscription turns stopped for the pause switch and the
 * hourly wake ceiling, because those brakes lived inside subscription
 * delivery. A plugin that started a turn called `runAgentLoop` itself and
 * skipped both. These run a real runtime, built the way the host builds it,
 * so what they check is what a plugin calling `ctx.runtime.wakeAgent` gets.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import type { Wake } from "../agent/wake.js";
import type { OutboundNotifier } from "../channels/outbound.js";
import type { AgentConfig } from "../config.js";
import { updateExploratoryState } from "../db/exploratory-queries.js";
import { initDatabase } from "../db/schema.js";
import type { PreToolUseWaterfall, RuntimeEventPayload } from "../events.js";
import { createMetaTools, createTools } from "../factories.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import { createSubscriptionDelivery } from "../subscriptions/delivery.js";
import type { EventWakeContext } from "../subscriptions/types.js";
import type { Tool, ToolContext } from "../tools/interface.js";

let db: Database.Database;
let home: string;
/** Tool calls the provider makes on its next request, one batch per request; then it answers. */
let queue: Array<Array<{ name: string; arguments: Record<string, unknown> }>>;
let requests: number;
/** When set, the next request waits for it: a turn still running. */
let hold: Promise<void> | undefined;
/** What each `probe` call saw on its context. */
let probed: Array<ToolContext["wake"]>;
/** Which agent made each `probe` call. */
let probedBy: Array<string | undefined>;

const usage = { input: 0, output: 0 };
const provider: AIProvider = {
  id: "openai_compatible",
  name: "scripted",
  supportsTools: true,
  async chat(): Promise<ChatResponse> {
    requests++;
    const waiting = hold;
    hold = undefined;
    if (waiting) await waiting;
    const calls = queue.shift();
    if (!calls) return { content: "done", usage, finishReason: "stop" };
    return {
      content: "",
      toolCalls: calls.map((c, i) => ({ id: `c${requests}-${i}`, ...c })),
      usage,
      finishReason: "tool_calls",
    };
  },
};

/** Declares nothing about what it does. */
const probe: Tool = {
  name: "probe",
  description: "records why the turn runs",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    probed.push(context.wake);
    probedBy.push(context.agentName);
    return { success: true, output: "ok" };
  },
};

/** Says it changes something that can be changed back. */
const save: Tool = {
  name: "save",
  description: "saves a note",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  effect: "write",
  async execute() {
    return { success: true, output: "saved" };
  },
};

function makeConfig(over: { maxWakesPerHour?: number; rooms?: Record<string, unknown> } = {}): AgentConfig {
  return {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: {
      defaultProvider: "openai_compatible",
      maxToolRounds: 4,
      maxHistoryTokens: 8000,
      temperature: 0.3,
      extraInstructions: "",
    },
    agents: {
      planner: { tools: ["probe", "save", "notify_owner", "delegate", "room"] },
      reviewer: { tools: ["probe"] },
      researcher: { tools: ["probe", "recall"], online: { enabled: true } },
    },
    channels: { discord: { owner: "OWNER" } },
    rooms: { maxWakesPerHour: over.maxWakesPerHour ?? 12, ...over.rooms },
    tools: { notify_owner: { enabled: true } },
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
    workflows: { directory: join(home, "workflows") },
    tasks: { backend: "native" as const },
  } as unknown as AgentConfig;
}

function makeRuntime(config = makeConfig()): AgentRuntime {
  return new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: join(home, "context"),
      kbDir: join(home, "kb"),
      createTools: (c, dir, path, opts) => [...createTools(c, dir, path, opts), probe, save],
      createProvider: () => ({ provider, model: "x" }),
    },
    () => config,
    config,
  );
}

const upkeep: Wake = { kind: "upkeep", ref: "plan/trip" };
const wakeOf = (runtime: AgentRuntime, agent = "planner") =>
  runtime.wakeAgent(agent, { prompt: "Look after what you own.", sessionKey: `upkeep:${agent}`, wake: upkeep });

const events: EventWakeContext = {
  deliver: "immediate",
  events: [{ event: "state.changed", summary: "plan/trip updated by a person", at: new Date().toISOString() }],
  wake: { kind: "subscription", ref: "planner|state.changed||immediate|session||" },
};

beforeEach(() => {
  db = initDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "tai-wake-agent-"));
  queue = [];
  requests = 0;
  hold = undefined;
  probed = [];
  probedBy = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("runtime.wakeAgent", () => {
  it("runs the turn in the session it names, tells its tools why, and says so on the bus", async () => {
    const runtime = makeRuntime();
    const woken: Array<RuntimeEventPayload<"agent.woken">> = [];
    runtime.events.on("agent.woken", (e) => {
      woken.push(e);
    });
    queue = [[{ name: "probe", arguments: {} }]];

    expect(await wakeOf(runtime)).toBe("ran");

    expect(probed).toEqual([upkeep]);
    expect(woken).toEqual([{ agent: "planner", wake: upkeep, targetKind: "session", target: "upkeep:planner" }]);
    const row = db.prepare("SELECT key FROM sessions WHERE key = ?").get("upkeep:planner");
    expect(row).toBeDefined();
  });

  it("shares one hourly ceiling per agent between a plugin's wakes and subscription wakes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T09:00:00Z"));
    const runtime = makeRuntime(makeConfig({ maxWakesPerHour: 2 }));
    const delivery = createSubscriptionDelivery({ runtime, getRoomWatcher: () => undefined });

    expect(await wakeOf(runtime)).toBe("ran");
    expect(await delivery.toSession("planner", events)).toBe("ran");
    // Two wakes from two sources is the agent's two for the hour.
    expect(await wakeOf(runtime)).toBe("at-ceiling");
    expect(await delivery.toSession("planner", events)).toBe("at-ceiling");
    // The count is per agent.
    expect(await wakeOf(runtime, "reviewer")).toBe("ran");

    vi.setSystemTime(new Date("2026-10-21T10:00:01Z"));
    expect(await wakeOf(runtime)).toBe("ran");
    // Four turns ran, one request each: nothing ran for a refused wake.
    expect(requests).toBe(4);
  });

  it("turns away a second wake into a session whose turn is still running, and spends none of the hour on it", async () => {
    const runtime = makeRuntime(makeConfig({ maxWakesPerHour: 2 }));
    let release = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = wakeOf(runtime);
    await vi.waitFor(() => expect(requests).toBe(1));

    expect(await wakeOf(runtime)).toBe("at-ceiling");
    // Another session is another turn, and the hour still has room for it.
    expect(
      await runtime.wakeAgent("planner", {
        prompt: "A watch fired.",
        sessionKey: "watch:planner",
        wake: { kind: "watch" },
      }),
    ).toBe("ran");

    release();
    expect(await first).toBe("ran");
  });

  it("runs nothing while autonomous turns are paused, and spends none of the hour on it", async () => {
    const runtime = makeRuntime(makeConfig({ maxWakesPerHour: 1 }));
    const delivery = createSubscriptionDelivery({ runtime, getRoomWatcher: () => undefined });
    runtime.setAgentsPaused({ paused: true });

    expect(await wakeOf(runtime)).toBe("paused");
    // The dispatcher retries what it is told is temporary, so a subscription holds its events.
    expect(await delivery.toSession("planner", events)).toBe("at-ceiling");
    expect(requests).toBe(0);

    runtime.setAgentsPaused({ paused: false });
    expect(await wakeOf(runtime)).toBe("ran");
  });

  it("is gone for an agent that isn't there", async () => {
    const runtime = makeRuntime();
    expect(await wakeOf(runtime, "nobody")).toBe("gone");
    expect(requests).toBe(0);
  });

  it("is paused, not gone, for an online agent switched off or paused on its own", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T09:00:00Z"));
    const runtime = makeRuntime();

    // Both are a person's switch on the Agents page, and both can be undone,
    // so a caller holds the wake rather than throwing it away.
    updateExploratoryState(db, "researcher", { enabled: false });
    expect(await wakeOf(runtime, "researcher")).toBe("paused");
    updateExploratoryState(db, "researcher", { enabled: true, paused_until: "2026-10-21T13:00:00Z" });
    expect(await wakeOf(runtime, "researcher")).toBe("paused");
    expect(requests).toBe(0);

    vi.setSystemTime(new Date("2026-10-21T13:00:01Z"));
    expect(await wakeOf(runtime, "researcher")).toBe("ran");
  });

  it("wakes the base agent as default when none is declared", async () => {
    const runtime = makeRuntime();
    expect(await wakeOf(runtime, "default")).toBe("ran");
  });

  it("sends a room turn to the room waker the host sets, after the same checks", async () => {
    const runtime = makeRuntime();
    const turn = { prompt: "Summarise the week.", room: "eng", wake: { kind: "lead" } };

    // Rooms not running yet: temporary.
    expect(await runtime.wakeAgent("planner", turn)).toBe("at-ceiling");

    const roomWaker = vi.fn().mockResolvedValue("ran");
    runtime.setRoomWaker(roomWaker);
    expect(await runtime.wakeAgent("planner", turn)).toBe("ran");
    expect(roomWaker).toHaveBeenCalledWith("planner", "eng", { prompt: "Summarise the week.", wake: { kind: "lead" } });

    expect(await runtime.wakeAgent("nobody", turn)).toBe("gone");
    runtime.setAgentsPaused({ paused: true });
    expect(await runtime.wakeAgent("planner", turn)).toBe("paused");
    expect(roomWaker).toHaveBeenCalledTimes(1);
  });

  it("warns once when a room wake arrives before the host has set a room waker", async () => {
    const runtime = makeRuntime();
    const warn = vi.mocked(console.warn);
    const turn = { prompt: "Summarise the week.", room: "eng", wake: { kind: "lead" } };

    expect(await runtime.wakeAgent("planner", turn)).toBe("at-ceiling");
    expect(await runtime.wakeAgent("planner", turn)).toBe("at-ceiling");

    const said = warn.mock.calls.filter((c) => String(c[0]).includes("setRoomWaker"));
    expect(said).toHaveLength(1);
  });

  it("is gone for a room turn while rooms are switched off", async () => {
    const runtime = makeRuntime(makeConfig({ rooms: { enabled: false } }));
    expect(await runtime.wakeAgent("planner", { prompt: "x", room: "eng", wake: { kind: "lead" } })).toBe("gone");
  });

  it("refuses a wake with neither a session nor a room", async () => {
    const runtime = makeRuntime();
    await expect(
      runtime.wakeAgent("planner", { prompt: "x", wake: upkeep } as unknown as Parameters<
        AgentRuntime["wakeAgent"]
      >[1]),
    ).rejects.toThrow(/sessionKey or a room/);
  });
});

describe("work a woken turn hands on", () => {
  it("stays woken in an agent it delegates to", async () => {
    const runtime = makeRuntime();
    runtime.setMetaTools(createMetaTools(runtime, join(home, "context"), join(home, "kb")));
    // planner delegates, then reviewer's turn calls probe.
    queue = [
      [{ name: "delegate", arguments: { agent: "reviewer", task: "Check the plan." } }],
      [{ name: "probe", arguments: {} }],
    ];

    expect(await wakeOf(runtime)).toBe("ran");

    expect(probedBy).toEqual(["reviewer"]);
    expect(probed).toEqual([upkeep]);
  });

  it("stays woken in an agent it messages", async () => {
    const runtime = makeRuntime();
    queue = [
      [{ name: "room", arguments: { action: "dm", agent: "reviewer", body: "Check the plan." } }],
      [{ name: "probe", arguments: {} }],
    ];

    expect(await wakeOf(runtime)).toBe("ran");

    expect(probedBy).toEqual(["reviewer"]);
    expect(probed).toEqual([upkeep]);
  });

  it("stays unwoken in an agent messaged from a person's own chat", async () => {
    const runtime = makeRuntime();
    queue = [
      [{ name: "room", arguments: { action: "dm", agent: "reviewer", body: "Check the plan." } }],
      [{ name: "probe", arguments: {} }],
    ];

    const session = runtime.findOrCreateSession({ key: "web:owner" });
    await runAgentLoop("ask reviewer", runtime.buildLoopOptions({ session, agentName: "planner" }));

    expect(probedBy).toEqual(["reviewer"]);
    expect(probed).toEqual([undefined]);
  });
});

describe("agent.pre_tool_use", () => {
  it("carries the call's effect, whether the tool declared one, and why the turn runs", async () => {
    const runtime = makeRuntime();
    const seen: Array<Pick<PreToolUseWaterfall, "tool" | "effect" | "effectDeclared" | "wake">> = [];
    runtime.events.onWaterfall("agent.pre_tool_use", (p, next) => {
      seen.push({ tool: p.tool, effect: p.effect, effectDeclared: p.effectDeclared, wake: p.wake });
      return next(p);
    });
    queue = [
      [
        { name: "probe", arguments: {} },
        { name: "save", arguments: { text: "x" } },
      ],
    ];

    await wakeOf(runtime);

    expect(seen).toEqual([
      { tool: "probe", effect: "read", effectDeclared: false, wake: upkeep },
      { tool: "save", effect: "write", effectDeclared: true, wake: upkeep },
    ]);
  });

  it("carries no wake on a turn a person started", async () => {
    const runtime = makeRuntime();
    const seen: Array<PreToolUseWaterfall["wake"]> = [];
    runtime.events.onWaterfall("agent.pre_tool_use", (p, next) => {
      seen.push(p.wake);
      return next(p);
    });
    queue = [[{ name: "probe", arguments: {} }]];

    const session = runtime.findOrCreateSession({ key: "web:owner" });
    await runAgentLoop("hello", runtime.buildLoopOptions({ session, agentName: "planner" }));

    expect(seen).toEqual([undefined]);
    expect(probed).toEqual([undefined]);
  });
});

describe("notify_owner", () => {
  function withOutbound(runtime: AgentRuntime): string[] {
    const sent: string[] = [];
    runtime.registerOutbound({
      id: "discord",
      capabilities: { media: [] },
      send: async () => {},
      sendDM: async (_to: string, content: unknown) => {
        sent.push(String(content));
      },
    } as unknown as OutboundNotifier);
    return sent;
  }
  const notify = [{ name: "notify_owner", arguments: { message: "The nightly build is red." } }];

  it("holds back a repeat in a woken turn", async () => {
    const runtime = makeRuntime();
    const sent = withOutbound(runtime);

    queue = [notify];
    await wakeOf(runtime);
    queue = [notify];
    await wakeOf(runtime);

    expect(sent).toEqual(["The nightly build is red."]);
  });

  it("sends every time a person asks in their own chat", async () => {
    const runtime = makeRuntime();
    const sent = withOutbound(runtime);
    const session = runtime.findOrCreateSession({ key: "web:owner" });

    queue = [notify];
    await runAgentLoop("tell me again", runtime.buildLoopOptions({ session, agentName: "planner" }));
    queue = [notify];
    await runAgentLoop("and again", runtime.buildLoopOptions({ session, agentName: "planner" }));

    expect(sent).toEqual(["The nightly build is red.", "The nightly build is red."]);
  });
});
