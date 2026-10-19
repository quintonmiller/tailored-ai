/**
 * When an agent that runs on its own takes its next turn: as the server works
 * it out the way the exploratory worker decides, within its hours and once
 * the day's limit lifts; from a server that doesn't say, its last turn plus
 * the interval it is on now, unless it is paused past that. Pure, so it is
 * tested without a server.
 */
import { whenMs } from "./tasks";

/** What the server says about an agent that runs on its own (`GET /api/exploratory/agents`). */
export interface OwnTurns {
  enabled_in_state: boolean;
  paused_until: string | null;
  last_tick_at: string | null;
  current_interval_ms: number | null;
  cadence: { interval_minutes?: number; window?: { start: string; end: string } } | null;
  /** When the worker next takes its turn, its hours and its day's limit counted; null when none will come. */
  next_turn_at?: string | null;
}

export type NextTurn =
  /** Switched off for this agent. */
  | { kind: "off" }
  /** Paused until then; it goes on after. */
  | { kind: "paused"; until: number }
  /** Due about then; `now` when it is already due and waiting for the worker's next look. */
  | { kind: "due"; at: number; every?: number }
  /** It runs on its own, but there is nothing to say when. */
  | { kind: "unknown" };

/** The interval it is on: the one it has backed off to, or the one it was given. */
function interval(agent: OwnTurns): number | undefined {
  if (agent.current_interval_ms && agent.current_interval_ms > 0) return agent.current_interval_ms;
  const minutes = agent.cadence?.interval_minutes;
  return minutes && minutes > 0 ? minutes * 60_000 : undefined;
}

/**
 * When the agent next takes a turn on its own. A turn the server says is due
 * and hasn't been taken is taken at the worker's next look: now. Without the
 * server's word, a time window it keeps to is not counted: the time is "about".
 */
export function nextTurn(agent: OwnTurns, now = Date.now()): NextTurn {
  if (!agent.enabled_in_state) return { kind: "off" };
  const paused = whenMs(agent.paused_until);
  if (paused > now) return { kind: "paused", until: paused };
  const every = interval(agent);
  if (agent.next_turn_at !== undefined) {
    const at = whenMs(agent.next_turn_at);
    if (!Number.isFinite(at)) return { kind: "unknown" };
    return { kind: "due", at: Math.max(now, at), ...(every ? { every } : {}) };
  }
  const last = whenMs(agent.last_tick_at);
  if (!Number.isFinite(last)) return { kind: "due", at: now, ...(every ? { every } : {}) };
  if (!every) return { kind: "unknown" };
  return { kind: "due", at: Math.max(now, last + every), every };
}
