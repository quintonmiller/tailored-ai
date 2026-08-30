/**
 * The four moments a TAI process passes through, and what exists at each.
 *
 * These are hook events like any other — they are declared in `hooks.on` and
 * dispatched through `runEventHooks`. What makes them their own module is that
 * they are the only events that fire when the runtime does not exist.
 *
 * The framing worth keeping: **a lifecycle hook runs inside the TAI process.**
 * `tai:init:start` is not "before TAI" in any sense a hook could care about —
 * the process is up, config has been read, and only the runtime is missing. An
 * earlier design took "before start" literally, concluded it was unbuildable,
 * and proposed a separate mechanism in the supervising CLI. That was wrong, and
 * it cost something concrete: a shutdown hook in a separate short-lived process
 * cannot call a tool, where `tai:shutdown:start` fires with the runtime still up
 * and can.
 *
 * ```
 * tai:init:start      config read, nothing built          process
 * tai:init:end        channels connected, a turn can run  runtime
 * tai:shutdown:start  teardown begins, runtime still up   runtime
 * tai:shutdown:end    teardown done, before exit          process
 * ```
 *
 * The symmetry is not decoration: the capability available to a hook is a
 * property of the phase, and it is the same at both ends.
 *
 * This module is a leaf — it imports nothing — because `config.ts` needs the
 * event names for validation and `event-hooks.ts` needs the tier type, and
 * either direction through the other would be a cycle.
 */

/**
 * What has to exist for a handler to work.
 *
 * `process` — a running process and the config. Enough to spawn a program.
 * `runtime` — the database, tool registry and event bus are up. Needed to
 * invoke a tool.
 */
export type HookTier = "process" | "runtime";

/** `process` is satisfied by anything; `runtime` only by itself. */
export function tierSatisfies(available: HookTier, required: HookTier): boolean {
  return available === "runtime" || required === "process";
}

export const LIFECYCLE_EVENTS = ["tai:init:start", "tai:init:end", "tai:shutdown:start", "tai:shutdown:end"] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export function isLifecycleEvent(name: string): name is LifecycleEvent {
  return (LIFECYCLE_EVENTS as readonly string[]).includes(name);
}

/** What exists when this event fires. */
export function lifecycleTier(event: LifecycleEvent): HookTier {
  return event === "tai:init:start" || event === "tai:shutdown:end" ? "process" : "runtime";
}

/**
 * Can a hook here stop what was about to happen?
 *
 * Only `tai:init:start`, and that asymmetry is the design rather than an
 * omission:
 *
 * - **`tai:init:start` refusing aborts the start.** This is most of the value —
 *   "the resource this deployment needs is not there, do not come up". A TAI
 *   that starts anyway looks healthy and fails on its first turn with an error
 *   pointing somewhere other than the cause.
 * - **The shutdown events cannot refuse.** A hook that could veto a stop makes
 *   an instance unstoppable, which is a worse failure than whatever the hook
 *   was protecting. By `tai:shutdown:end` the teardown has already happened, so
 *   there is nothing left to refuse in any case.
 * - **`tai:init:end` cannot refuse** because the runtime is already up and
 *   serving. Refusing there would mean tearing down something that has already
 *   started answering, which is a stop, not a refusal.
 */
export function isRefusableLifecycleEvent(event: LifecycleEvent): boolean {
  return event === "tai:init:start";
}
