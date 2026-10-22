/**
 * A wake an agent booked in a session goes through `runtime.wakeAgent`.
 *
 * Before, the runner started the loop itself, so these turns never counted
 * toward the agent's hourly wake ceiling, took no notice of an online agent's
 * own switch, and their tools couldn't tell why they ran. These run a real
 * runtime, so what they check is what a booked wake gets.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { updateExploratoryState } from "../db/exploratory-queries.js";
import { initDatabase } from "../db/schema.js";
import type { RuntimeEventPayload } from "../events.js";
import { createTools } from "../factories.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import { ScheduleRunner } from "../schedules/runner.js";
import { fromDbTime, type NewSchedule, ScheduleStore } from "../schedules/store.js";
import type { Tool, ToolContext } from "../tools/interface.js";

const MINUTE = 60_000;
const START = new Date("2026-10-21T09:00:00Z");

let db: Database.Database;
let home: string;
let store: ScheduleStore;
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
    const usage = { input: 0, output: 0 };
    // Each turn calls probe once, then answers.
    const last = params.messages.at(-1);
    if (last?.role === "tool") return { content: "done", usage, finishReason: "stop" };
    return {
      content: "",
      toolCalls: [{ id: `c${asked.length}`, name: "probe", arguments: {} }],
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

function makeRuntime(maxWakesPerHour = 12): AgentRuntime {
  const config = {
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
      planner: { tools: ["probe", "schedule"] },
      researcher: { tools: ["probe", "schedule"], online: { enabled: true } },
    },
    rooms: { maxWakesPerHour },
    schedules: { enabled: true, tickSeconds: 30, maxDeferrals: 3 },
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
    workflows: { directory: join(home, "workflows") },
    tasks: { backend: "native" as const },
  } as unknown as AgentConfig;
  return new AgentRuntime(
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
}

function runnerFor(runtime: AgentRuntime): ScheduleRunner {
  return new ScheduleRunner({ runtime, now: () => new Date() });
}

/** A wake the agent booked in `session`, due now. */
function booked(agent: string, session: string, more: Partial<NewSchedule> = {}) {
  return store.create({
    agent,
    note: "check the deploy",
    kind: "once",
    source: "in 10 minutes",
    nextRunAt: new Date(),
    targetKind: "session",
    target: session,
    createdAt: new Date(Date.now() - 10 * MINUTE),
    ...more,
  });
}

const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

beforeEach(() => {
  db = initDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "tai-schedule-wake-"));
  store = new ScheduleStore(db);
  asked = [];
  probed = [];
  logs = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a wake booked in a session", () => {
  it("runs in that session through the waker: its tools see a schedule, the bus hears it, and it counts toward the hour", async () => {
    const runtime = makeRuntime(1);
    const woken: Array<RuntimeEventPayload<"agent.woken">> = [];
    runtime.events.on("agent.woken", (e) => {
      woken.push(e);
    });
    const fired: Array<RuntimeEventPayload<"schedule.fired">> = [];
    runtime.events.on("schedule.fired", (e) => {
      fired.push(e);
    });
    const session = runtime.findOrCreateSession({ key: "web:planner" });
    const row = booked("planner", session.id);

    await runnerFor(runtime).tick();

    const schedule = { kind: "schedule", ref: row.id };
    expect(probed).toEqual([schedule]);
    expect(woken).toEqual([{ agent: "planner", wake: schedule, targetKind: "session", target: "web:planner" }]);
    expect(asked[0]).toContain('Your note to yourself: "check the deploy"');
    expect(asked[0]).toContain("a reply here goes nowhere on its own");
    const user = db.prepare("SELECT session_id FROM messages WHERE role = 'user'").get() as { session_id: string };
    expect(user.session_id).toBe(session.id);
    expect(store.get(row.id)).toMatchObject({ status: "done", run_count: 1 });
    expect(fired.map((e) => e.id)).toEqual([row.id]);
    // It was the planner's one wake for the hour.
    expect(
      await runtime.wakeAgent("planner", { prompt: "x", sessionKey: "watch:planner", wake: { kind: "watch" } }),
    ).toBe("at-ceiling");
  });

  it("is deferred at the agent's hourly ceiling, as a room's is, and runs once the hour has room", async () => {
    const runtime = makeRuntime(1);
    const runner = runnerFor(runtime);
    const session = runtime.findOrCreateSession({ key: "web:planner" });
    expect(
      await runtime.wakeAgent("planner", { prompt: "x", sessionKey: "watch:planner", wake: { kind: "watch" } }),
    ).toBe("ran");
    asked = [];
    probed = [];
    const row = booked("planner", session.id);

    await runner.tick();
    expect(asked).toEqual([]);
    const deferred = store.get(row.id);
    expect(deferred).toMatchObject({ status: "pending", deferrals: 1, run_count: 0 });
    expect(fromDbTime(deferred?.next_run_at ?? "").getTime()).toBe(Date.now() + 5 * MINUTE);

    // Within the hour the next try is deferred again; past it, the wake runs.
    later(5 * MINUTE);
    await runner.tick();
    expect(store.get(row.id)).toMatchObject({ status: "pending", deferrals: 2 });
    later(56 * MINUTE);
    await runner.tick();
    expect(probed).toEqual([{ kind: "schedule", ref: row.id }]);
    expect(store.get(row.id)).toMatchObject({ status: "done", run_count: 1, deferrals: 0 });
  });

  it("waits while its online agent is switched off on its own, as for a pause, and still says how late it is", async () => {
    const runtime = makeRuntime();
    const runner = runnerFor(runtime);
    const session = runtime.findOrCreateSession({ key: "web:researcher" });
    updateExploratoryState(db, "researcher", { enabled: false });
    const row = booked("researcher", session.id);
    const due = store.get(row.id)?.next_run_at;
    const asks = vi.spyOn(runtime, "wakeAgent");

    await runner.tick();
    expect(asked).toEqual([]);
    expect(asks).toHaveBeenCalledTimes(1);
    // Back in the due set, as it was, without counting toward the retries that give up on a ceiling.
    expect(store.get(row.id)).toMatchObject({ status: "pending", deferrals: 0, run_count: 0, next_run_at: due });
    // Looked at again every few minutes, not every tick, and said once.
    later(MINUTE);
    await runner.tick();
    expect(asks).toHaveBeenCalledTimes(1);
    later(5 * MINUTE);
    await runner.tick();
    expect(asks).toHaveBeenCalledTimes(2);
    expect(asked).toEqual([]);
    expect(logs.filter((l) => l.includes(`${row.id} (researcher) held`))).toHaveLength(1);

    // Hours later, switched back on: it runs at its next look, and knows it is late.
    later(3 * 60 * MINUTE);
    updateExploratoryState(db, "researcher", { enabled: true });
    await runner.tick();
    expect(probed).toEqual([{ kind: "schedule", ref: row.id }]);
    expect(asked[0]).toContain("This fired 3h 6m late.");
    expect(store.get(row.id)).toMatchObject({ status: "done", run_count: 1 });
  });

  it("skips a recurring occurrence while its online agent is switched off, as a pause does", async () => {
    const runtime = makeRuntime();
    const session = runtime.findOrCreateSession({ key: "web:researcher" });
    updateExploratoryState(db, "researcher", { enabled: false });
    const row = booked("researcher", session.id, { kind: "repeat", intervalSeconds: 3600, source: "every hour" });

    await runnerFor(runtime).tick();
    expect(asked).toEqual([]);
    const after = store.get(row.id);
    expect(after).toMatchObject({ status: "pending", deferrals: 0, run_count: 0 });
    expect(fromDbTime(after?.next_run_at ?? "").getTime()).toBe(START.getTime() + 60 * MINUTE);
  });

  it("is retired once the session it was booked in is gone", async () => {
    const runtime = makeRuntime();
    const row = booked("planner", "no-such-session");
    await runnerFor(runtime).tick();
    expect(asked).toEqual([]);
    expect(store.get(row.id)?.status).toBe("expired");
  });
});
