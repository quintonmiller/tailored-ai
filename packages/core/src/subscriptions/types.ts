/**
 * Subscriptions: which agents hear about which runtime events, and how.
 *
 * Rooms already answer "should this message wake an agent, and when?" with a
 * subscription per (agent, room). This answers the same question for any event
 * on the runtime bus — a world-state change, a task transition, a click on an
 * interface — with the timing chosen per subscription. See
 * `docs/world-state.md` and `docs/world-state-design.md`.
 */

/**
 * When a matching event reaches the agent.
 *
 * - `immediate` — a turn now. Still subject to pause and the wake ceiling.
 * - `queue` — a turn after the rooms' batching delay, so a burst of events
 *   collapses into one turn.
 * - `batch` — everything that arrives within `window` of the first event, in
 *   one turn.
 * - `digest` — whatever accumulated, on the `every` schedule.
 * - `record` — never a turn of its own; the events appear in the agent's next
 *   turn, whatever woke it.
 */
export type DeliveryMode = "immediate" | "queue" | "batch" | "digest" | "record";

export const DELIVERY_MODES: readonly DeliveryMode[] = ["immediate", "queue", "batch", "digest", "record"];

/**
 * Where a woken turn runs and where its reply goes: a room, through the room's
 * own turn order and ceilings, or the agent's private session, where a reply
 * reaches nobody unless the agent sends it somewhere.
 */
export type SubscriptionTarget = "session" | { room: string };

export interface EventSubscriptionConfig {
  agent: string;
  /** A runtime event name, e.g. `state.changed`. */
  on: string;
  /** Payload fields that must all match: exact, or `/regex/`. The `hooks.on` matcher. */
  when?: Record<string, string>;
  /** Default `queue`. */
  deliver?: DeliveryMode;
  /** For `batch`: how long after the first event to deliver, e.g. `5m`. */
  window?: string;
  /** For `digest`: `every 2 hours`, `weekdays at 9am`, or cron. */
  every?: string;
  /** Default `session`. */
  target?: SubscriptionTarget;
  /** A line handed to the agent with the events, saying what to do about them. */
  instructions?: string;
  /**
   * Also deliver changes this agent made itself. Off by default, so an agent
   * that reacts to a change by making another one does not wake itself forever.
   */
  includeOwn?: boolean;
}

/** One event as it reaches an agent. */
export interface DeliveredEvent {
  event: string;
  /** One line describing it, written when it arrived. */
  summary: string;
  at: string;
}

export interface EventWakeContext {
  events: DeliveredEvent[];
  instructions?: string;
  deliver: DeliveryMode;
}

/**
 * What became of a delivery. `at-ceiling` covers every temporary refusal — the
 * wake ceiling, a pause, a turn already in flight — and is retried; `gone`
 * means the target no longer exists, and the events are dropped.
 */
export type DeliveryOutcome = "ran" | "at-ceiling" | "gone";

/** How a delivery becomes a turn. Swappable so the timing logic is testable on its own. */
export interface SubscriptionDelivery {
  toRoom(agent: string, room: string, ctx: EventWakeContext): Promise<DeliveryOutcome>;
  toSession(agent: string, ctx: EventWakeContext): Promise<DeliveryOutcome>;
}
