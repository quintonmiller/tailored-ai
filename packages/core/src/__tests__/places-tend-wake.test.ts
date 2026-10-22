/**
 * A tend goes through `runtime.wakeAgent`, like every turn nobody asked for.
 *
 * Before, the places plugin started the turn's loop itself, so a tend never
 * counted toward the agent's hourly wake ceiling and its tools couldn't tell
 * it was a tend. These load the real plugin against a real runtime, the way
 * the CLI does, and let the clock bring the turn round.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { RuntimeEventPayload } from "../events.js";
import { createTools } from "../factories.js";
import { createPluginContext } from "../plugin-context.js";
import * as placesPlugin from "../plugins/places.js";
import { dbTime, nextTend, TEND_TICK_MS } from "../plugins/places-tend.js";
import { type LoadedPlugin, loadPlugins } from "../plugins.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool, ToolContext } from "../tools/interface.js";

const MINUTE = 60_000;

let db: Database.Database;
let home: string;
let plugins: LoadedPlugin[];
/** Tool calls the model makes, one batch per request; it answers once they run out. */
let queue: Array<Array<{ name: string; arguments: Record<string, unknown> }>>;
/** Every request's messages, joined. */
let asked: string[];
/** What each `probe` call saw. */
let probed: Array<ToolContext["wake"]>;
let logs: string[];

const provider: AIProvider = {
  id: "openai_compatible",
  name: "scripted",
  supportsTools: true,
  async chat(params): Promise<ChatResponse> {
    asked.push(params.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
    const calls = queue.shift();
    const usage = { input: 1, output: 1 };
    if (!calls) return { content: "done", usage, finishReason: "stop" };
    return {
      content: "",
      toolCalls: calls.map((c, i) => ({ id: `c${asked.length}-${i}`, ...c })),
      usage,
      finishReason: "tool_calls",
    };
  },
};

const probe: Tool = {
  name: "probe",
  description: "records why the turn runs",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    probed.push(context.wake);
    return { success: true, output: "ok" };
  },
};

function makeConfig(maxWakesPerHour: number): AgentConfig {
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
    agents: { planner: { tools: ["probe", "place"] } },
    live: { avatar: { model: "avatar.vrm" } },
    rooms: { maxWakesPerHour },
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
    workflows: { directory: join(home, "workflows") },
    tasks: { backend: "native" as const },
    state: { backend: "sqlite" },
    plugins: [{ module: "builtin:places", config: { tend: { every: "1h", agents: ["planner"] }, routines: "off" } }],
  } as unknown as AgentConfig;
}

async function start(maxWakesPerHour = 12): Promise<AgentRuntime> {
  const config = makeConfig(maxWakesPerHour);
  const runtime = new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: join(home, "context"),
      kbDir: join(home, "kb"),
      createTools: (c, dir, path, opts) => [...createTools(c, dir, path, opts), probe],
      createProvider: () => ({ provider, model: "x" }),
    },
    () => config,
    config,
  );
  plugins = await loadPlugins(config, async () => placesPlugin, {
    context: createPluginContext({ runtime, events: runtime.events }),
  });
  expect(plugins.map((p) => p.ok)).toEqual([true]);
  runtime.syncToolFactories();
  return runtime;
}

/** Something for the planner's room to show: a turn of its own, in its chat, that called a tool. */
async function busyDay(runtime: AgentRuntime) {
  queue = [[{ name: "probe", arguments: {} }]];
  const session = runtime.findOrCreateSession({ key: "web:planner" });
  await runAgentLoop("check the plan", runtime.buildLoopOptions({ session, agentName: "planner" }));
  // SQLite stamps rows by the real clock; the tend counts by the test's.
  const now = dbTime(Date.now());
  db.prepare("UPDATE token_usage SET created_at = ? WHERE session_id = ?").run(now, session.id);
  db.prepare("UPDATE messages SET created_at = ? WHERE session_id = ?").run(now, session.id);
  probed = [];
  asked = [];
}

/** Move the clock on to the planner's next tend, a tick at a time, as the tender's timer would. */
async function untilTend() {
  const due = nextTend("planner", 60 * MINUTE, Date.now());
  await vi.advanceTimersByTimeAsync(due - Date.now() + TEND_TICK_MS);
}

beforeEach(() => {
  db = initDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "tai-tend-wake-"));
  plugins = [];
  queue = [];
  asked = [];
  probed = [];
  logs = [];
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(async () => {
  for (const p of plugins) await p.stop?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a tend through the waker", () => {
  it("runs in the tend session, tells its tools it's a tend, says so on the bus, and counts toward the hour", async () => {
    const runtime = await start(2);
    const woken: Array<RuntimeEventPayload<"agent.woken">> = [];
    runtime.events.on("agent.woken", (e) => {
      woken.push(e);
    });
    await busyDay(runtime);
    queue = [[{ name: "probe", arguments: {} }]];

    await untilTend();
    await vi.waitFor(() => expect(probed).toHaveLength(1));

    const tend = { kind: "tend", ref: "place/home:planner" };
    expect(probed).toEqual([tend]);
    expect(woken).toEqual([{ agent: "planner", wake: tend, targetKind: "session", target: "tend:planner" }]);
    expect(asked[0]).toContain("Time to look at your room");
    expect(asked[0]).toContain("Nobody reads a reply here");
    // One of the planner's two wakes this hour went on the tend.
    const other = { prompt: "x", sessionKey: "watch:planner", wake: { kind: "watch" } };
    expect(await runtime.wakeAgent("planner", other)).toBe("ran");
    expect(await runtime.wakeAgent("planner", other)).toBe("at-ceiling");
  });

  it("is skipped at the agent's hourly ceiling, saying why, and tried again at its next time", async () => {
    const runtime = await start(1);
    await busyDay(runtime);
    // The planner's one wake for the hour goes on something else, just before its tend comes round.
    const due = nextTend("planner", 60 * MINUTE, Date.now());
    await vi.advanceTimersByTimeAsync(due - Date.now() - MINUTE);
    expect(
      await runtime.wakeAgent("planner", { prompt: "x", sessionKey: "watch:planner", wake: { kind: "watch" } }),
    ).toBe("ran");
    asked = [];
    probed = [];

    await vi.advanceTimersByTimeAsync(MINUTE + TEND_TICK_MS);
    expect(asked).toEqual([]);
    expect(logs).toContain("[places] planner's tend skipped: it's at its wake ceiling: 1 wake in the last hour");

    // Not saved up: nothing runs once the hour has room again, only at the planner's next time.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(asked).toEqual([]);
    await busyDay(runtime);
    queue = [[{ name: "probe", arguments: {} }]];
    await untilTend();
    await vi.waitFor(() => expect(probed).toEqual([{ kind: "tend", ref: "place/home:planner" }]));
  });

  it("wakes nobody while agents are paused, and spends none of the hour", async () => {
    const runtime = await start(1);
    await busyDay(runtime);
    runtime.setAgentsPaused({ paused: true });
    await untilTend();
    expect(asked).toEqual([]);
    expect(logs).toContain("[places] planner's tend skipped: agents are paused");
    runtime.setAgentsPaused({ paused: false });
    expect(
      await runtime.wakeAgent("planner", { prompt: "x", sessionKey: "watch:planner", wake: { kind: "watch" } }),
    ).toBe("ran");
  });
});
