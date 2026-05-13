import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { createNote } from "../db/note-queries.js";
import {
  ensureExploratoryState,
  getExploratoryRun,
  getExploratoryState,
  listExploratoryRuns,
  updateExploratoryState,
} from "../db/exploratory-queries.js";
import { initDatabase } from "../db/schema.js";
import { ExploratoryWorker } from "../exploratory/worker.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

/**
 * Minimal AgentRuntime stub. The worker only touches:
 *   - db
 *   - getConfig()
 *   - getProvider() / getModel() (for resetSession)
 *   - getEmbedder() (recall fallback)
 *   - shutdownSignal
 *   - buildLoopOptions() (for runAgent)
 *   - contextDir (for goals.md lookup)
 */
function mockRuntime(
  config: AgentConfig,
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  const shutdownController = new AbortController();
  const base = {
    db,
    contextDir: "/tmp/exploratory-test-context",
    getConfig: () => config,
    getProvider: () => ({ id: "mock", chat: async () => ({}) }),
    getModel: () => "mock-model",
    getEmbedder: () => undefined,
    get shutdownSignal() {
      return shutdownController.signal;
    },
    buildLoopOptions: () => ({
      provider: { id: "mock", chat: async () => ({}) } as never,
      session: { id: "sess_mock", model: "mock-model", provider: "mock" } as never,
      db,
      tools: [],
      maxHistoryTokens: 2000,
      contextDir: "/tmp",
      kbDir: "/tmp",
      signal: shutdownController.signal,
    } as never),
  } as unknown as AgentRuntime;
  return Object.assign(base, overrides);
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    server: { port: 3000, host: "0.0.0.0" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "m" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 2000,
      maxContextTokens: 32768,
      temperature: 0.3,
      maxToolRounds: 10,
    },
    agents: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    exploratory: { enabled: true },
    ...overrides,
  };
}

describe("ExploratoryWorker.evaluate", () => {
  it("skips agents without online.enabled", () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"] } },
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config) });
    const result = worker.evaluate("watcher", config.agents.watcher, new Date());
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.reason).toBe("agent-online-disabled");
  });

  it("runs an online agent that has never ticked", () => {
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"], online: { enabled: true } },
      },
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config) });
    const result = worker.evaluate("watcher", config.agents.watcher, new Date());
    expect(result.kind).toBe("run");
  });

  it("skips a paused agent", () => {
    const now = new Date("2026-05-13T12:00:00Z");
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"], online: { enabled: true } },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", {
      paused_until: "2026-05-13T13:00:00Z",
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), now: () => now });
    const result = worker.evaluate("watcher", config.agents.watcher, now);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.reason).toBe("paused");
  });

  it("resumes after paused_until has passed", () => {
    const now = new Date("2026-05-13T14:00:00Z");
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"], online: { enabled: true } },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", {
      paused_until: "2026-05-13T13:00:00Z",
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), now: () => now });
    const result = worker.evaluate("watcher", config.agents.watcher, now);
    expect(result.kind).toBe("run");
  });

  it("skips outside the configured time window", () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: {
            enabled: true,
            cadence: { window: { start: "09:00", end: "17:00" } },
          },
        },
      },
    });
    const outside = new Date();
    outside.setHours(20, 0, 0, 0); // 8pm local
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config) });
    const result = worker.evaluate("watcher", config.agents.watcher, outside);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.reason).toBe("outside-window");
  });

  it("fires inside the configured time window", () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: {
            enabled: true,
            cadence: { window: { start: "00:00", end: "23:59" } },
          },
        },
      },
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config) });
    const result = worker.evaluate("watcher", config.agents.watcher, new Date());
    expect(result.kind).toBe("run");
  });

  it("skips when runs-per-day cap is reached", () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: { enabled: true, budgets: { stop_after_runs_per_day: 3 } },
        },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", { runs_today: 3 });
    // Make sure maybeResetDailyCounters doesn't reset:
    const today = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;
    updateExploratoryState(db, "watcher", { tokens_today_resets_at: today });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config) });
    const result = worker.evaluate("watcher", config.agents.watcher, new Date());
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.reason).toBe("runs-cap-reached");
  });

  it("skips when the cadence interval has not elapsed", () => {
    const now = new Date("2026-05-13T12:30:00Z");
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: { enabled: true, cadence: { interval_minutes: 30 } },
        },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", {
      last_tick_at: "2026-05-13T12:20:00Z", // 10 minutes ago
      tokens_today_resets_at: (db.prepare("SELECT date('now') AS d").get() as { d: string }).d,
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), now: () => now });
    const result = worker.evaluate("watcher", config.agents.watcher, now);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.reason).toBe("cadence-not-elapsed");
  });

  it("runs once the cadence interval has elapsed", () => {
    const now = new Date("2026-05-13T13:00:00Z");
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: { enabled: true, cadence: { interval_minutes: 30 } },
        },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", {
      last_tick_at: "2026-05-13T12:20:00Z", // 40 minutes ago
      tokens_today_resets_at: (db.prepare("SELECT date('now') AS d").get() as { d: string }).d,
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), now: () => now });
    const result = worker.evaluate("watcher", config.agents.watcher, now);
    expect(result.kind).toBe("run");
  });

  it("honors current_interval_ms (backoff) over the configured base interval", () => {
    const now = new Date("2026-05-13T13:00:00Z");
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: { enabled: true, cadence: { interval_minutes: 5 } },
        },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", {
      last_tick_at: "2026-05-13T12:50:00Z", // 10 min ago
      current_interval_ms: 60 * 60_000, // backed off to 1h
      tokens_today_resets_at: (db.prepare("SELECT date('now') AS d").get() as { d: string }).d,
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), now: () => now });
    // 10 min < 60 min backoff → skip even though base would say "due"
    expect(worker.evaluate("watcher", config.agents.watcher, now).kind).toBe("skip");
  });
});

describe("ExploratoryWorker.tick", () => {
  it("is a no-op when exploratory.enabled is false", async () => {
    const config = baseConfig({
      exploratory: { enabled: false },
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const wouldRun = vi.fn();
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), onWouldRun: wouldRun });
    await worker.tick();
    expect(wouldRun).not.toHaveBeenCalled();
    expect(getExploratoryState(db, "watcher")).toBeNull();
  });

  it("emits would-run and stamps last_tick_at for due agents", async () => {
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"], online: { enabled: true } },
      },
    });
    const wouldRun = vi.fn();
    const stubLoop = vi.fn().mockResolvedValue("did a thing");
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      onWouldRun: wouldRun,
      runLoop: stubLoop as never,
    });
    await worker.tick();
    expect(wouldRun).toHaveBeenCalledWith({ agentName: "watcher", reason: "due" });
    const state = getExploratoryState(db, "watcher")!;
    expect(state.last_tick_at).not.toBeNull();
    expect(state.last_tick_status).toBe("ok");
    expect(state.runs_today).toBe(1);
  });

  it("calls onSkip with the correct reason for each disabled agent", async () => {
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"] }, // online not set
        scout: { tools: ["recall"], online: { enabled: true } },
      },
    });
    const skips: Array<{ agentName: string; reason: string }> = [];
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      onSkip: (info) => skips.push(info),
    });
    await worker.tick();
    expect(skips.find((s) => s.agentName === "watcher")?.reason).toBe(
      "agent-online-disabled",
    );
  });

  it("respects state.enabled = false even if config has online.enabled", async () => {
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"], online: { enabled: true } },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", { enabled: false });
    const wouldRun = vi.fn();
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), onWouldRun: wouldRun });
    await worker.tick();
    expect(wouldRun).not.toHaveBeenCalled();
  });
});

describe("ExploratoryWorker.runAgent", () => {
  it("creates and completes an xrun row with status=ok on success", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn().mockResolvedValue("looked at HN, nothing new");
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("ok");
    expect(run.ended_at).not.toBeNull();
    expect(run.summary).toContain("looked at HN");
    expect(getExploratoryRun(db, run.id)?.status).toBe("ok");
  });

  it("records status=error and the error message when the loop throws", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn().mockRejectedValue(new Error("boom"));
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("error");
    expect(run.error).toBe("boom");
  });

  it("increments runs_today and tokens_today after a run", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn(async (_prompt: string, opts: { onUsage?: (u: { input: number; output: number }) => void }) => {
      opts.onUsage?.({ input: 300, output: 100 });
      return "ok";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    const state = getExploratoryState(db, "watcher")!;
    expect(state.runs_today).toBe(1);
    expect(state.tokens_today).toBe(400);
  });

  it("aborts and marks status=budget when per-tick token cap is hit", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: { enabled: true, budgets: { tokens_per_tick: 500 } },
        },
      },
    });
    const stubLoop = vi.fn(async (_prompt: string, opts: { onUsage?: (u: { input: number; output: number }) => void; signal?: AbortSignal }) => {
      opts.onUsage?.({ input: 400, output: 200 }); // 600 > 500
      // simulate the model honoring the abort
      if (opts.signal?.aborted) throw new Error("aborted");
      return "ok";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("budget");
  });

  it("narrows tools to online.tools subset when provided", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall", "web_search", "exec"],
          online: { enabled: true, tools: ["recall", "web_search"] },
        },
      },
    });
    let observedTools: { name: string }[] = [];
    const stubLoop = vi.fn(async (_prompt: string, opts: { tools?: { name: string }[] }) => {
      observedTools = opts.tools ?? [];
      return "ok";
    });
    const buildLoopOptions = vi.fn().mockReturnValue({
      provider: {},
      session: { id: "s", model: "m", provider: "p" },
      db,
      tools: [
        { name: "recall" },
        { name: "web_search" },
        { name: "exec" },
      ],
      maxHistoryTokens: 2000,
      contextDir: "/tmp",
      kbDir: "/tmp",
      signal: new AbortController().signal,
      getTools: () => [
        { name: "recall" },
        { name: "web_search" },
        { name: "exec" },
      ],
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config, { buildLoopOptions: buildLoopOptions as never }),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    expect(observedTools.map((t) => t.name).sort()).toEqual(["recall", "web_search"]);
  });

  it("respects per-tick tool_calls cap by overriding maxToolRounds", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: { enabled: true, budgets: { tool_calls_per_tick: 3 } },
        },
      },
    });
    let observedMaxRounds: number | undefined;
    const stubLoop = vi.fn(async (_prompt: string, opts: { maxToolRounds?: number }) => {
      observedMaxRounds = opts.maxToolRounds;
      return "ok";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    expect(observedMaxRounds).toBe(3);
  });

  it("builds prompt with recent notes from the agent", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    createNote(db, { content: "saw a useful HN post", agent: "watcher" });
    createNote(db, { content: "unrelated", agent: "other" });
    let observedPrompt: string | undefined;
    const stubLoop = vi.fn(async (prompt: string) => {
      observedPrompt = prompt;
      return "ok";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    expect(observedPrompt).toContain("[Goals]");
    expect(observedPrompt).toContain("[Recent notes]");
    expect(observedPrompt).toContain("saw a useful HN post");
    expect(observedPrompt).not.toContain("unrelated");
  });

  it("creates an xrun row even if loop throws", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn().mockRejectedValue(new Error("kaboom"));
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    const runs = listExploratoryRuns(db, { agentName: "watcher" });
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("error");
  });

  it("calls onRunFinished after completing a run", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn().mockResolvedValue("ok");
    const onRunFinished = vi.fn();
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
      onRunFinished,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    expect(onRunFinished).toHaveBeenCalledTimes(1);
    expect(onRunFinished.mock.calls[0][0].status).toBe("ok");
  });

  it("sets and clears getActivity around a run", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    let duringRun: { agentName: string } | undefined;
    const stubLoop = vi.fn(async () => {
      duringRun = worker.getActivity();
      return "ok";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    expect(worker.getActivity()).toBeUndefined();
    await worker.runAgent("watcher", config.agents.watcher);
    expect(duringRun?.agentName).toBe("watcher");
    expect(worker.getActivity()).toBeUndefined();
  });
});

describe("ExploratoryWorker lifecycle", () => {
  it("start() is a no-op when exploratory.enabled is false", () => {
    const config = baseConfig({ exploratory: { enabled: false } });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config) });
    worker.start();
    // No timer registered — stopping should be safe
    expect(() => worker.stop()).not.toThrow();
  });

  it("start() and stop() are idempotent", () => {
    const config = baseConfig();
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), intervalMs: 60_000 });
    worker.start();
    worker.start(); // second call is a no-op
    worker.stop();
    worker.stop(); // also fine
  });
});
