/**
 * The global pause switch — `/pause` and `/resume` from Discord.
 *
 * The incident this exists for: two agents on a metered API answered each
 * other unattended and spent real money in twenty minutes, with no way to
 * stop it from a phone.
 *
 * The property under test is not "paused blocks things". It is the split:
 * **autonomous runs stop, the owner's own messages do not.** A pause that
 * also kills your DMs is indistinguishable from an outage, and it takes away
 * the tools you would use to work out what went wrong. Every gate below is
 * really a test of which side of that line a call site falls on, so the
 * "still works" cases matter as much as the "refuses" ones.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopilotWorker } from "../autopilot/worker.js";
import { handlePauseCommand, type PauseCommandDeps } from "../channels/discord-pause-commands.js";
import type { AgentConfig, CronJobConfig } from "../config.js";
import { CronScheduler } from "../cron/scheduler.js";
import {
  getRuntimeSettings,
  isAgentsPaused,
  pauseBlocks,
  type RuntimeSettings,
  setAgentsPaused,
} from "../db/runtime-settings-queries.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { ExploratoryWorker } from "../exploratory/worker.js";
import type { IdentityResolver } from "../rooms/identities.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { RoomStore, type RoomSubscription } from "../rooms/store.js";
import type { RoomMessage } from "../rooms/types.js";
import { RoomWatcher } from "../rooms/watcher.js";
import { AgentRuntime } from "../runtime.js";
import { TaskWatcher } from "../task-watcher.js";
import {
  PausedError,
  type StepContext,
  type StepExecutor,
  type StepResult,
  WorkflowEngine,
} from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { WorkflowStepDef } from "../workflows/types.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const pause = (scope: "autonomous" | "all" = "autonomous") =>
  setAgentsPaused(db, { paused: true, scope, by: "quinton" });
const resume = () => setAgentsPaused(db, { paused: false, by: "quinton" });

/**
 * Runtime double carrying only what the gates touch. `isAgentsPaused` is
 * wired to the real table rather than stubbed, so these tests exercise the
 * same read the production accessor makes.
 */
function makeRuntime(over: Record<string, unknown> = {}): AgentRuntime {
  return {
    db,
    events: new TypedEventBus(),
    contextDir: "/tmp/global-pause-test",
    isAgentsPaused: (kind: "autonomous" | "human") => isAgentsPaused(db, kind),
    getPauseState: () => getRuntimeSettings(db),
    getConfig: () => ({ agents: { coder: {}, reviewer: {} } }),
    getOwnerId: () => undefined,
    getTaskBackend: () => ({ name: "stub" }),
    ...over,
  } as unknown as AgentRuntime;
}

// ==========================================================================
// Storage + semantics
// ==========================================================================

describe("pause storage", () => {
  it("starts unpaused, with no scope and no attribution", () => {
    const s = getRuntimeSettings(db);
    expect(s.agents_paused).toBe(false);
    expect(s.pause_scope).toBeNull();
    expect(s.paused_at).toBeNull();
  });

  it("records who paused it and when, so 'why is nothing running' has an answer", () => {
    const s = pause("autonomous");
    expect(s.agents_paused).toBe(true);
    expect(s.pause_scope).toBe("autonomous");
    expect(s.paused_by).toBe("quinton");
    expect(s.paused_at).toBeTruthy();
  });

  it("clears scope and attribution on resume — stale 'paused by' next to paused=0 reads as still paused", () => {
    pause("all");
    const s = resume();
    expect(s.agents_paused).toBe(false);
    expect(s.pause_scope).toBeNull();
    expect(s.paused_by).toBeNull();
    expect(s.paused_at).toBeNull();
  });

  it("survives a restart: a fresh handle on the same file reads the pause back", () => {
    // The whole reason this is a table and not process state. `:memory:`
    // cannot be reopened, so this uses a real file and a second connection —
    // which is exactly what a service restart does.
    const path = `/tmp/tai-pause-restart-${process.pid}-${Date.now()}.db`;
    const first = initDatabase(path);
    setAgentsPaused(first, { paused: true, scope: "all", by: "quinton" });
    first.close();

    const second = initDatabase(path);
    const s = getRuntimeSettings(second);
    expect(s.agents_paused).toBe(true);
    expect(s.pause_scope).toBe("all");
    expect(isAgentsPaused(second, "human")).toBe(true);
    second.close();
  });

  it("is read live — a pause taken after a handle exists is visible immediately, with no reload", () => {
    const runtime = makeRuntime();
    expect(runtime.isAgentsPaused("autonomous")).toBe(false);
    pause();
    expect(runtime.isAgentsPaused("autonomous")).toBe(true);
    resume();
    expect(runtime.isAgentsPaused("autonomous")).toBe(false);
  });
});

describe("pause scope semantics", () => {
  const state = (paused: boolean, scope: "autonomous" | "all" | null): RuntimeSettings => ({
    agents_paused: paused,
    pause_scope: scope,
    paused_at: null,
    paused_by: null,
    updated_at: "",
  });

  it("blocks nothing while running", () => {
    expect(pauseBlocks(state(false, null), "autonomous")).toBe(false);
    expect(pauseBlocks(state(false, null), "human")).toBe(false);
  });

  it("default scope blocks autonomous and deliberately spares human", () => {
    expect(pauseBlocks(state(true, "autonomous"), "autonomous")).toBe(true);
    expect(pauseBlocks(state(true, "autonomous"), "human")).toBe(false);
  });

  it("scope 'all' blocks both", () => {
    expect(pauseBlocks(state(true, "all"), "autonomous")).toBe(true);
    expect(pauseBlocks(state(true, "all"), "human")).toBe(true);
  });
});

// ==========================================================================
// Workflow engine — the single fan-in for cron, webhooks and all 8 pollers
// ==========================================================================

class NoopExecutor implements StepExecutor {
  type = "shell" as const;
  calls = 0;
  async execute(_step: WorkflowStepDef, _ctx: StepContext): Promise<StepResult> {
    this.calls += 1;
    return { output: "ok" };
  }
}

describe("WorkflowEngine.runWorkflow — the gate discriminates by trigger", () => {
  let engine: WorkflowEngine;
  let executor: NoopExecutor;

  beforeEach(() => {
    const registry = new WorkflowRegistry();
    executor = new NoopExecutor();
    engine = new WorkflowEngine({ db, registry, executors: [executor] });
    registry.register({ name: "wf", steps: [{ name: "s", type: "shell", command: "echo" } as WorkflowStepDef] });
  });

  // cron / webhook / programmatic reach here from a clock, a third party, or a
  // poller. Gating this one method covers all eight trigger pollers.
  for (const trigger of ["cron", "webhook", "programmatic"] as const) {
    it(`refuses trigger '${trigger}' while paused`, async () => {
      pause();
      await expect(engine.runWorkflow("wf", {}, trigger)).rejects.toThrow(PausedError);
      expect(executor.calls).toBe(0);
    });
  }

  // 'http' is the UI's Run button; 'tool' is a step inside an agent already
  // running. Both trace back to a person.
  for (const trigger of ["http", "tool"] as const) {
    it(`still runs trigger '${trigger}' while paused under the default scope`, async () => {
      pause();
      const run = await engine.runWorkflow("wf", {}, trigger);
      expect(run.status).toBe("completed");
      expect(executor.calls).toBe(1);
    });

    it(`refuses trigger '${trigger}' under scope 'all'`, async () => {
      pause("all");
      await expect(engine.runWorkflow("wf", {}, trigger)).rejects.toThrow(PausedError);
      expect(executor.calls).toBe(0);
    });
  }

  it("does not write a run row for a refused run — a paused poller must not fill the table", async () => {
    pause();
    await expect(engine.runWorkflow("wf", {}, "cron")).rejects.toThrow(PausedError);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM workflow_runs").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("lets a child workflow through, so a pause cannot cut a running parent in half", async () => {
    // `continuation` is what `trigger_workflow` passes. The parent was gated
    // when it started; refusing its second half is the inconsistent state the
    // "in-flight runs finish" rule exists to avoid.
    pause();
    const run = await engine.runWorkflow("wf", {}, "programmatic", { continuation: true });
    expect(run.status).toBe("completed");
  });

  it("resume restores every trigger", async () => {
    pause("all");
    await expect(engine.runWorkflow("wf", {}, "cron")).rejects.toThrow(PausedError);
    resume();
    expect((await engine.runWorkflow("wf", {}, "cron")).status).toBe("completed");
    expect((await engine.runWorkflow("wf", {}, "http")).status).toBe("completed");
  });
});

// ==========================================================================
// Cron — the timer stops, "Run now" does not
// ==========================================================================

describe("CronScheduler", () => {
  const job: CronJobConfig = { name: "j", schedule: "* * * * *", prompt: "p" };

  function scheduler(): { sched: CronScheduler; runJob: ReturnType<typeof vi.fn> } {
    const runtime = makeRuntime({
      getConfig: () => ({ channels: {}, cron: { jobs: [job] }, agents: {} }),
    });
    const sched = new CronScheduler({ runtime });
    const runJob = vi.fn().mockResolvedValue(undefined);
    (sched as unknown as { runJob: unknown }).runJob = runJob;
    return { sched, runJob };
  }

  const fireTimer = (s: CronScheduler, j: CronJobConfig) =>
    (s as unknown as { runScheduled(j: CronJobConfig): void }).runScheduled(j);

  it("skips the scheduled firing while paused", () => {
    pause();
    const { sched, runJob } = scheduler();
    fireTimer(sched, job);
    expect(runJob).not.toHaveBeenCalled();
  });

  it("still honours 'Run now' while paused — the owner asking for one job is not what a pause is for", () => {
    pause();
    const { sched, runJob } = scheduler();
    sched.triggerJob("j");
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0][1]).toEqual({ solicited: true });
  });

  it("fires on the timer again after resume", () => {
    pause();
    const { sched, runJob } = scheduler();
    fireTimer(sched, job);
    resume();
    fireTimer(sched, job);
    expect(runJob).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// Autopilot
// ==========================================================================

describe("AutopilotWorker", () => {
  function worker(): { w: AutopilotWorker; watcher: { notify: ReturnType<typeof vi.fn> } } {
    const watcher = { notify: vi.fn() };
    const w = new AutopilotWorker({
      runtime: makeRuntime({ getConfig: () => ({ agents: { coder: {} } }) }),
      taskBackend: { name: "stub" } as never,
      getTaskWatcher: () => watcher as never,
    });
    return { w, watcher };
  }

  it("runTick stops at the global flag even though autopilot's own pause is off", async () => {
    pause();
    const { w } = worker();
    const nextBacklog = vi.fn();
    (w as unknown as { tasks: { nextBacklogTask: unknown } }).tasks.nextBacklogTask = nextBacklog;
    await w.tick();
    expect(nextBacklog).not.toHaveBeenCalled();
  });

  it("the stuck-task scanner stops re-dispatching while paused", async () => {
    // This path calls notify(..., {force: true}), which bypasses the
    // assignee gate — the one loop that re-fires the same agent forever.
    const stuck = createProjectTask(db, { title: "t", description: "", assignee: "coder", tags: [] });
    db.prepare("UPDATE project_tasks SET status = 'in_progress', updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(
      stuck.id,
    );

    const { w, watcher } = worker();
    pause();
    expect(await w.scanStuckTasks()).toEqual({ requeued: 0, skipped: 0 });
    expect(watcher.notify).not.toHaveBeenCalled();

    resume();
    const after = await w.scanStuckTasks();
    expect(after.requeued).toBe(1);
    expect(watcher.notify).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// Exploratory worker
// ==========================================================================

describe("ExploratoryWorker", () => {
  const config = {
    exploratory: { enabled: true, baseIntervalMs: 1000 },
    agents: { coder: { online: { enabled: true } } },
  } as unknown as AgentConfig;

  it("skips the tick while paused, naming the reason", async () => {
    pause();
    const skips: string[] = [];
    const w = new ExploratoryWorker({
      runtime: makeRuntime({ getConfig: () => config }),
      onSkip: (i) => skips.push(i.reason),
    });
    const runAgent = vi.fn();
    (w as unknown as { runAgent: unknown }).runAgent = runAgent;

    await w.tick();

    expect(runAgent).not.toHaveBeenCalled();
    expect(skips).toContain("paused");
  });

  it("leaves the manual-run path alone — that route is a person clicking 'run this one now'", async () => {
    pause();
    const w = new ExploratoryWorker({ runtime: makeRuntime({ getConfig: () => config }) });
    const runAgent = vi.fn().mockResolvedValue(undefined);
    (w as unknown as { runAgent: unknown }).runAgent = runAgent;

    // The HTTP route calls runAgent directly, bypassing tick().
    await (w as unknown as { runAgent(n: string, d: unknown): Promise<void> }).runAgent("coder", {});
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("ticks again after resume", async () => {
    pause();
    const w = new ExploratoryWorker({ runtime: makeRuntime({ getConfig: () => config }) });
    const runAgent = vi.fn().mockResolvedValue(undefined);
    (w as unknown as { runAgent: unknown }).runAgent = runAgent;

    await w.tick();
    expect(runAgent).not.toHaveBeenCalled();

    resume();
    await w.tick();
    expect(runAgent).toHaveBeenCalled();
  });
});

// ==========================================================================
// Task watcher — StallGuard retries and the tasks tool
// ==========================================================================

describe("TaskWatcher", () => {
  const watcherConfig = () => ({
    agents: { coder: { description: "" }, reviewer: { description: "" } },
    channels: {},
    taskWatcher: { enabled: true, delivery: { channel: "log" }, triggers: ["created", "updated"], debounceMs: 0 },
  });

  function watcher(): { tw: TaskWatcher; runtime: AgentRuntime; notify: ReturnType<typeof vi.fn> } {
    const runtime = makeRuntime({ getConfig: watcherConfig });
    const tw = new TaskWatcher({ runtime });
    const notify = vi.fn();
    (tw as unknown as { notify: unknown }).notify = notify;
    return { tw, runtime, notify };
  }

  it("drops a StallGuard retry (task.dispatch_requested) while paused", () => {
    const task = createProjectTask(db, { title: "t", description: "", assignee: "coder", tags: [] });
    const { runtime, notify } = watcher();

    pause();
    runtime.events.emit("task.dispatch_requested", { taskId: task.id, reason: "stall" });
    expect(notify).not.toHaveBeenCalled();

    resume();
    runtime.events.emit("task.dispatch_requested", { taskId: task.id, reason: "stall" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("stops the tasks tool handing work to another agent while paused", () => {
    // notifyById's only caller is the tasks tool — an agent that just filed or
    // reassigned work. The task row is still written; only the dispatch stops.
    const task = createProjectTask(db, { title: "t", description: "", assignee: "coder", tags: [] });
    const { tw, notify } = watcher();

    pause();
    tw.notifyById("created", task.id);
    expect(notify).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS c FROM project_tasks").get()).toEqual({ c: 1 });

    resume();
    tw.notifyById("created", task.id);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// Rooms — the shape of the incident itself
// ==========================================================================

describe("RoomWatcher", () => {
  const ROOM = "local:eng";

  function roomRuntime(): AgentRuntime {
    return makeRuntime({
      getConfig: () => ({
        agents: { supervisor: {}, coder: {} },
        rooms: { identities: { quinton: { human: { local: "u-1" } } } },
      }),
    });
  }

  /**
   * A watcher over a real subscription row. The row matters: the wake budget
   * is consumed with a conditional UPDATE, so a hand-built subscription object
   * with no row behind it silently fails to wake and every assertion below
   * would pass for the wrong reason.
   *
   * `runTurn` / `runPrompted` are stubbed because the question here is only
   * whether the gate let the run start, not what the model then said.
   */
  async function makeWatcher(
    messages: RoomMessage[],
    subOver: { checkInMinutes?: number; deliver?: "push" | "poll" } = {},
  ): Promise<{
    w: RoomWatcher;
    sub: RoomSubscription;
    runTurn: ReturnType<typeof vi.fn>;
    runPrompted: ReturnType<typeof vi.fn>;
  }> {
    const store = new RoomStore(db);
    // A real room row: `runCheckIn` bails when the ref resolves to nothing,
    // which would make the check-in assertions pass for the wrong reason.
    await new LocalRoomBackend(db, store).createRoom({ name: "eng" });
    const sub = store.subscribe({
      agent: "coder",
      roomRef: ROOM,
      wakeOn: "all",
      deliver: subOver.deliver ?? "push",
      checkInMinutes: subOver.checkInMinutes ?? null,
    });
    const w = new RoomWatcher({ runtime: roomRuntime(), store });
    const runTurn = vi.fn().mockResolvedValue(undefined);
    const runPrompted = vi.fn().mockResolvedValue(undefined);
    const internals = w as unknown as {
      runTurn: unknown;
      runPrompted: unknown;
      fetchBacklog: unknown;
      identities(): IdentityResolver;
    };
    internals.runTurn = runTurn;
    internals.runPrompted = runPrompted;
    internals.fetchBacklog = async () => messages;
    return { w, sub, runTurn, runPrompted };
  }

  function message(over: Partial<RoomMessage> = {}): RoomMessage {
    return {
      id: "1",
      room: { backend: "local", id: "eng" },
      cursor: "0000000000000001",
      raw: "hi",
      body: "hi",
      to: [],
      mentions: [],
      authorId: "author",
      authorLabel: "author",
      fromSelf: false,
      createdAt: "2026-07-27 12:00:00",
      ...over,
    };
  }

  const runWake = (w: RoomWatcher, sub: RoomSubscription) =>
    (w as unknown as { runWake(s: RoomSubscription): Promise<void> }).runWake(sub);

  it("refuses a wake caused only by other agents — the $4 loop", async () => {
    pause();
    const { w, sub, runTurn } = await makeWatcher([message({ speaker: "supervisor", body: "thoughts?" })]);
    await runWake(w, sub);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("still wakes for a human speaking in the room, under the default scope", async () => {
    // The load-bearing case. If a person asking a question in a room goes
    // unanswered, the deployment reads as broken rather than paused.
    pause();
    const { w, sub, runTurn } = await makeWatcher([message({ speaker: "quinton", body: "status?" })]);
    await runWake(w, sub);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("wakes when a human is anywhere in the batch, even alongside agent chatter", async () => {
    pause();
    const { w, sub, runTurn } = await makeWatcher([
      message({ id: "1", speaker: "supervisor", body: "chatter" }),
      message({ id: "2", speaker: "quinton", body: "actually, stop" }),
    ]);
    await runWake(w, sub);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("scope 'all' silences the human wake too", async () => {
    pause("all");
    const { w, sub, runTurn } = await makeWatcher([message({ speaker: "quinton", body: "status?" })]);
    await runWake(w, sub);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("blocks the poll path on agent-only traffic", async () => {
    pause();
    const { w, runTurn } = await makeWatcher([message({ speaker: "supervisor", body: "chatter" })], {
      deliver: "poll",
    });
    await w.pollOnce("coder", ROOM);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("lets the poll path through for a human — gating the timer would silence humans too", async () => {
    pause();
    const { w, runTurn } = await makeWatcher([message({ speaker: "quinton", body: "status?" })], { deliver: "poll" });
    await w.pollOnce("coder", ROOM);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("stops scheduled check-ins outright — a clock fired and nobody asked anything", async () => {
    pause();
    const { w, runPrompted } = await makeWatcher([], { checkInMinutes: 60 });
    await w.runCheckIn("coder", ROOM);
    expect(runPrompted).not.toHaveBeenCalled();
  });

  it("runs the check-in again after resume", async () => {
    const { w, runPrompted } = await makeWatcher([], { checkInMinutes: 60 });
    pause();
    await w.runCheckIn("coder", ROOM);
    expect(runPrompted).not.toHaveBeenCalled();

    resume();
    await w.runCheckIn("coder", ROOM);
    expect(runPrompted).toHaveBeenCalledTimes(1);
  });

  it("resume restores agent-to-agent wakes", async () => {
    pause();
    const { w, sub, runTurn } = await makeWatcher([message({ speaker: "supervisor", body: "thoughts?" })]);
    await runWake(w, sub);
    expect(runTurn).not.toHaveBeenCalled();

    resume();
    await runWake(w, sub);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});

// ==========================================================================
// Agent-to-agent direct messages
// ==========================================================================

describe("AgentRuntime.deliverAgentMessage", () => {
  const call = (rt: unknown) =>
    AgentRuntime.prototype.deliverAgentMessage.call(rt as AgentRuntime, "coder", "sup", "hi");

  it("refuses while paused, and says how to lift it", async () => {
    pause();
    await expect(call(makeRuntime())).rejects.toThrow(/paused/i);
  });

  it("gets past the gate once resumed", async () => {
    // Not asserting a full run — only that the pause is no longer what stops
    // it. The next failure is the unknown-agent check, which is the proof.
    resume();
    await expect(call(makeRuntime({ getConfig: () => ({ agents: {} }) }))).rejects.toThrow(/No agent named/);
  });
});

// ==========================================================================
// The Discord surface
// ==========================================================================

describe("/pause and /resume", () => {
  function deps(): PauseCommandDeps {
    return {
      getPauseState: () => getRuntimeSettings(db),
      setAgentsPaused: (opts) => setAgentsPaused(db, opts),
    };
  }

  function interaction(commandName: string, scope?: string) {
    const replies: string[] = [];
    const i = {
      commandName,
      user: { id: "1", username: "quinton" },
      deferred: false,
      replied: false,
      options: { getString: (n: string) => (n === "scope" ? (scope ?? null) : null) },
      reply: vi.fn(async (a: { content: string }) => {
        i.replied = true;
        replies.push(a.content);
      }),
      followUp: vi.fn(async (a: { content: string }) => replies.push(a.content)),
    };
    return { i, replies };
  }

  // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
  const run = (i: unknown) => handlePauseCommand(i as any, deps());

  it("ignores commands that are not its own", async () => {
    const { i } = interaction("memory");
    expect(await run(i)).toBe(false);
  });

  it("defaults to the autonomous scope", async () => {
    const { i } = interaction("pause");
    await run(i);
    expect(getRuntimeSettings(db).pause_scope).toBe("autonomous");
  });

  it("takes scope: all when asked", async () => {
    const { i } = interaction("pause", "all");
    await run(i);
    expect(getRuntimeSettings(db).pause_scope).toBe("all");
  });

  it("says what stopped, what still works, and that in-flight runs finish", async () => {
    // Someone reading this on a phone must not have to guess whether their own
    // messages still reach agents. That is the entire job of this reply.
    const { i, replies } = interaction("pause");
    await run(i);
    expect(replies[0]).toMatch(/Blocked:/);
    expect(replies[0]).toMatch(/Still works:/);
    expect(replies[0]).toMatch(/In-flight runs finish/i);
    expect(replies[0]).toMatch(/\/resume/);
  });

  it("warns under scope: all that your own messages stop too", async () => {
    const { i, replies } = interaction("pause", "all");
    await run(i);
    expect(replies[0]).toMatch(/your own messages/i);
    expect(replies[0]).toMatch(/In-flight runs finish/i);
  });

  it("reports the current state instead of erroring when already paused", async () => {
    await run(interaction("pause").i);
    const { i, replies } = interaction("pause");
    await run(i);
    expect(replies[0]).toMatch(/Already paused/);
    expect(getRuntimeSettings(db).agents_paused).toBe(true);
  });

  it("widens the scope when re-run with a different one, and says so", async () => {
    await run(interaction("pause").i);
    const { i, replies } = interaction("pause", "all");
    await run(i);
    expect(replies[0]).toMatch(/Scope changed/);
    expect(getRuntimeSettings(db).pause_scope).toBe("all");
  });

  it("resume lifts it and says when it started", async () => {
    await run(interaction("pause").i);
    const { i, replies } = interaction("resume");
    await run(i);
    expect(getRuntimeSettings(db).agents_paused).toBe(false);
    expect(replies[0]).toMatch(/resumed/i);
  });

  it("resume on a running deployment says so rather than pretending it did something", async () => {
    const { i, replies } = interaction("resume");
    await run(i);
    expect(replies[0]).toMatch(/were not paused/i);
  });
});

describe("pause events", () => {
  function runtimeWithBus(): AgentRuntime {
    const events = new TypedEventBus();
    const rt = { db, events } as unknown as AgentRuntime;
    rt.isAgentsPaused = AgentRuntime.prototype.isAgentsPaused.bind(rt);
    rt.getPauseState = AgentRuntime.prototype.getPauseState.bind(rt);
    rt.setAgentsPaused = AgentRuntime.prototype.setAgentsPaused.bind(rt);
    return rt;
  }

  it("announces a real change on the runtime bus", () => {
    const rt = runtimeWithBus();
    const seen: Array<{ paused: boolean; scope: string | null }> = [];
    rt.events.on("agents.pause_changed", (e) => seen.push({ paused: e.paused, scope: e.scope }));

    rt.setAgentsPaused({ paused: true, scope: "autonomous", by: "quinton" });
    rt.setAgentsPaused({ paused: false, by: "quinton" });

    expect(seen).toEqual([
      { paused: true, scope: "autonomous" },
      { paused: false, scope: null },
    ]);
  });

  it("stays quiet when nothing actually changed — subscribers should see decisions, not keystrokes", () => {
    const rt = runtimeWithBus();
    rt.setAgentsPaused({ paused: true, scope: "autonomous" });
    const seen = vi.fn();
    rt.events.on("agents.pause_changed", seen);
    rt.setAgentsPaused({ paused: true, scope: "autonomous" });
    expect(seen).not.toHaveBeenCalled();
  });
});
