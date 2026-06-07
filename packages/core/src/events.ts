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
}

export type RuntimeEvent = keyof RuntimeEventMap;

export type RuntimeEventPayload<K extends RuntimeEvent> = RuntimeEventMap[K];

export type RuntimeEventHandler<K extends RuntimeEvent> = (payload: RuntimeEventPayload<K>) => void | Promise<void>;

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
      let result: void | Promise<void>;
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

  clear(): void {
    this.handlers.clear();
  }

  listenerCount<K extends RuntimeEvent>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
