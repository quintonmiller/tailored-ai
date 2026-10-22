/**
 * Waking an agent for a turn nobody asked for.
 *
 * Subscriptions, plugins that start turns of their own (the places plugin's
 * tend, the directory's upkeep) and the wakes agents book for themselves in a
 * session all come through here, so they stop for the same things: the pause
 * switch, an online agent switched off or paused on its own, one hourly wake
 * ceiling per agent, a turn already running in the same session, and an
 * agent that isn't there. The session and loop are set up the same way for
 * each of them too. A plugin that called `runAgentLoop` itself skipped every
 * one of those.
 *
 * A turn with a `room` goes to the room watcher, which the host wires in with
 * `setRoomWaker`. The room applies its own turn order and hourly ceiling, as
 * it does for a subscription delivered there.
 */
import type { AgentDefinition } from "../config.js";
import { getExploratoryState } from "../db/exploratory-queries.js";
import { getSession, getSessionByKey, type SessionRow } from "../db/queries.js";
import { ROOM_WATCHER_DEFAULTS } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { resolveAgent } from "./agents.js";
import { runAgentLoop } from "./loop.js";
import { findOrCreateSession, loadSession, type Session } from "./session.js";

const HOUR_MS = 3_600_000;

/** Why a turn is running when nobody asked for it. */
export interface Wake {
  /** What woke the agent: `subscription`, or a plugin's own word for it, such as `upkeep`. */
  kind: string;
  /** Which one, when there can be several: a subscription's key, a record's id. */
  ref?: string;
}

/**
 * What became of a wake. `paused` and `at-ceiling` pass, so try again later:
 * `paused` while autonomous turns are paused, for everyone or for this online
 * agent on its own (switched off or paused on the Agents page, both of which a
 * person can undo). `gone` means there is nothing to wake: no such agent or
 * room, an agent that isn't in the room, or rooms switched off. Don't retry it.
 */
export type WakeOutcome = "ran" | "paused" | "at-ceiling" | "gone";

/**
 * The session a woken turn runs in: one by its key, found or made, such as
 * `upkeep:<agent>`; or one that already exists, by its id, such as the session
 * an agent booked a wake from. A session id that names no session is `gone`.
 */
export type WakeSession = { sessionKey: string; sessionId?: undefined } | { sessionId: string; sessionKey?: undefined };

/**
 * A turn for `wakeAgent`: the prompt, why it runs, and where, a session or a
 * room. `maxToolRounds` caps a session turn's rounds of tool calls, for work
 * that should stay short; an agent configured for fewer keeps its own. A room
 * turn runs as the room runs its turns.
 */
export type WakeAgentOptions = {
  prompt: string;
  wake: Wake;
} & (
  | (WakeSession & { room?: undefined; maxToolRounds?: number })
  | {
      room: string;
      sessionKey?: undefined;
      sessionId?: undefined;
      maxToolRounds?: undefined;
    }
);

/** Why a wake would be turned away: the outcome it would come to, and why in words for a person. */
export interface WakeRefusal {
  outcome: Exclude<WakeOutcome, "ran">;
  /** "agents are paused", "it's at its wake ceiling: 12 wakes in the last hour". */
  why: string;
  /**
   * At the hourly ceiling, when the hour next has room, in ms since the epoch:
   * when the oldest wake that counts leaves it. Absent for any other refusal,
   * whose end nobody can tell.
   */
  until?: number;
}

/** Runs a woken turn in a room. The host sets one once its room watcher is running. */
export type RoomWaker = (
  agent: string,
  room: string,
  turn: { prompt: string; wake: Wake },
) => Promise<"ran" | "at-ceiling" | "gone">;

type WakeHost = Pick<
  AgentRuntime,
  | "db"
  | "events"
  | "contextDir"
  | "getConfig"
  | "isAgentsPaused"
  | "getAgentDefinition"
  | "getResolvableTools"
  | "buildResolveOptions"
  | "buildLoopOptions"
>;

/**
 * The runtime's waker. One per runtime, and it outlives a reload, so the
 * hourly count is not reset by editing config.
 */
export class AgentWaker {
  /** Session wakes per agent, newest last, inside the last hour. */
  private readonly wakes = new Map<string, number[]>();
  /** `<agent> <session id>` for every woken turn still running. */
  private readonly running = new Set<string>();
  private roomWaker: RoomWaker | undefined;
  /** Whether a room wake has already been told there is no room waker. Said once, not per wake. */
  private warnedNoRoomWaker = false;

  constructor(
    private readonly host: WakeHost,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setRoomWaker(waker: RoomWaker | undefined): void {
    this.roomWaker = waker;
  }

  async wake(agent: string, opts: WakeAgentOptions): Promise<WakeOutcome> {
    const host = this.host;
    // The types allow one place and no round budget for a room, but a plugin in plain JS gets no say from them,
    // and an option dropped without a word would run a turn somewhere else, or uncapped.
    const places = [opts.room, opts.sessionKey, opts.sessionId].filter((p) => p !== undefined).length;
    if (places === 0) throw new Error(`wakeAgent("${agent}") needs a sessionKey, a sessionId or a room.`);
    if (places > 1) throw new Error(`wakeAgent("${agent}") takes one of sessionKey, sessionId and room, not several.`);
    const rounds = opts.maxToolRounds;
    if (rounds !== undefined && opts.room !== undefined) {
      throw new Error(`wakeAgent("${agent}"): maxToolRounds applies to a session turn, not a room's.`);
    }
    if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= 1)) {
      throw new Error(`wakeAgent("${agent}"): maxToolRounds is a whole number, at least 1.`);
    }
    const definition = host.getAgentDefinition(agent);
    const standing = this.standing(agent, definition);
    if (standing) return standing.outcome;

    if (opts.room !== undefined) {
      if (this.roomWaker) return this.roomWaker(agent, opts.room, { prompt: opts.prompt, wake: opts.wake });
      // Rooms switched off is permanent; rooms still starting is not.
      if (host.getConfig().rooms?.enabled === false) return "gone";
      if (!this.warnedNoRoomWaker) {
        this.warnedNoRoomWaker = true;
        console.warn(
          `[wake] a room wake for ${agent} arrived with no room waker; it will be "at-ceiling" until the host calls setRoomWaker.`,
        );
      }
      return "at-ceiling";
    }

    const t = this.now();
    const recent = this.recent(agent, t);
    this.wakes.set(agent, recent);
    const existing = this.existing(opts);
    const refused = this.sessionRefusal(agent, opts, existing, recent);
    if (refused) {
      if (refused.ceiling) {
        console.warn(
          `[wake] ${agent} is at its wake ceiling (${this.limit()}/hour); not woken for ${describeWake(opts.wake)}.`,
        );
      }
      return refused.outcome;
    }
    recent.push(t);

    const name = definition ? agent : undefined;
    let session: Session;
    if (opts.sessionId !== undefined) {
      // Checked above: it exists, and nothing since could have taken it away.
      session = loadSession(host.db, opts.sessionId) as Session;
    } else {
      const resolved = resolveAgent(
        name,
        host.getConfig(),
        host.getResolvableTools(),
        undefined,
        host.contextDir,
        undefined,
        host.buildResolveOptions(),
      );
      session = findOrCreateSession(host.db, opts.sessionKey, resolved.model, resolved.provider);
    }
    // Keyed by the session itself, so a turn woken by its key and one woken by its id can't run in it at once.
    const key = runKey(agent, session.id);
    this.running.add(key);
    try {
      const target = opts.sessionKey ?? existing?.key ?? session.id;
      console.log(`[wake] waking ${agent} in ${target} for ${describeWake(opts.wake)}`);
      host.events.emit("agent.woken", { agent, wake: opts.wake, targetKind: "session", target });
      const options = host.buildLoopOptions({ session, agentName: name, wake: opts.wake });
      // The budget is a ceiling: an agent configured for fewer rounds keeps its own.
      if (rounds !== undefined) options.maxToolRounds = Math.min(options.maxToolRounds ?? rounds, rounds);
      await runAgentLoop(opts.prompt, options);
    } finally {
      this.running.delete(key);
    }
    return "ran";
  }

  /**
   * Why a session wake for `agent` would be turned away now, or undefined
   * when it would run. Nothing runs and nothing is counted. For a caller
   * that has to answer before its turn starts, such as a route that replies
   * and runs the turn after; the wake itself checks again when it comes.
   */
  refusal(agent: string, where: WakeSession): WakeRefusal | undefined {
    const standing = this.standing(agent, this.host.getAgentDefinition(agent));
    if (standing) return standing;
    const refused = this.sessionRefusal(agent, where, this.existing(where), this.recent(agent, this.now()));
    if (!refused) return undefined;
    const { outcome, why, until } = refused;
    return { outcome, why, ...(until !== undefined ? { until } : {}) };
  }

  /** What every wake stops for first, a room's too: the pause switches, and an agent to wake. */
  private standing(agent: string, definition: AgentDefinition | undefined): WakeRefusal | undefined {
    if (this.host.isAgentsPaused("autonomous")) return { outcome: "paused", why: "agents are paused" };
    // The base agent answers to "default" whether or not one is declared, as it
    // does everywhere else an agent is named.
    if (!definition && agent !== "default") return { outcome: "gone", why: `there's no agent called ${agent}` };
    // An online agent switched off or paused on the Agents page takes no turns
    // of its own. Both are a person's switch and both can be undone, so the
    // wake waits rather than being thrown away.
    if (definition?.online?.enabled && this.ownPause(agent)) {
      return { outcome: "paused", why: "it's switched off or paused on the Agents page" };
    }
    return undefined;
  }

  /**
   * What stops a session wake once the standing checks pass: a session id
   * that names no session, a woken turn still running in that session, or
   * the agent's hourly ceiling. The turn in flight is checked before the
   * ceiling, so a wake turned away for it costs none of the hour.
   */
  private sessionRefusal(
    agent: string,
    where: WakeSession,
    existing: SessionRow | undefined,
    recent: number[],
  ): (WakeRefusal & { ceiling?: true }) | undefined {
    if (where.sessionId !== undefined && !existing) {
      return { outcome: "gone", why: `there's no session ${where.sessionId}` };
    }
    // Two turns at once in one session would interleave their history. A
    // session that doesn't exist yet has nothing running in it: a wake makes
    // its session before it lets go of the event loop.
    if (existing && this.running.has(runKey(agent, existing.id))) {
      return { outcome: "at-ceiling", why: "a woken turn is still running in its session" };
    }
    const limit = this.limit();
    if (recent.length >= limit) {
      // The hour has room once enough of these leave it to bring the count under the limit. A limit of none never
      // has room, so there's no time to give.
      const oldest = limit > 0 ? [...recent].sort((a, b) => a - b)[recent.length - limit] : undefined;
      return {
        outcome: "at-ceiling",
        why: `it's at its wake ceiling: ${limit} ${limit === 1 ? "wake" : "wakes"} in the last hour`,
        ...(oldest !== undefined ? { until: oldest + HOUR_MS } : {}),
        ceiling: true,
      };
    }
    return undefined;
  }

  /** The session a wake names, if it exists yet. */
  private existing(where: WakeSession): SessionRow | undefined {
    return where.sessionId !== undefined
      ? getSession(this.host.db, where.sessionId)
      : getSessionByKey(this.host.db, where.sessionKey);
  }

  /** The agent's session wakes inside the hour before `t`. */
  private recent(agent: string, t: number): number[] {
    return (this.wakes.get(agent) ?? []).filter((at) => t - at < HOUR_MS);
  }

  private limit(): number {
    return this.host.getConfig().rooms?.maxWakesPerHour ?? ROOM_WATCHER_DEFAULTS.maxWakesPerHour;
  }

  /** Whether an online agent's own switch is off, or its own pause hasn't run out. */
  private ownPause(agent: string): boolean {
    const own = getExploratoryState(this.host.db, agent);
    if (!own) return false;
    if (!own.enabled) return true;
    return own.paused_until !== null && Date.parse(own.paused_until) > this.now();
  }
}

/** What keeps one woken turn at a time in a session. */
const runKey = (agent: string, sessionId: string) => `${agent} ${sessionId}`;

/** `subscription`, or `upkeep (commitment/lisbon)`: for logs. */
export function describeWake(wake: Wake): string {
  return wake.ref ? `${wake.kind} (${wake.ref})` : wake.kind;
}
