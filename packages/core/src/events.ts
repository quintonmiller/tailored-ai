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
   * The runtime finished a config reload. Subscribers re-arming
   * themselves after a reload can use this rather than wiring into
   * the existing `onReload` hook directly.
   */
  "runtime.reloaded": {
    generation: number;
  };

  /**
   * An agent loop finished running for a task. Carries the initial task
   * (as the watcher saw it when routing), the final task state (which
   * may differ — the agent may have transitioned status / re-assigned
   * mid-loop), the agent's freeform response, and the routing context.
   *
   * Slice 3 of the platform vision (`docs/platform-vision.md`): default
   * plugins (Discord notifier, stall guard, scope-creep flagger)
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
   * An agent loop returned a `[Agent stopped: …]` terminator instead
   * of a clean response — see `detectStall`. The watcher emits this
   * INSTEAD of `agent.completed` when it spots a stall, so the
   * default StallGuard plugin (`packages/core/src/plugins/stall-guard.ts`)
   * can decide whether to retry or transition to blocked.
   *
   * Payload shape mirrors `agent.completed`, plus `stallReason`. If you
   * also want to react to stalls in your own plugin (e.g. for
   * observability), subscribe here. The DiscordNotifier doesn't —
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
    /** Short string extracted from the loop's `[Agent stopped: <reason>]` terminator. */
    stallReason: string;
    worktree?: AgentCompletedWorktree;
  };

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
   * Remove every subscriber. Used during runtime reload so internal
   * subscribers re-arm cleanly and stale plugin handlers from a previous
   * generation can't keep firing.
   */
  clear(): void;
  /**
   * Number of subscribers for an event — useful for tests + observability.
   * Returns 0 for events nobody subscribed to.
   */
  listenerCount<K extends RuntimeEvent>(event: K): number;
}

// Internal handler storage is widened to `RuntimeEventHandler<RuntimeEvent>`
// to make a single Set per event work. The on/off/emit public methods keep
// per-event type safety.
type AnyHandler = RuntimeEventHandler<RuntimeEvent>;

/**
 * Default in-memory `EventBus` implementation. The runtime owns one
 * instance per lifecycle; tests and standalone callers can instantiate
 * their own.
 */
export class TypedEventBus implements EventBus {
  private handlers: Map<RuntimeEvent, Set<AnyHandler>> = new Map();

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

  clear(): void {
    this.handlers.clear();
  }

  listenerCount<K extends RuntimeEvent>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
