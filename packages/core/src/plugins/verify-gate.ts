/**
 * Verification gate — closes the "marked done without proof" hole in the
 * autonomous loop. Subscribes to `task.transitioned` and, when a task moves
 * to the backend's `done` status WITHOUT a recorded verification verdict,
 * bounces it back to the review stage instead of letting it close.
 *
 * The contract is a convention, not a schema: the reviewing agent runs the
 * task's acceptance check (the `## Acceptance` / `verify:` lines the task
 * creator wrote) and posts a comment whose latest verdict is `VERIFY: PASS`
 * (or `VERIFY: FAIL`). This plugin only lets `done` stand when the most recent
 * verdict is PASS — so an implementer (or the autopilot finalizer) that jumps
 * straight to `done` gets routed to the reviewer to actually test the change.
 *
 * Scope: by default every `→ done` transition is gated. Set `requireTags` to
 * gate only tagged work (e.g. `["kind:code", "kind:config"]`) so pure
 * assistant/PA tasks ("escalate X", "log Y") still self-close. After
 * `maxBounces` rounds it stops bouncing and escalates to a human via
 * `task.needs_human`, so a task can never loop forever.
 *
 * Like the other built-in guards (`scope-creep-flagger`, `coder-project-guard`)
 * this is a replaceable opinion: disable the plugin and ship your own gate to
 * change the policy. It hardcodes no agent name — the reviewer assignee, the
 * verdict markers, and the gated tags all come from config.
 */

import { addTaskComment, getProjectTask, updateProjectTask } from "../db/task-queries.js";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";

/** Author for gate-authored bookkeeping comments — also the bounce counter key. */
const GATE_AUTHOR = "verify-gate";

export interface VerifyGateOptions {
  runtime: AgentRuntime;
  /** Where to route an unverified `done`. Default `"reviewer"`. */
  reviewerAssignee?: string;
  /**
   * Per-tag override of the bounce target, checked before `reviewerAssignee`.
   * Lets a config/live-surface task route to a non-worktree verifier and a
   * code task to the worktree reviewer:
   *   { "kind:config": "verifier", "kind:code": "reviewer" }
   * First matching tag (in insertion order) wins.
   */
  reviewerByTag?: Record<string, string>;
  /** Status to route the bounce into. Default `"in_review"`. */
  reviewStatus?: string;
  /** The terminal status to gate. Default: the task backend's `done` status. */
  doneStatus?: string;
  /** Verdict marker that lets `done` stand. Default `"VERIFY: PASS"`. */
  passMarker?: string;
  /** Verdict marker that means verification ran and failed. Default `"VERIFY: FAIL"`. */
  failMarker?: string;
  /**
   * Only gate tasks bearing one of these tags. When omitted, every transition
   * to `done` is gated. Set to e.g. `["kind:code", "kind:config"]` so PA tasks
   * self-close.
   */
  requireTags?: string[];
  /** Stop bouncing and escalate to a human after this many rounds. Default 2. */
  maxBounces?: number;
}

export class VerifyGate {
  private runtime: AgentRuntime;
  private reviewerAssignee: string;
  private reviewerByTag?: Record<string, string>;
  private reviewStatus: string;
  private doneStatus?: string;
  private passMarker: string;
  private failMarker: string;
  private requireTags?: string[];
  private maxBounces: number;
  private subscription: Subscription;

  constructor(opts: VerifyGateOptions) {
    this.runtime = opts.runtime;
    this.reviewerAssignee = opts.reviewerAssignee ?? "reviewer";
    this.reviewerByTag = opts.reviewerByTag;
    this.reviewStatus = opts.reviewStatus ?? "in_review";
    this.doneStatus = opts.doneStatus;
    this.passMarker = opts.passMarker ?? "VERIFY: PASS";
    this.failMarker = opts.failMarker ?? "VERIFY: FAIL";
    this.requireTags = opts.requireTags;
    this.maxBounces = opts.maxBounces ?? 2;
    this.subscription = this.runtime.events.on("task.transitioned", (e) => this.handle(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  private doneStatusName(): string {
    return this.doneStatus ?? this.runtime.getTaskBackend().statuses.done;
  }

  /** The agent to bounce to — a per-tag override (config vs code) else the default. */
  private bounceTargetFor(tags: string[]): string {
    if (this.reviewerByTag) {
      for (const [tag, who] of Object.entries(this.reviewerByTag)) {
        if (tags.includes(tag)) return who;
      }
    }
    return this.reviewerAssignee;
  }

  private async handle(e: RuntimeEventPayload<"task.transitioned">): Promise<void> {
    if (e.to !== this.doneStatusName()) return;

    const task = getProjectTask(this.runtime.db, e.taskId);
    if (!task) return;

    // Scope: only gate tagged work when requireTags is set.
    if (this.requireTags?.length) {
      const tags = task.tags ?? [];
      if (!this.requireTags.some((t) => tags.includes(t))) return;
    }

    // Already verified? The most recent verdict must be PASS.
    if (this.latestVerdict(task.comments) === "pass") return;

    const logPrefix = `[verify-gate] [${e.taskId}]`;
    const bounces = this.countBounces(task.comments);
    const target = this.bounceTargetFor(task.tags ?? []);

    if (bounces >= this.maxBounces) {
      // Stop bouncing — hand it to a human rather than loop.
      addTaskComment(this.runtime.db, e.taskId, {
        author: GATE_AUTHOR,
        content:
          `VERIFY GATE: still no \`${this.passMarker}\` after ${bounces} round(s). ` +
          "Leaving for human review — the acceptance check (## Acceptance / verify:) " +
          "needs to be run and recorded, or the task needs decomposition.",
      });
      this.runtime.events.emit("task.needs_human", {
        taskId: e.taskId,
        agentName: target,
        reason: "verify",
        message: `Task ${e.taskId} reached done ${bounces}× without a recorded verification. Needs a human to verify or decompose.`,
      });
      console.warn(`${logPrefix} max bounces reached — escalated to human`);
      return;
    }

    // Bounce back to the review stage so the change actually gets tested.
    updateProjectTask(this.runtime.db, e.taskId, {
      status: this.reviewStatus,
      assignee: target,
    });
    addTaskComment(this.runtime.db, e.taskId, {
      author: GATE_AUTHOR,
      content: [
        `VERIFY GATE: closed without a recorded \`${this.passMarker}\`.`,
        `Routed to ${target} to run the acceptance check before this can close.`,
        "Run the task's `## Acceptance` steps / `verify:` command against the running",
        `change, then post \`${this.passMarker}\` (with evidence) and re-close, or`,
        `\`${this.failMarker}\` and bounce to the implementer with the failure.`,
      ].join("\n"),
    });
    // Ask the watcher to re-route now (it reads the task's current assignee).
    this.runtime.events.emit("task.dispatch_requested", {
      taskId: e.taskId,
      projectId: e.projectId,
      reason: `verify-gate: unverified done → ${target}`,
    });
    console.log(`${logPrefix} unverified done bounced to ${target} (round ${bounces + 1})`);
  }

  /**
   * "pass" | "fail" | null — the most recent VERIFY verdict among comments.
   * The gate's own bookkeeping comments quote the markers, so they're skipped:
   * only a reviewer-authored verdict counts.
   */
  private latestVerdict(comments: Array<{ author?: string; content: string }> | undefined): "pass" | "fail" | null {
    if (!comments) return null;
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (!c || c.author === GATE_AUTHOR) continue;
      if (c.content.includes(this.passMarker)) return "pass";
      if (c.content.includes(this.failMarker)) return "fail";
    }
    return null;
  }

  private countBounces(comments: Array<{ author?: string; content: string }> | undefined): number {
    if (!comments) return 0;
    return comments.filter((c) => c.author === GATE_AUTHOR && c.content.includes("VERIFY GATE:")).length;
  }
}

/**
 * Default-plugin entry point — loaded via `config.plugins: builtin:verify-gate`.
 * Reads optional `reviewerAssignee`, `reviewStatus`, `doneStatus`, `passMarker`,
 * `failMarker`, `requireTags: string[]`, `maxBounces` from `ctx.config`.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const cfg = ctx.config;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const tags =
    Array.isArray(cfg.requireTags) && cfg.requireTags.every((x) => typeof x === "string")
      ? (cfg.requireTags as string[])
      : undefined;
  const byTagRaw = cfg.reviewerByTag;
  const reviewerByTag =
    byTagRaw && typeof byTagRaw === "object" && !Array.isArray(byTagRaw)
      ? (Object.fromEntries(
          Object.entries(byTagRaw as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>)
      : undefined;
  const gate = new VerifyGate({
    runtime: ctx.runtime,
    reviewerAssignee: str(cfg.reviewerAssignee),
    reviewerByTag,
    reviewStatus: str(cfg.reviewStatus),
    doneStatus: str(cfg.doneStatus),
    passMarker: str(cfg.passMarker),
    failMarker: str(cfg.failMarker),
    requireTags: tags,
    maxBounces: typeof cfg.maxBounces === "number" ? cfg.maxBounces : undefined,
  });
  return () => gate.stop();
};

export const meta: PluginMeta = {
  name: "Verify gate",
  description:
    "Bounces tasks that reach `done` without a recorded `VERIFY: PASS` back to the reviewer (subscribes to task.transitioned).",
  registers: [{ kind: "eventSubscriber", id: "verify-gate" }],
};

export default plugin;
