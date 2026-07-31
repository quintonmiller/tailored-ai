import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopStop } from "../agent/loop.js";
import type { AgentConfig } from "../config.js";
import {
  ensureExploratoryState,
  getExploratoryRun,
  getExploratoryState,
  listExploratoryRuns,
  updateExploratoryState,
} from "../db/exploratory-queries.js";
import { createNote } from "../db/note-queries.js";
import { isAgentsPaused } from "../db/runtime-settings-queries.js";
import { initDatabase } from "../db/schema.js";
import { ExploratoryWorker } from "../exploratory/worker.js";
import type { AgentRuntime } from "../runtime.js";

/** The slice of AgentLoopOptions the stub loops in this file actually use. */
type LoopStubOpts = {
  onUsage?: (u: { input: number; output: number }) => void;
  onStop?: (s: LoopStop) => void;
  signal?: AbortSignal;
};

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
function mockRuntime(config: AgentConfig, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  const shutdownController = new AbortController();
  const base = {
    db,
    contextDir: "/tmp/exploratory-test-context",
    // Real table, not a stub: the tick's pause gate has to be exercisable.
    isAgentsPaused: (kind: "autonomous" | "human") => isAgentsPaused(db, kind),
    getConfig: () => config,
    getProvider: () => ({ id: "mock", chat: async () => ({}) }),
    getModel: () => "mock-model",
    getEmbedder: () => undefined,
    getMetaTools: () => [],
    get shutdownSignal() {
      return shutdownController.signal;
    },
    buildLoopOptions: () =>
      ({
        provider: { id: "mock", chat: async () => ({}) } as never,
        session: { id: "sess_mock", model: "mock-model", provider: "mock" } as never,
        db,
        tools: [],
        maxHistoryTokens: 2000,
        contextDir: "/tmp",
        kbDir: "/tmp",
        signal: shutdownController.signal,
      }) as never,
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
    // Stub didn't create any artifacts, so the run classifies as a no-op.
    expect(state.last_tick_status).toBe("noop");
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
    expect(skips.find((s) => s.agentName === "watcher")?.reason).toBe("agent-online-disabled");
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
  it("creates and completes an xrun row with status=ok when the agent writes a note", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn(async () => {
      createNote(db, { content: "found something useful", agent: "watcher" });
      return "looked at HN, found something useful";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("ok");
    expect(run.ended_at).not.toBeNull();
    expect(run.summary).toContain("looked at HN");
    expect(run.note_ids).toHaveLength(1);
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
    const stubLoop = vi.fn(
      async (_prompt: string, opts: { onUsage?: (u: { input: number; output: number }) => void }) => {
        opts.onUsage?.({ input: 300, output: 100 });
        return "ok";
      },
    );
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    const state = getExploratoryState(db, "watcher")!;
    expect(state.runs_today).toBe(1);
    expect(state.tokens_today).toBe(400);
  });

  /**
   * Stub that behaves like the REAL loop on abort: it RETURNS the sentinel
   * string and reports the reason through onStop. It does not throw.
   *
   * The previous version of this stub threw, which exercised a catch branch
   * production never reaches — so the suite stayed green while every
   * budget-capped tick in production was being recorded as a stall.
   */
  function abortingLoop(usage = { input: 400, output: 200 }) {
    return vi.fn(async (_prompt: string, opts: LoopStubOpts) => {
      opts.onUsage?.(usage);
      if (opts.signal?.aborted) {
        const reason = opts.signal.reason;
        opts.onStop?.({
          kind: "aborted",
          requestedByCaller: true,
          reason: typeof reason === "string" ? reason : undefined,
        });
        return "[Agent stopped: shutdown requested]";
      }
      opts.onStop?.({ kind: "complete" });
      return "ok";
    });
  }

  it("marks a per-tick token-cap abort as budget, not a stall", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: { enabled: true, budgets: { tokens_per_tick: 500 } },
        },
      },
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: abortingLoop() as never,
    });

    const run = await worker.runAgent("watcher", config.agents.watcher);

    expect(run.status).toBe("budget");
    expect(run.error ?? "").not.toMatch(/loop-stalled/);
  });

  it("writes no stall note when the abort was the budget cap we asked for", async () => {
    // The regression: 81 byte-identical notes accumulated in 10 days because
    // every capped tick was misread as the agent getting stuck.
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"], online: { enabled: true, budgets: { tokens_per_tick: 500 } } },
      },
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: abortingLoop() as never,
    });

    for (let i = 0; i < 3; i++) {
      updateExploratoryState(db, "watcher", { last_tick_at: null });
      await worker.runAgent("watcher", config.agents.watcher);
    }

    const stallNotes = db.prepare("SELECT COUNT(*) c FROM notes WHERE content LIKE 'Previous tick stalled%'").get() as {
      c: number;
    };
    expect(stallNotes.c).toBe(0);
  });

  it("collapses repeated genuine stalls into one counted note", async () => {
    const config = baseConfig({ agents: { watcher: { tools: ["recall"], online: { enabled: true } } } });
    const stallingLoop = vi.fn(async (_prompt: string, opts: LoopStubOpts) => {
      opts.onStop?.({ kind: "max-rounds", rounds: 10 });
      return "[Agent stopped: max tool rounds reached]";
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), runLoop: stallingLoop as never });

    for (let i = 0; i < 4; i++) {
      updateExploratoryState(db, "watcher", { last_tick_at: null });
      await worker.runAgent("watcher", config.agents.watcher);
    }

    const notes = db
      .prepare("SELECT content, importance, ttl_at FROM notes WHERE content LIKE 'Previous tick stalled%'")
      .all() as Array<{ content: string; importance: number | null; ttl_at: string | null }>;

    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("seen 4x");
    // Must sit BELOW the sweep keep-threshold (0.8) and carry a TTL, or this
    // self-feedback outlives the real memories it competes with in recall.
    expect(notes[0].importance).toBeLessThan(0.8);
    expect(notes[0].ttl_at).not.toBeNull();
  });

  it("records a runtime shutdown as a no-op rather than an agent failure", async () => {
    const config = baseConfig({ agents: { watcher: { tools: ["recall"], online: { enabled: true } } } });
    const shutdownLoop = vi.fn(async (_prompt: string, opts: LoopStubOpts) => {
      opts.onStop?.({ kind: "aborted", requestedByCaller: true, reason: "runtime:shutdown" });
      return "[Agent stopped: shutdown requested]";
    });
    const worker = new ExploratoryWorker({ runtime: mockRuntime(config), runLoop: shutdownLoop as never });

    const run = await worker.runAgent("watcher", config.agents.watcher);

    expect(run.status).toBe("noop");
    expect(run.error ?? "").not.toMatch(/loop-stalled/);
    const stallNotes = db.prepare("SELECT COUNT(*) c FROM notes WHERE content LIKE 'Previous tick stalled%'").get() as {
      c: number;
    };
    expect(stallNotes.c).toBe(0);
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
      tools: [{ name: "recall" }, { name: "web_search" }, { name: "exec" }],
      maxHistoryTokens: 2000,
      contextDir: "/tmp",
      kbDir: "/tmp",
      signal: new AbortController().signal,
      getTools: () => [{ name: "recall" }, { name: "web_search" }, { name: "exec" }],
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config, { buildLoopOptions: buildLoopOptions as never }),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    expect(observedTools.map((t) => t.name).sort()).toEqual(["recall", "web_search"]);
  });

  it("keeps meta tools even when online.tools allowlist excludes them", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall", "web_search"],
          online: { enabled: true, tools: ["recall"] },
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
      tools: [{ name: "recall" }, { name: "web_search" }, { name: "delegate" }, { name: "run_workflow" }],
      maxHistoryTokens: 2000,
      contextDir: "/tmp",
      kbDir: "/tmp",
      signal: new AbortController().signal,
      getTools: () => [{ name: "recall" }, { name: "web_search" }, { name: "delegate" }, { name: "run_workflow" }],
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config, {
        buildLoopOptions: buildLoopOptions as never,
        getMetaTools: () => [{ name: "delegate" }, { name: "run_workflow" }] as never,
      }),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    // recall: in allowlist. delegate/run_workflow: meta tools, kept implicitly.
    // web_search: not in allowlist and not meta — stripped.
    expect(observedTools.map((t) => t.name).sort()).toEqual(["delegate", "recall", "run_workflow"]);
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
    const stubLoop = vi.fn(async () => {
      createNote(db, { content: "activity", agent: "watcher" });
      return "ok";
    });
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

describe("ExploratoryWorker A4 — outputs + backoff", () => {
  it("classifies status=noop when no notes/facts/tasks are created", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn().mockResolvedValue("nothing to report");
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("noop");
    expect(run.note_ids).toHaveLength(0);
  });

  it("classifies status=ok and records note_ids when the agent writes notes", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn(async () => {
      createNote(db, { content: "found", agent: "watcher", tags: ["finding"] });
      createNote(db, { content: "also found", agent: "watcher" });
      return "found two things";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("ok");
    expect(run.note_ids).toHaveLength(2);
  });

  it("does not attribute another agent's notes to this run", async () => {
    const config = baseConfig({
      agents: {
        watcher: { tools: ["recall"], online: { enabled: true } },
        scout: { tools: ["recall"], online: { enabled: true } },
      },
    });
    const stubLoop = vi.fn(async () => {
      // Simulates a concurrent agent writing during the same window
      createNote(db, { content: "scout's note", agent: "scout" });
      return "watcher did nothing";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("noop");
    expect(run.note_ids).toHaveLength(0);
  });

  it("backs off the interval after a noop", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: {
            enabled: true,
            cadence: {
              interval_minutes: 10,
              idle_backoff_multiplier: 2.0,
              max_interval_minutes: 240,
            },
          },
        },
      },
    });
    const stubLoop = vi.fn().mockResolvedValue("nothing");
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    const state = getExploratoryState(db, "watcher")!;
    // base 10min = 600_000ms, *2 = 1_200_000ms
    expect(state.current_interval_ms).toBe(1_200_000);
  });

  it("compounds backoff across consecutive noops", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: {
            enabled: true,
            cadence: { interval_minutes: 10, idle_backoff_multiplier: 2.0 },
          },
        },
      },
    });
    const stubLoop = vi.fn().mockResolvedValue("nothing");
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    await worker.runAgent("watcher", config.agents.watcher);
    const state = getExploratoryState(db, "watcher")!;
    // 10min → 20min → 40min
    expect(state.current_interval_ms).toBe(2_400_000);
  });

  it("caps backoff at max_interval_minutes", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: {
            enabled: true,
            cadence: {
              interval_minutes: 60,
              idle_backoff_multiplier: 10.0, // pathologically aggressive
              max_interval_minutes: 120,
            },
          },
        },
      },
    });
    const stubLoop = vi.fn().mockResolvedValue("nothing");
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    const state = getExploratoryState(db, "watcher")!;
    expect(state.current_interval_ms).toBe(120 * 60_000); // capped
  });

  it("resets current_interval_ms back to base on ok", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: {
            enabled: true,
            cadence: { interval_minutes: 10, idle_backoff_multiplier: 2.0 },
          },
        },
      },
    });
    // Pre-seed a backed-off interval
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", { current_interval_ms: 30 * 60_000 });

    const stubLoop = vi.fn(async () => {
      createNote(db, { content: "found", agent: "watcher" });
      return "ok";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    await worker.runAgent("watcher", config.agents.watcher);
    const state = getExploratoryState(db, "watcher")!;
    expect(state.current_interval_ms).toBeNull();
  });

  it("leaves current_interval_ms unchanged on budget abort", async () => {
    const config = baseConfig({
      agents: {
        watcher: {
          tools: ["recall"],
          online: {
            enabled: true,
            cadence: { interval_minutes: 10 },
            budgets: { tokens_per_tick: 100 },
          },
        },
      },
    });
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", { current_interval_ms: 20 * 60_000 });

    const stubLoop = vi.fn(
      async (
        _prompt: string,
        opts: { onUsage?: (u: { input: number; output: number }) => void; signal?: AbortSignal },
      ) => {
        opts.onUsage?.({ input: 200, output: 100 });
        if (opts.signal?.aborted) throw new Error("aborted");
        return "ok";
      },
    );
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("budget");
    const state = getExploratoryState(db, "watcher")!;
    expect(state.current_interval_ms).toBe(20 * 60_000);
  });

  it("records fact and task creations in the xrun row", async () => {
    const config = baseConfig({
      agents: { watcher: { tools: ["recall"], online: { enabled: true } } },
    });
    const stubLoop = vi.fn(async () => {
      db.prepare("INSERT INTO facts (id, category, entity, key, value) VALUES (?, ?, ?, ?, ?)").run(
        "fact_test_1",
        "watcher",
        "",
        "k1",
        "v1",
      );
      db.prepare("INSERT INTO project_tasks (id, title, status) VALUES (?, ?, ?)").run(
        "ptask_test_xyz",
        "follow up",
        "backlog",
      );
      return "filed a fact and a task";
    });
    const worker = new ExploratoryWorker({
      runtime: mockRuntime(config),
      runLoop: stubLoop as never,
    });
    const run = await worker.runAgent("watcher", config.agents.watcher);
    expect(run.status).toBe("ok");
    expect(run.fact_ids).toContain("fact_test_1");
    expect(run.task_ids).toContain("ptask_test_xyz");
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
