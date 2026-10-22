/**
 * Waking an agent for a turn nobody asked for.
 *
 * Subscriptions and plugins that start turns of their own come through here,
 * so they all stop for the same things: the pause switch, an online agent
 * switched off or paused on its own, one hourly wake ceiling per agent, a turn
 * already running in the same session, and an agent that isn't there. The
 * session and loop are set up the same way for each of them too. A plugin that called `runAgentLoop` itself
 * skipped every one of those.
 *
 * A turn with a `room` goes to the room watcher, which the host wires in with
 * `setRoomWaker`. The room applies its own turn order and hourly ceiling, as
 * it does for a subscription delivered there.
 */
import { getExploratoryState } from "../db/exploratory-queries.js";
import { ROOM_WATCHER_DEFAULTS } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { resolveAgent } from "./agents.js";
import { runAgentLoop } from "./loop.js";
import { findOrCreateSession } from "./session.js";

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

/** A turn for `wakeAgent`: the prompt, why it runs, and where, a session or a room. */
export type WakeAgentOptions = {
  prompt: string;
  wake: Wake;
} & ({ sessionKey: string; room?: undefined } | { room: string; sessionKey?: undefined });

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
  /** `<agent> <session key>` for every woken turn still running. */
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
    if (opts.room === undefined && opts.sessionKey === undefined) {
      throw new Error(`wakeAgent("${agent}") needs a sessionKey or a room.`);
    }
    if (host.isAgentsPaused("autonomous")) return "paused";

    const definition = host.getAgentDefinition(agent);
    // The base agent answers to "default" whether or not one is declared, as it
    // does everywhere else an agent is named.
    if (!definition && agent !== "default") return "gone";
    // An online agent switched off or paused on the Agents page takes no turns
    // of its own. Both are a person's switch and both can be undone, so the
    // wake waits rather than being thrown away.
    if (definition?.online?.enabled && this.ownPause(agent)) return "paused";

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

    // Two turns at once in one session would interleave their history. Checked
    // before the ceiling, so a wake turned away here costs none of the hour.
    const key = `${agent} ${opts.sessionKey}`;
    if (this.running.has(key)) return "at-ceiling";

    const config = host.getConfig();
    const limit = config.rooms?.maxWakesPerHour ?? ROOM_WATCHER_DEFAULTS.maxWakesPerHour;
    const t = this.now();
    const recent = (this.wakes.get(agent) ?? []).filter((at) => t - at < HOUR_MS);
    if (recent.length >= limit) {
      this.wakes.set(agent, recent);
      console.warn(`[wake] ${agent} is at its wake ceiling (${limit}/hour); not woken for ${describeWake(opts.wake)}.`);
      return "at-ceiling";
    }
    recent.push(t);
    this.wakes.set(agent, recent);

    this.running.add(key);
    try {
      const name = definition ? agent : undefined;
      const resolved = resolveAgent(
        name,
        config,
        host.getResolvableTools(),
        undefined,
        host.contextDir,
        undefined,
        host.buildResolveOptions(),
      );
      const session = findOrCreateSession(host.db, opts.sessionKey, resolved.model, resolved.provider);
      console.log(`[wake] waking ${agent} in ${opts.sessionKey} for ${describeWake(opts.wake)}`);
      host.events.emit("agent.woken", { agent, wake: opts.wake, targetKind: "session", target: opts.sessionKey });
      await runAgentLoop(opts.prompt, host.buildLoopOptions({ session, agentName: name, wake: opts.wake }));
    } finally {
      this.running.delete(key);
    }
    return "ran";
  }

  /** Whether an online agent's own switch is off, or its own pause hasn't run out. */
  private ownPause(agent: string): boolean {
    const own = getExploratoryState(this.host.db, agent);
    if (!own) return false;
    if (!own.enabled) return true;
    return own.paused_until !== null && Date.parse(own.paused_until) > this.now();
  }
}

/** `subscription`, or `upkeep (commitment/lisbon)`: for logs. */
export function describeWake(wake: Wake): string {
  return wake.ref ? `${wake.kind} (${wake.ref})` : wake.kind;
}
