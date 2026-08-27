/**
 * Typed event bus on the runtime — the foundation slice of the platform
 * vision (`docs/platform-vision.md`). The runtime emits structured events
 * when things happen (a task is created, an agent loop finishes, a
 * worktree commit lands); plugins and other internal subsystems subscribe
 * to whichever events they care about.
 *
 * This file ships the bus. It does NOT yet emit any events from inside
 * core — slice 2 wires task lifecycle emissions through the existing
 * tasks tool / task backend layer. The bus alone lets plugin authors
 * start writing handlers against a stable surface; their handlers will
 * begin firing as each slice lights up emission.
 *
 * ## Design choices
 *
 * - **Typed event map.** `RuntimeEventMap` declares each known event
 *   name and its payload shape. Subscribing or emitting an unknown event
 *   is a type error, not a runtime surprise. New events are added by
 *   extending the map in this file — keeping the catalog discoverable.
 *
 * - **Subscriptions return a disposer.** `bus.on(event, handler)` returns
 *   a `{ dispose() }` handle so callers don't have to retain the handler
 *   identity to call `off()`. Mirrors VS Code's API; works well with
 *   composition.
 *
 * - **`emit` is synchronous; handlers may be async.** Emitters never
 *   await — that's a "fire and forget." Handlers can return a promise,
 *   and the bus will swallow rejections to a `console.error` so one
 *   broken plugin can't poison the dispatch chain. Causality-sensitive
 *   ordering (e.g. "create the worktree before dispatching the agent")
 *   is a slice 3 concern — for now, handlers race.
 *
 * - **Errors are isolated per subscriber.** A throwing handler doesn't
 *   prevent later handlers from running, and doesn't propagate up to the
 *   emitter. The runtime keeps going.
 *
 * - **`clear()` for reload.** When the runtime reloads (config flip,
 *   plugin reload), the bus is cleared. Internal subscribers re-arm in
 *   the new runtime setup; plugins re-register on import. Persistent
 *   subscriptions across reloads are out of scope for the first cut.
 */

import type { ContextSlot, ContextSlotContext, RenderedSlot } from "./agent/context-slots.js";
import type { LoopStop } from "./agent/loop.js";
import type { ChatParams } from "./providers/interface.js";
import type { WakeReason } from "./rooms/watcher.js";

/**
 * The catalog of events the runtime emits and their payload shapes.
 * Extend this interface (here or via module augmentation in a plugin) to
 * declare new events. Subscribing to a name not in this map is a
 * compile-time error.
 *
 * Slice 1 ships the bus with no emissions yet — the entries below are
 * placeholders that document the eventual shape so plugin authors can
 * see what's coming. Slice 2 wires emissions through the tasks tool and
 * starts populating these with real data.
 */
export interface RuntimeEventMap {
  /**
   * A task was created in any backend. `projectId` is the routing key
   * that selected the backend (undefined → default backend).
   *
   * Will be emitted by slice 2 from the tasks tool's `create` path.
   */
  "task.created": {
    taskId: string;
    projectId?: string;
  };

  /**
   * A task was updated. `changes` lists the field names that changed.
   * Status changes also emit the more specific `task.transitioned`.
   *
   * Will be emitted by slice 2.
   */
  "task.updated": {
    taskId: string;
    projectId?: string;
    changes: string[];
  };

  /**
   * A task's status transitioned. Distinct from `task.updated` so
   * subscribers interested only in state changes don't have to filter.
   *
   * Will be emitted by slice 2.
   */
  "task.transitioned": {
    taskId: string;
    projectId?: string;
    from: string;
    to: string;
    assignee?: string | null;
  };

  /**
   * A comment was added to a task.
   *
   * Will be emitted by slice 2.
   */
  "task.commented": {
    taskId: string;
    projectId?: string;
    author?: string;
  };

  /**
   * A message landed in a room, before any wake decision is made. This is the
   * seam for behavior core deliberately does not implement: routing rules,
   * custom escalation, mirroring a room somewhere else. Subscribers see every
   * message, including ones no agent wakes on.
   */
  "room.message": {
    /** Canonical `<backend>:<id>`. */
    roomRef: string;
    messageId: string;
    /** TAI identity that spoke, when one was resolved. */
    speaker?: string;
    /** TAI identities addressed. Empty means the room at large. */
    to: string[];
    /** Envelope-stripped text. */
    body: string;
    fromSelf: boolean;
  };

  /**
   * A room message caused an agent to wake. Emitted after the wake budget is
   * consumed, so a subscriber counting these sees real runs, not intents.
   */
  "room.woke": {
    roomRef: string;
    agent: string;
    /** How many messages the agent was handed. */
    messageCount: number;
  };

  /**
   * A room turn finished, and why. The counterpart to `room.woke`: that one
   * says a turn started, this one says how it ended.
   *
   * `stop` comes from the loop rather than from the reply, which is the only
   * way to tell a stall from an answer. A turn that runs out of rounds gets one
   * tools-withheld call so it can say what happened, so a stalled turn usually
   * returns ordinary prose — measured on a 237-run benchmark cohort, all 12
   * stalls came back as prose and none carried an `[Agent stopped: …]` marker.
   * Anything matching that string is matching nothing.
   *
   * Rooms are where this matters most and shows least: nobody reads a room
   * turn's raw output, it is posted or suppressed, and a recovered stall reads
   * in the room as an ordinary message. This is the seam for noticing — core
   * emits, and what to *do* about a stalled agent (retry it, mark it, say so in
   * the room) stays a plugin's opinion, the way `agent.stalled` leaves it to
   * StallGuard.
   *
   * Emitted for every turn, including one that ended by throwing, so a
   * subscriber counting turns is not quietly missing the ones that went wrong.
   */
  "room.turn_ended": {
    /** Every room the turn covered. More than one for a batched turn. */
    rooms: string[];
    agent: string;
    /** Why the agent was woken, when the path that woke it recorded a reason. */
    reason?: WakeReason;
    /** Why the loop ended. Absent only when the turn threw before it returned. */
    stop?: LoopStop;
    /** Short reason when the turn stalled, null otherwise — `stallReasonOf(stop)`. */
    stallReason: string | null;
    /** Whether anything reached a room, by either route: a reply, or a `room` tool post. */
    posted: boolean;
    /** Set when the turn ended by throwing, in which case nothing was posted. */
    error?: string;
  };

  /**
   * An agent's seat in a room was taken or given up.
   *
   * Membership was previously a thing you could only discover by asking:
   * `/room members` told you, and nothing else did. An agent that created a
   * room stayed subscribed to it and went on receiving everything said there
   * long afterwards, because being in a room and looking like you are in a
   * room were different facts. This is the event that lets them be the same
   * one — the built-in `builtin:room-announcer` plugin subscribes and says so
   * in the room itself.
   *
   * Emitted only for changes that actually happened: a re-subscribe that
   * changes nothing is not a join, and unsubscribing an agent that was not
   * there is not a leave. `source` says where the change came from — `config`
   * rows are re-applied on every reconcile, so a subscriber that treats them
   * as news will be wrong on every boot.
   */
  "room.membership_changed": {
    /** Canonical `<backend>:<id>`. */
    roomRef: string;
    agent: string;
    change: "joined" | "left";
    source: "config" | "agent";
  };

  /**
   * A room was retired, or brought back.
   *
   * Distinct from `room.membership_changed` on purpose: nobody joined and
   * nobody left. Every seat in the room keeps its cursor, its role and its
   * check-in cadence, and simply stops being armed — which is what makes the
   * change reversible, and what makes "left" the wrong word for it.
   *
   * The watcher listens so archiving takes effect without a restart, exactly
   * as a membership change already does. `builtin:room-announcer` listens so
   * the room is told before it goes quiet: one agent archiving a shared room
   * silences everyone else in it, and that should not be something the others
   * discover by never being woken again.
   */
  "room.archived": {
    /** Canonical `<backend>:<id>`. */
    roomRef: string;
    name: string;
    /** TAI identity that archived it, when one was known. */
    by?: string;
    reason?: string;
  };

  "room.unarchived": {
    roomRef: string;
    name: string;
    by?: string;
  };

  /**
   * An agent booked itself a future wake through the `schedule` tool.
   *
   * Emitted on creation rather than only on firing so a subscriber can see what
   * an agent intends before it happens — a schedule booked for 3am is worth
   * knowing about at 3pm, not at 3am.
   */
  /**
   * A session's history was replaced by a summary of it.
   *
   * The originals are hidden rather than deleted, so `batch` is enough for a
   * subscriber to archive them, show what was folded away, or undo it. Emitted
   * after the summary is written, so a provider failure produces no event and
   * leaves the session untouched.
   */
  "session.compacted": {
    sessionId: string;
    /** Which compaction this was in this session, counting from 1. */
    batch: number;
    /** How many messages were hidden. */
    messages: number;
    beforeTokens: number;
    afterTokens: number;
    /** Durable facts saved as notes before the history was hidden. */
    notesWritten: number;
  };

  "schedule.created": {
    id: string;
    agent: string;
    kind: "once" | "repeat";
    /** The phrase the agent used, not the compiled form. */
    source: string;
    note: string;
    /** UTC, as stored. */
    nextRunAt: string;
    targetKind: "room" | "session";
    target: string;
  };

  /**
   * A scheduled wake ran. Emitted after the turn, and only when one actually
   * happened: a wake the room refused for being at its ceiling is deferred, not
   * fired, and a subscriber counting these counts turns rather than attempts.
   */
  "schedule.fired": {
    id: string;
    agent: string;
    kind: "once" | "repeat";
    note: string;
    targetKind: "room" | "session";
    target: string;
  };

  "schedule.cancelled": {
    agent: string;
    /** Empty when `all` is set — the ids are not enumerated for a bulk cancel. */
    ids: string[];
    all: boolean;
    count: number;
  };

  /**
   * One agent sent another a direct message and got an answer back.
   *
   * Everything an agent does in a room leaves a transcript somebody can read.
   * A direct message left a session row and nothing else — no event, so no
   * plugin could mirror, audit, count or escalate one without patching core.
   * A pair of agents could talk all night and the only evidence was a row you
   * had to already suspect existed to go looking for.
   *
   * Emitted once per exchange, **after** the recipient's loop returns, so one
   * event carries the message and its reply together. Emitting on entry and
   * again on return would hand every subscriber two half-facts to correlate,
   * and the unit anyone wants is the exchange. A delivery that throws emits
   * nothing, so counting these counts exchanges that happened rather than
   * attempts that were made.
   *
   * `via` separates the two callers of the same delivery path: `dm` is an
   * agent choosing to speak to another, `delegate` is the machinery handing a
   * finished task back. A mirror that cannot tell them apart either drowns in
   * delegation traffic or misses it.
   */
  "agent.messaged": {
    from: string;
    to: string;
    body: string;
    reply: string;
    /** Which surface produced it — `"dm"`, `"delegate"`, or a plugin's own. */
    via: string;
  };

  /**
   * The runtime finished a config reload. Subscribers re-arming
   * themselves after a reload can use this rather than wiring into
   * the existing `onReload` hook directly.
   */
  "runtime.reloaded": {
    generation: number;
  };

  /**
   * The global pause switch was flipped. Emitted only on a real change — a
   * `/pause` while already paused reports the current state and says nothing
   * here, so a subscriber counting these sees decisions, not keystrokes.
   *
   * The seam exists so a deployment can react to being paused without core
   * knowing how: post to a status channel, flip a dashboard tile, page
   * someone if it stays paused for an hour. Core's own gates read the
   * database directly and do not depend on this event arriving.
   */
  "agents.pause_changed": {
    paused: boolean;
    /** `null` on resume; otherwise the scope now in force. */
    scope: "autonomous" | "all" | null;
    /** Who asked, when the surface knows. */
    by?: string;
    /** When the change landed (SQLite `datetime('now')`). */
    at: string;
  };

  /**
   * An agent loop finished running for a task. Carries the initial task
   * (as the watcher saw it when routing), the final task state (which
   * may differ — the agent may have transitioned status / re-assigned
   * mid-loop), the agent's freeform response, and the routing context.
   *
   * Slice 3 of the platform vision (`docs/platform-vision.md`): default
   * plugins (agent notifier, stall guard, scope-creep flagger)
   * subscribe to this event instead of being baked into the watcher.
   */
  "agent.completed": {
    taskId: string;
    projectId?: string;
    /**
     * Name of the agent that ran the loop. May be undefined when the
     * watcher routed to the default agent without a profile.
     */
    agentName: string | undefined;
    /** The watcher event that triggered this run (created/updated/commented). */
    action: "created" | "updated" | "commented";
    /** Task snapshot when routing started. */
    task: AgentCompletedTask;
    /**
     * Task snapshot after the agent loop returned and any post-loop
     * mutations (stall comment, scope-warning comment) landed. Same
     * shape as `task`; will be identical when the agent didn't mutate.
     */
    finalTask: AgentCompletedTask;
    /** The agent's freeform response. May be empty. */
    response: string;
    /**
     * Worktree context, present when the loop ran inside an isolated
     * per-task worktree (coder / reviewer dispatches). Used by the
     * scope-creep flagger to inspect branch commits and by future
     * worktree-cleanup plugins.
     *
     * `repoPath` is the parent repo (always reachable on disk).
     * `worktreePath` is the per-task worktree directory — it may
     * have been torn down by the time the event reaches you; rely on
     * `repoPath` + `branch` for git operations that need to survive
     * cleanup. `preservedPath` is set when the worktree was kept
     * (uncommitted changes); null when it was cleaned up.
     */
    worktree?: AgentCompletedWorktree;
  };

  /**
   * An agent loop ran out of rounds or looped on identical calls — see
   * `isStallStop`. Read off the loop's `onStop`, not off its reply: a turn
   * that runs out of rounds gets one tools-withheld call so the person is
   * told what happened, so a stalled dispatch usually returns ordinary prose.
   * The watcher emits this INSTEAD of `agent.completed` when it spots a stall, so the
   * default StallGuard plugin (`packages/core/src/plugins/stall-guard.ts`)
   * can decide whether to retry or transition to blocked.
   *
   * Payload shape mirrors `agent.completed`, plus `stallReason`. If you
   * also want to react to stalls in your own plugin (e.g. for
   * observability), subscribe here. The AgentNotifier doesn't —
   * StallGuard will re-emit `agent.completed` for the terminal blocked
   * state once retries are exhausted.
   */
  "agent.stalled": {
    taskId: string;
    projectId?: string;
    agentName: string | undefined;
    action: "created" | "updated" | "commented";
    task: AgentCompletedTask;
    finalTask: AgentCompletedTask;
    response: string;
    /** Short reason for the stall, from `stallReasonOf(stop)`. */
    stallReason: string;
    worktree?: AgentCompletedWorktree;
  };

  /**
   * A request was handed to a provider — the exact one, after the fallback
   * rung was chosen and after media shaping, and after it was sent.
   *
   * Emitted once per wire request, so a round that fell back emits one record
   * per rung it actually called. `attempt` and `answered` tell them apart; a
   * rung the capability check skipped never made a request and emits nothing.
   *
   * **A faithful copy, not a projection.** Rebuilding this later from session
   * state would be cheaper and would be wrong: `paramsFor` re-trims history per
   * rung, so which messages went out depends on which rung answered, and a
   * reconstruction would confidently produce the head rung's request instead.
   * Authoritative and wrong is worse than absent.
   *
   * Broadcast, deliberately. A subscriber that could rewrite this would make
   * the record a lie — and it fires after the request was sent, so there is
   * nothing left to change anyway. `params` is the live object for that reason:
   * read it, do not mutate it.
   *
   * Core emits and stores nothing. Retention, redaction, format and location
   * are opinions, and they belong to a subscriber.
   */
  "agent.request_assembled": RequestAssembled;

  /**
   * A tool call ran. The counterpart to `agent.pre_tool_use`: that one says a
   * call is about to happen and can stop it, this one says one did.
   *
   * Only calls that actually executed are reported. A refusal — from a
   * subscriber, the skill allowlist, validation, the approval gate or the
   * derivability check — returns before this, which is what lets a subscriber
   * count executions rather than intentions. The same distinction `calls_by`
   * makes in the benchmark, and for the same reason.
   *
   * `args` is what the tool was actually given, so a rewrite by a
   * `agent.pre_tool_use` subscriber is visible here rather than the original.
   */
  "agent.post_tool_use": ToolUsed;

  /**
   * A human is being asked to approve a tool call.
   *
   * The approval path used to run start to finish without the bus hearing
   * anything, so a deployment could not log its own approvals, notice an agent
   * hitting the same one repeatedly, or see that it had been blocked on one
   * nobody answered. Emitted before the approver is asked, so the pair brackets
   * the wait rather than reporting it after the fact.
   */
  "approval.requested": ApprovalRequested;

  /**
   * How an approval ended — including the case where it never began.
   *
   * Always emitted for a call that needed approval, whatever happened to it.
   * That completeness is what makes it an audit trail: a record that covered
   * only the calls a person saw would be silent about the ones that ran because
   * nobody was there to ask.
   */
  "approval.settled": ApprovalSettled;

  /**
   * A subscriber is asking the watcher to re-fire routing for a task —
   * bypassing the assignee-transition gate so the same agent runs again.
   * The default StallGuard plugin emits this when it wants a retry; the
   * watcher subscribes and calls `notify({...}, { force: true })`.
   *
   * Open to external use: any plugin (e.g. a scheduler that wants to
   * poke a task after a remote signal landed) can emit this and the
   * watcher will route accordingly.
   */
  "task.dispatch_requested": {
    taskId: string;
    projectId?: string;
    /** Human-readable reason the dispatch was requested. Goes to logs only today. */
    reason: string;
  };

  /**
   * The watcher is about to run an agent loop for a task. Emitted via
   * `bus.emitAsync(...)` so subscribers can VETO the dispatch by
   * returning `false` — e.g. the default CoderProjectGuard plugin
   * refuses coder/reviewer dispatches that lack a usable project path.
   *
   * Subscribers that just want to observe (no veto) can subscribe with
   * a void-returning handler; the bus only treats an explicit `false`
   * return as veto.
   */
  "agent.dispatched": {
    taskId: string;
    projectId: string | null;
    /** Resolved agent name (`coder`, `reviewer`, `default`, etc.) or undefined when the watcher routes to the default. */
    agentName: string | undefined;
    task: AgentCompletedTask;
  };

  /**
   * Autopilot (or any subsystem) needs a human's attention on a task — it
   * errored or got blocked and there's nothing the agent can do without
   * input. Replaces the inline owner-DM the autopilot worker used to send.
   * The default `builtin:owner-notifier` plugin subscribes and delivers
   * (DM to the owner via the primary channel), applying quiet-hours
   * suppression. A user who wants different delivery disables that plugin
   * and subscribes their own handler.
   */
  "task.needs_human": {
    taskId: string;
    /** Agent that was working the task, when known. */
    agentName?: string;
    /** Short machine reason: "error", "question", etc. */
    reason: string;
    /** Human-readable message to deliver. */
    message: string;
  };

  /**
   * A periodic digest is ready to deliver (e.g. the autopilot morning
   * digest). Replaces the inline owner-DM the worker used to send. The
   * default `builtin:owner-notifier` plugin delivers it; digests are NOT
   * quiet-hours-suppressed (they fire on a schedule the user chose).
   */
  "digest.ready": {
    /** Rendered digest body. */
    content: string;
    /** Short label for the digest period, e.g. "last 24h". */
    periodLabel: string;
  };

  /**
   * An agent asked the user a question via the `ask_user` tool. Replaces
   * the inline owner-DM that tool used to send. `taskId` is set when the
   * question came from an autopilot task run (the task is already blocked
   * on `question` by the time this fires) — the default
   * `builtin:owner-notifier` plugin applies autopilot quiet-hours
   * suppression for those. Out-of-autopilot questions leave `taskId`
   * unset and are always delivered.
   */
  "question.asked": {
    /** The question text. */
    question: string;
    /** Session the question was asked from, when available. */
    sessionId?: string;
    /** Autopilot task id when the question came from a task run. */
    taskId?: string;
  };

  /**
   * A workflow step wants to deliver a message to the deployment owner
   * without the workflow author naming an explicit channel/user — the
   * implicit "tell the owner" fallback. Replaces the inline owner-DM the
   * `channel_message` executor used to send on that fallback path.
   * Explicit `channelId` / `userId` deliveries stay direct (author chose
   * the target). The default `builtin:owner-notifier` plugin delivers.
   */
  "form.completed": {
    /** Workflow run id, when known. */
    runId?: string;
    /** Step name that produced the message. */
    stepName?: string;
    /** Message body to deliver to the owner. */
    message: string;
  };

  /**
   * A proposal (pull/merge request) was opened by a `RepoBackend`.
   *
   * Slice 4 of the platform vision (`docs/platform-vision.md`): emitted by
   * the default `gh` backend (and any other forge backend) so automation
   * plugins — auto-merge on green CI, status mirroring, changelog
   * accounting — can react without the forge call site knowing about them.
   */
  "repo.proposal.opened": {
    /** Backend-native proposal id (PR number as a string for GitHub). */
    proposalId: string;
    number?: number;
    url?: string;
    branch: string;
    base: string;
    /** Task id when the proposal was opened for a task. */
    taskId?: string;
  };

  /** A proposal was merged by a `RepoBackend`. */
  "repo.proposal.merged": {
    proposalId: string;
    number?: number;
    branch: string;
    taskId?: string;
  };

  /** A proposal was closed without merging by a `RepoBackend`. */
  "repo.proposal.closed": {
    proposalId: string;
    number?: number;
    branch: string;
  };

  /**
   * A proposal was reviewed (approved / changes requested). Documented
   * placeholder — an inbound webhook/polling emitter lands with the
   * forge-integration work; no core emitter today.
   */
  "repo.proposal.reviewed": {
    proposalId: string;
    number?: number;
    /** Normalized review verdict. */
    decision: "approved" | "changes_requested" | "commented";
    reviewer?: string;
  };

  /**
   * A CI check completed for a proposal/commit. Documented placeholder —
   * emitted by a future forge webhook bridge; no core emitter today. The
   * vision's "auto-merge on green CI" example subscribes to this.
   */
  "repo.check.completed": {
    proposalId?: string;
    sha?: string;
    name?: string;
    conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out";
  };
}

/** Payload for `agent.post_tool_use`. */
/**
 * Payload for `approval.requested` — a human is being asked about a tool call.
 *
 * Emitted only when somebody is actually asked. The unattended case, where a
 * call needed approval and no approver existed, reaches the bus as an
 * `approval.settled` with `outcome: "unattended"` and no request before it —
 * which is the point: an audit that showed only the approvals that happened
 * would be silent about exactly the calls nobody saw.
 */
export interface ApprovalRequested {
  sessionId: string;
  /** The agent whose turn this is, when it has a name. */
  agent?: string;
  /** Project scope, mirroring `session.projectId`. */
  projectId: string | null;
  tool: string;
  /** Joins this to the tool events for the same call. */
  toolUseId: string;
  /** The approval request's own id, joining this to its `approval.settled`. */
  requestId: string;
  /** Exactly what the approver was shown, not a reconstruction of it. */
  description: string;
}

/** Payload for `approval.settled` — how an approval ended, including not happening. */
export interface ApprovalSettled {
  sessionId: string;
  agent?: string;
  projectId: string | null;
  tool: string;
  toolUseId: string;
  /** Absent when nobody was asked, which is what `unattended` means. */
  requestId?: string;
  /**
   * `unattended` is not a decision — it is a call that needed one on a path
   * with no approver: cron, a room wake, the task watcher. Whether it then ran
   * is `permissions.noHandlerAction`, and this is the only place that fact
   * becomes visible per call rather than as a one-time warning in a log.
   */
  outcome: "approved" | "rejected" | "unattended";
  /**
   * True when the answer came from the clock rather than a person.
   * `{ outcome: "approved", timedOut: true }` is `timeoutAction: auto_approve`
   * firing — the case an auditor most wants to be able to find, and the one
   * that reads exactly like a human approval if the fact is not carried.
   */
  timedOut: boolean;
  /** The approver's stated reason, when they gave one. */
  reason?: string;
  /** How long the answer took. Absent when nobody was asked. */
  responseTimeMs?: number;
}

export interface ToolUsed {
  sessionId: string;
  /** The agent whose turn this is, when it has a name. */
  agent?: string;
  /** Project scope, mirroring `session.projectId`. */
  projectId: string | null;
  tool: string;
  /**
   * The provider's id for this call — the same one `agent.pre_tool_use` and the
   * approval events carry, so a subscriber can join what was proposed, what was
   * approved, and what actually ran.
   */
  toolUseId: string;
  /** Where the call ran. */
  cwd: string;
  /** What the tool was given, after any `agent.pre_tool_use` rewrite. */
  args: Record<string, unknown>;
  /** The text the model will see, after the loop's output cap. */
  output: string;
  /** False when the tool reported failure. It still ran. */
  success: boolean;
  durationMs: number;
}

/**
 * Payload for `agent.request_assembled`.
 *
 * `params` is the request itself, so most of what a consumer wants is already
 * in it. The other fields are what the loop knows and the request does not:
 * where in the turn this was, which rung sent it, and how the system prompt
 * came to be the size it is.
 */
export interface RequestAssembled {
  sessionId: string;
  /** The agent whose turn this is, when it has a name. */
  agent?: string;
  /** Project scope, mirroring `session.projectId`. */
  projectId: string | null;
  /**
   * Round within the turn, 1-based — the same number the loop's own
   * budget messages use ("3/6 rounds used"), so the two can be read together.
   */
  round: number;
  /**
   * Which call this is. `"round"` is the normal tool-calling request;
   * `"final_report"` is the toolless summary the loop makes after exhausting
   * `maxToolRounds`, which shares a round number with the last one and is
   * otherwise indistinguishable from it.
   */
  phase: "round" | "final_report";
  /** 0-based rung in the fallback chain. Non-zero means an earlier rung failed. */
  attempt: number;
  /** The rung's configured label. */
  rung: string;
  /** The model actually asked, which a rung override may change. */
  model: string;
  /** True when this request produced the answer; false when it failed and a later rung was tried. */
  answered: boolean;
  /**
   * Exactly what the provider was handed: system prompt, the messages that
   * survived trimming, tool schemas, sampling, hydrated media. Already sent —
   * treat as read-only.
   */
  params: ChatParams;
  /**
   * What each context slot contributed to the system prompt, in render order.
   * Empty when nothing rendered; absent slots were filtered, threw, or returned
   * nothing.
   */
  slots: RenderedSlot[];
  /**
   * Messages the session held before trimming, to read `params.messages.length`
   * against. The difference is what the budget dropped.
   */
  historyLength: number;
}

/**
 * Task snapshot carried on agent.completed. Subset of the project_tasks
 * row — only the fields downstream plugins typically read. Plugins that
 * need more should fetch via their own DB / backend handle.
 */
export interface AgentCompletedTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  assignee: string | null;
}

/**
 * Worktree context attached to agent.completed when the loop ran in an
 * isolated per-task worktree. Subscribers that want to inspect branch
 * commits should use `repoPath` + `branch` rather than `worktreePath`,
 * since the worktree dir may have been torn down by the watcher's
 * cleanup before the event reaches them.
 */
export interface AgentCompletedWorktree {
  /** Absolute path of the parent repo (the project root). Always present on disk. */
  repoPath: string;
  /**
   * Absolute path of the per-task worktree dir. May not exist by event
   * time — if the worktree was cleaned, the directory is gone but the
   * branch persists in the parent repo.
   */
  worktreePath: string;
  /** Branch name the worktree was on (e.g. `agent/<task-id>-<slug>`). */
  branch: string;
  /**
   * When the worktree was preserved (uncommitted changes), this is the
   * preserved on-disk path. Null when the worktree was cleaned up
   * normally.
   */
  preservedPath: string | null;
}

export type RuntimeEvent = keyof RuntimeEventMap;

export type RuntimeEventPayload<K extends RuntimeEvent> = RuntimeEventMap[K];

/**
 * Handler signature. The return type intentionally allows a `boolean`
 * (or `Promise<boolean>`) so handlers attached to vetoable events can
 * say "veto this dispatch" by returning `false`. `emit` ignores the
 * return value; only `emitAsync` consults it (see {@link EventBus.emitAsync}).
 * Handlers that don't care return `void` as before.
 */
export type RuntimeEventHandler<K extends RuntimeEvent> = (
  payload: RuntimeEventPayload<K>,
) => void | boolean | Promise<void | boolean>;

/**
 * Events dispatched as a **waterfall** rather than a broadcast.
 *
 * A waterfall is around-middleware: each listener receives the payload and a
 * `next`, may transform the payload, and either delegates or short-circuits.
 * `emit` lets a listener observe and `emitAsync` lets it veto; only a waterfall
 * lets it *change* what happens. That is the difference between a plugin that
 * can refuse an operation and one that can correct it.
 *
 * **The dispatch mode is part of an event's contract.** A waterfall event is
 * declared here and nowhere else, so it can never be `emit`ed by accident, and
 * a broadcast event can never be handed a `next` it does not expect.
 *
 * The map is extended by declaration merging, exactly like
 * {@link RuntimeEventMap}, so a plugin can declare and dispatch its own
 * waterfall without a core release:
 *
 * ```ts
 * declare module "@tailored-ai/core" {
 *   interface RuntimeWaterfallMap {
 *     "myplugin.outbound": { text: string };
 *   }
 * }
 * ```
 *
 * Core declares one: `agent.context_slots`, the slot list the loop is about to
 * render. See {@link ContextSlotWaterfall}.
 */
export interface RuntimeWaterfallMap {
  /**
   * The context slots a turn is about to render, before any of them run.
   *
   * The first core waterfall, and chosen because it is the smallest honest one:
   * `renderContextSlots` is already a pure function over a slot list, so a
   * subscriber that reorders, drops, caps or adds a slot needs no knowledge of
   * how the prompt is composed — which is the property #417 is after.
   *
   * The list is handed over *before* rendering rather than after, so a
   * subscriber can stop a slot from running at all. A slot that is expensive,
   * or that reads something the subscriber knows is unavailable, is better not
   * called than called and discarded.
   */
  "agent.context_slots": ContextSlotWaterfall;

  /**
   * A tool call the loop is about to run — the seam for policy on any tool,
   * without the policy knowing the tool or the tool knowing the policy.
   *
   * A waterfall rather than a veto-only `emitAsync`, because refusing is the
   * weaker of the two useful answers. A subscriber can replace `args`, which is
   * the difference between a guard that says no and one that says "not like
   * that" — narrow a path, drop a flag, cap a limit.
   *
   * Dispatched **before the approval gate**: a rewrite has to happen before a
   * human is asked, or they approve one call and a different one runs. And
   * **before validation**, so whatever will actually execute is what gets
   * validated. A refusal short-circuits the rest, so nothing downstream sees a
   * call that was stopped here.
   *
   * This is not where a ceiling that must outlive a human's approval belongs.
   * Those live inside the tools — `exec`'s allowlist, the path boundary, the
   * sandbox — where nothing can reorder them.
   */
  "agent.pre_tool_use": PreToolUseWaterfall;
}

/**
 * Payload for `agent.pre_tool_use`.
 */
export interface PreToolUseWaterfall {
  sessionId: string;
  /** The agent whose turn this is, when it has a name. */
  agent?: string;
  /** Project scope, mirroring `session.projectId`. */
  projectId: string | null;
  /**
   * The tool about to run. Deliberately not replaceable: swapping the tool
   * would leave the model's own record of what it called wrong. Refuse this
   * call and say what to do instead.
   */
  tool: string;
  /**
   * The provider's id for this call, carried on every event it produces.
   *
   * What makes the tool events joinable. Without it a subscriber sees a tool
   * name and cannot tell one `exec` in a turn from the next, so it can count
   * calls but never follow one — and "did the call I let through do what it
   * said" has no way to be asked.
   */
  toolUseId: string;
  /** Where the call runs. A hook otherwise has to guess at it. */
  cwd: string;
  /** The call's arguments. Replace them to change what runs. */
  args: Record<string, unknown>;
  /**
   * Set to refuse the call. The text is returned to the model in place of the
   * tool's output, so write it as an instruction — the model reads it and
   * decides what to do next, and "denied" alone tells it nothing.
   */
  deny?: string;
}

/**
 * Payload for `agent.context_slots`.
 *
 * Carries the same context the slots themselves are rendered with, so a
 * subscriber can decide per agent, session or message without reaching for
 * anything the loop has not already resolved.
 */
export interface ContextSlotWaterfall extends ContextSlotContext {
  /** Registered slots plus whatever config declared, in render order. */
  slots: ContextSlot[];
}

/**
 * Waterfall events, as data.
 *
 * `RuntimeWaterfallMap` is a type and vanishes at runtime, but anything
 * dispatching by a name it read from config has to know which mode an event
 * uses — `onWaterfall` and `on` are not interchangeable. Core's own waterfalls
 * are listed here; a plugin that declares one through module augmentation
 * registers it with {@link registerWaterfallEvent} so config-declared hooks can
 * reach it too.
 */
const waterfallEvents = new Set<string>(["agent.context_slots", "agent.pre_tool_use"]);

/** Declare a plugin's waterfall event so config-declared subscribers dispatch it correctly. */
export function registerWaterfallEvent(event: string): void {
  waterfallEvents.add(event);
}

/** Whether `event` is dispatched as a waterfall rather than a broadcast. */
export function isWaterfallEvent(event: string): boolean {
  return waterfallEvents.has(event);
}

/** Every event name a config-declared hook may bind to, in both dispatch modes. */
export function listKnownEvents(): string[] {
  return [...new Set([...KNOWN_BROADCAST_EVENTS, ...waterfallEvents])].sort();
}

/**
 * Broadcast event names, as data, for the same reason as above.
 *
 * Kept beside {@link RuntimeEventMap} and checked against it by a test, so the
 * two cannot drift: a new event that is not listed here is invisible to config,
 * which is the failure mode this whole area keeps producing.
 */
export const KNOWN_BROADCAST_EVENTS = [
  "agent.completed",
  "agent.dispatched",
  "agent.messaged",
  "agent.post_tool_use",
  "agent.request_assembled",
  "agent.stalled",
  "agents.pause_changed",
  "approval.requested",
  "approval.settled",
  "digest.ready",
  "form.completed",
  "question.asked",
  "repo.check.completed",
  "repo.proposal.closed",
  "repo.proposal.merged",
  "repo.proposal.opened",
  "repo.proposal.reviewed",
  "room.archived",
  "room.membership_changed",
  "room.message",
  "room.turn_ended",
  "room.unarchived",
  "room.woke",
  "runtime.reloaded",
  "schedule.cancelled",
  "schedule.created",
  "schedule.fired",
  "session.compacted",
  "task.commented",
  "task.created",
  "task.dispatch_requested",
  "task.needs_human",
  "task.transitioned",
  "task.updated",
] as const;

/**
 * Fails the build if {@link KNOWN_BROADCAST_EVENTS} and {@link RuntimeEventMap}
 * disagree.
 *
 * Not a nicety. An event missing from the list is invisible to config-declared
 * hooks *and* reported by `validateConfig` as "not a runtime event" — so a new
 * event would arrive already broken for the one audience that cannot read the
 * type. A compile error is the cheapest possible version of that news.
 *
 * Declaration merging means a plugin's own events are not in scope here, which
 * is correct: they register through {@link registerWaterfallEvent} at runtime.
 */
type Identical<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type AssertTrue<T extends true> = T;
type _BroadcastListMatches = AssertTrue<Identical<keyof RuntimeEventMap, (typeof KNOWN_BROADCAST_EVENTS)[number]>>;

/**
 * Which events name an agent in their payload, as data.
 *
 * A config-declared hook under `agents.<name>` can only be scoped to its agent
 * if the occurrence says which agent it belongs to. Most events do not: a task
 * transition, a proposal opening and a compaction are things that happen to a
 * deployment, not to an agent. Hooks for those belong at the top level.
 *
 * Without this list that distinction was invisible — `validateConfig` blessed
 * every name in the catalog, and the two thirds that carry no agent bound
 * cleanly and then never fired. Which is precisely the failure the catalog was
 * introduced to prevent, one level down. The list exists so the warning can
 * name the problem at config time instead.
 *
 * `keyof` rather than assignability: every payload is assignable to
 * `{ agent?: string }`, because an absent optional property satisfies it. Only
 * `keyof` distinguishes a payload that declares the field from one that does
 * not.
 */
type NamesAnAgent<T> = "agent" extends keyof T ? true : "agentName" extends keyof T ? true : false;
type AgentScopedFrom<M> = { [K in keyof M]: NamesAnAgent<M[K]> extends true ? K : never }[keyof M];
type AgentScopedEvent = AgentScopedFrom<RuntimeEventMap> | AgentScopedFrom<RuntimeWaterfallMap>;

export const AGENT_SCOPED_EVENTS = [
  "agent.completed",
  "agent.context_slots",
  "agent.dispatched",
  "agent.post_tool_use",
  "agent.pre_tool_use",
  "agent.request_assembled",
  "agent.stalled",
  "approval.requested",
  "approval.settled",
  "room.membership_changed",
  "room.turn_ended",
  "room.woke",
  "schedule.cancelled",
  "schedule.created",
  "schedule.fired",
  "task.needs_human",
] as const;

/** Same guard as above, for the same reason: a new event arrives classified or not at all. */
type _AgentScopedListMatches = AssertTrue<Identical<AgentScopedEvent, (typeof AGENT_SCOPED_EVENTS)[number]>>;

/**
 * Whether an occurrence of `event` says which agent it belongs to.
 *
 * Plugin events are unknown here and answer `false`, which is the safe reading:
 * it steers a hook toward the top level, where it fires, rather than under an
 * agent, where it would not.
 */
export function isAgentScopedEvent(event: string): boolean {
  return (AGENT_SCOPED_EVENTS as readonly string[]).includes(event);
}

/**
 * The agent an occurrence belongs to, under either spelling.
 *
 * Four events say `agentName` where the rest say `agent` — history, not
 * design. Normalising here rather than at each reader is what keeps a hook's
 * `when: { agent: … }` meaning one thing across the whole catalog.
 */
export function agentOfPayload(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.agent === "string") return payload.agent;
  if (typeof payload.agentName === "string") return payload.agentName;
  return undefined;
}

export type RuntimeWaterfallEvent = keyof RuntimeWaterfallMap;

export type RuntimeWaterfallPayload<K extends RuntimeWaterfallEvent> = RuntimeWaterfallMap[K];

/**
 * Hand the payload to the rest of the chain and get back what they made of it.
 *
 * Pass the payload you want downstream to see — the one you were given, or your
 * own replacement.
 */
export type WaterfallNext<T> = (payload: T) => Promise<T>;

/**
 * One link in a waterfall chain.
 *
 * Call `next(payload)` to delegate and return its result; return your own value
 * without calling `next` to short-circuit and own the outcome. A listener that
 * only annotates **must** delegate — short-circuiting is for the listener that
 * owns the decision.
 */
export type WaterfallHandler<K extends RuntimeWaterfallEvent> = (
  payload: RuntimeWaterfallPayload<K>,
  next: WaterfallNext<RuntimeWaterfallPayload<K>>,
) => RuntimeWaterfallPayload<K> | Promise<RuntimeWaterfallPayload<K>>;

/** Options for {@link EventBus.onWaterfall}. */
export interface WaterfallOptions {
  /**
   * Run before listeners registered earlier. For the rare listener that must
   * see the payload first — a policy that decides whether the rest of the chain
   * runs at all. Ordinary listeners should not need it.
   */
  prepend?: boolean;
}

/**
 * Returned by `on()` so callers can stop receiving an event without
 * keeping the handler identity around. Calling `dispose()` more than
 * once is a no-op.
 */
export interface Subscription {
  dispose(): void;
}

/**
 * Pub/sub surface plugins and internal subsystems use to listen for
 * runtime events. See the file-level doc for design notes.
 */
export interface EventBus {
  on<K extends RuntimeEvent>(event: K, handler: RuntimeEventHandler<K>): Subscription;
  off<K extends RuntimeEvent>(event: K, handler: RuntimeEventHandler<K>): void;
  emit<K extends RuntimeEvent>(event: K, payload: RuntimeEventPayload<K>): void;
  /**
   * Synchronous-causality variant of `emit`. Awaits every subscriber
   * (sequentially, in registration order) and returns `true` when none
   * vetoed, `false` when any handler returned `false`. Use for events
   * where a plugin may need to block downstream work — e.g. the default
   * CoderProjectGuard subscribes to `agent.dispatched` and returns
   * `false` when the task lacks a usable project, which tells the
   * watcher to skip the dispatch.
   *
   * A throwing handler is treated as **non-veto** and is logged; only
   * an explicit `false` return blocks the operation. That keeps a
   * misbehaving observability plugin from accidentally vetoing real
   * work.
   */
  emitAsync<K extends RuntimeEvent>(event: K, payload: RuntimeEventPayload<K>): Promise<boolean>;
  /**
   * Register an around-middleware listener for a waterfall event.
   * Returns a disposer, like {@link EventBus.on}.
   */
  onWaterfall<K extends RuntimeWaterfallEvent>(
    event: K,
    handler: WaterfallHandler<K>,
    opts?: WaterfallOptions,
  ): Subscription;
  /**
   * Run the waterfall chain and return the payload it produced.
   *
   * Listeners run in registration order, each able to transform the payload and
   * delegate to the rest via `next`. With no listeners the payload comes back
   * unchanged, so a caller never needs to special-case the empty chain.
   *
   * A **throwing listener is skipped**, not fatal: the chain continues with the
   * payload that listener was handed. One bad subscriber must not break the
   * operation it was only observing — the same rule `emit` and `emitAsync`
   * already follow.
   *
   * A listener that returns nothing is treated as a pass-through rather than as
   * an instruction to truncate: if it delegated, its downstream result stands;
   * if it did not, the chain continues without it. Forgetting to return must
   * not silently drop every listener after you.
   */
  waterfall<K extends RuntimeWaterfallEvent>(
    event: K,
    payload: RuntimeWaterfallPayload<K>,
  ): Promise<RuntimeWaterfallPayload<K>>;
  /**
   * Remove every subscriber, broadcast and waterfall alike. Used during runtime
   * reload so internal subscribers re-arm cleanly and stale plugin handlers from
   * a previous generation can't keep firing.
   */
  clear(): void;
  /**
   * Number of subscribers for an event — useful for tests + observability.
   * Returns 0 for events nobody subscribed to.
   */
  listenerCount<K extends RuntimeEvent>(event: K): number;
  /** Number of listeners in a waterfall chain. Returns 0 for an empty chain. */
  waterfallCount<K extends RuntimeWaterfallEvent>(event: K): number;
}

// Internal handler storage is widened to `RuntimeEventHandler<RuntimeEvent>`
// to make a single Set per event work. The on/off/emit public methods keep
// per-event type safety.
type AnyHandler = RuntimeEventHandler<RuntimeEvent>;

// Same widening for waterfall chains. Order matters here in a way it does not
// for a Set, so chains are arrays.
type AnyWaterfall = (payload: unknown, next: (payload: unknown) => Promise<unknown>) => unknown;

/**
 * Default in-memory `EventBus` implementation. The runtime owns one
 * instance per lifecycle; tests and standalone callers can instantiate
 * their own.
 */
export class TypedEventBus implements EventBus {
  private handlers: Map<RuntimeEvent, Set<AnyHandler>> = new Map();
  // Keyed by plain string: `keyof RuntimeWaterfallMap` is `never` until a
  // declaration merge adds an event, which would make the storage untypeable
  // while leaving the public signatures correctly typed by the map.
  private waterfalls: Map<string, AnyWaterfall[]> = new Map();

  on<K extends RuntimeEvent>(event: K, handler: RuntimeEventHandler<K>): Subscription {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as AnyHandler);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.off(event, handler);
      },
    };
  }

  off<K extends RuntimeEvent>(event: K, handler: RuntimeEventHandler<K>): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler as AnyHandler);
    if (set.size === 0) this.handlers.delete(event);
  }

  emit<K extends RuntimeEvent>(event: K, payload: RuntimeEventPayload<K>): void {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;
    // Snapshot the handlers so `off()` during dispatch — including a
    // handler unsubscribing itself — doesn't break iteration.
    const snapshot = [...set];
    for (const handler of snapshot) {
      let result: void | boolean | Promise<void | boolean>;
      try {
        result = handler(payload);
      } catch (err) {
        console.error(`[events] sync handler for "${event}" threw:`, err);
        continue;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) => {
          console.error(`[events] async handler for "${event}" rejected:`, err);
        });
      }
    }
  }

  async emitAsync<K extends RuntimeEvent>(event: K, payload: RuntimeEventPayload<K>): Promise<boolean> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return true;
    // Snapshot up front so off/on during dispatch behave the same as
    // `emit`. Sequential await ensures predictable ordering — a guard
    // that mutates DB state needs to land before the next handler runs.
    const snapshot = [...set];
    let vetoed = false;
    for (const handler of snapshot) {
      try {
        const result = await handler(payload);
        if (result === false) vetoed = true;
      } catch (err) {
        // Throwing handlers are treated as non-veto. Logged like the
        // emit() path so observability isn't affected by silent veto.
        console.error(`[events] handler for "${event}" threw during emitAsync:`, err);
      }
    }
    return !vetoed;
  }

  onWaterfall<K extends RuntimeWaterfallEvent>(
    event: K,
    handler: WaterfallHandler<K>,
    opts: WaterfallOptions = {},
  ): Subscription {
    const key = String(event);
    let chain = this.waterfalls.get(key);
    if (!chain) {
      chain = [];
      this.waterfalls.set(key, chain);
    }
    const entry = handler as unknown as AnyWaterfall;
    if (opts.prepend) chain.unshift(entry);
    else chain.push(entry);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = this.waterfalls.get(key);
        if (!current) return;
        const at = current.indexOf(entry);
        if (at !== -1) current.splice(at, 1);
        if (current.length === 0) this.waterfalls.delete(key);
      },
    };
  }

  async waterfall<K extends RuntimeWaterfallEvent>(
    event: K,
    payload: RuntimeWaterfallPayload<K>,
  ): Promise<RuntimeWaterfallPayload<K>> {
    const chain = this.waterfalls.get(String(event));
    if (!chain || chain.length === 0) return payload;
    // Snapshot so a listener registering or disposing mid-dispatch behaves the
    // same as it does for emit: this dispatch runs the chain it started with.
    const snapshot = [...chain];

    const run = async (index: number, current: unknown): Promise<unknown> => {
      if (index >= snapshot.length) return current;
      const handler = snapshot[index];
      // Hold the promise, not the resolved value: a listener may call `next`
      // without awaiting it (a pure observer often does), and by the time the
      // handler returns, the downstream chain is still in flight.
      let delegated: Promise<unknown> | undefined;
      const next = (forwarded: unknown): Promise<unknown> => {
        delegated = run(index + 1, forwarded);
        return delegated;
      };
      try {
        const out = await handler(current, next);
        if (out !== undefined) return out;
        // Returned nothing. If it delegated, it was observing and the
        // downstream result stands; if not, carry on without it rather than
        // letting a forgotten `return` truncate the chain silently.
        return delegated ? await delegated : run(index + 1, current);
      } catch (err) {
        console.error(`[events] waterfall listener for "${String(event)}" threw:`, err);
        return delegated ? await delegated : run(index + 1, current);
      }
    };

    return (await run(0, payload)) as RuntimeWaterfallPayload<K>;
  }

  clear(): void {
    this.handlers.clear();
    this.waterfalls.clear();
  }

  listenerCount<K extends RuntimeEvent>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  waterfallCount<K extends RuntimeWaterfallEvent>(event: K): number {
    return this.waterfalls.get(String(event))?.length ?? 0;
  }
}
