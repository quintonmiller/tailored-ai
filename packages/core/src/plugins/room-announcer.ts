/**
 * Room announcer — says out loud who is in the room.
 *
 * Membership used to be a thing you had to go and ask about. An agent called
 * `channel-manager` created a room, stayed subscribed to it because creating a
 * room subscribes you, and went on receiving everything said there long after
 * it had any reason to. `/room members` would have shown it the whole time.
 * Nobody had a reason to look, because nothing had ever suggested there was
 * anything to see.
 *
 * Slack solves this by putting the fact in the transcript, where it is read by
 * everyone who reads the room and by nobody who does not have to. This does the
 * same: one short line when an agent joins, one when it leaves, and a different
 * one for the case above — the agent that created a room and put itself in it.
 *
 * Announcing is a workflow opinion, not a property of rooms, so it lives here
 * rather than in `rooms/store.ts`. Core emits `room.membership_changed`;
 * whether that becomes a message, a log line or nothing is this plugin's call,
 * and a deployment that wants none of it disables the plugin.
 *
 * ## What it must not do
 *
 * **Announce config-declared subscriptions.** `rooms.subscriptions` is
 * re-applied on every reconcile and every startup, and a fresh database applies
 * all of them at once. Treating those as news would post a wall of joins on
 * each boot, which is how a feature meant to make membership visible would
 * instead teach everyone to ignore it. `source: "config"` is dropped here, and
 * the store already declines to emit for a re-subscribe that changed nothing.
 *
 * **Fail loudly.** A room that has been deleted, or a transport that is not
 * connected, is an ordinary state. Nothing here is important enough to throw
 * out of an event handler over.
 */

import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import { getRoomBackend } from "../rooms/registry.js";
import { parseRoomRef, type Room } from "../rooms/types.js";
import type { AgentRuntime } from "../runtime.js";

/** Seconds after a room opens during which its creator's join reads as "created it". */
const DEFAULT_CREATION_WINDOW_SECONDS = 10;

export interface RoomAnnouncerConfig {
  /**
   * Identity the announcement is posted under. It is not an agent talking, so
   * the default reads as the room describing itself.
   */
  speaker?: string;
  /**
   * How long after a room is created the creator's own join still counts as
   * "created this room and joined it". Default 10 seconds — creation and the
   * creator's subscribe are two statements apart, so this only has to cover a
   * slow transport call, not a session.
   */
  creationWindowSeconds?: number;
  /** Announce joins. Default true. */
  announceJoins?: boolean;
  /** Announce leaves. Default true. */
  announceLeaves?: boolean;
}

/**
 * Parse a SQLite timestamp as the UTC it actually is.
 *
 * `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` with no zone marker, and
 * `Date` reads that as local time — which in any non-UTC deployment would put
 * every room's creation hours away from the join that followed it, and the
 * creator's join would never be recognised as one.
 */
export function parseRoomTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}

export interface RoomAnnouncerOptions extends RoomAnnouncerConfig {
  runtime: AgentRuntime;
  /** Injectable clock, so the creation window is testable without sleeping. */
  now?: () => number;
}

export class RoomAnnouncer {
  private readonly runtime: AgentRuntime;
  private readonly speaker: string;
  private readonly creationWindowMs: number;
  private readonly announceJoins: boolean;
  private readonly announceLeaves: boolean;
  private readonly now: () => number;
  private readonly subscription: Subscription;

  constructor(opts: RoomAnnouncerOptions) {
    this.runtime = opts.runtime;
    this.speaker = opts.speaker ?? "room";
    this.creationWindowMs = (opts.creationWindowSeconds ?? DEFAULT_CREATION_WINDOW_SECONDS) * 1000;
    this.announceJoins = opts.announceJoins ?? true;
    this.announceLeaves = opts.announceLeaves ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.subscription = this.runtime.events.on("room.membership_changed", (e) => this.announce(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  /**
   * The line a change gets, or null when it gets none. Exposed for tests: the
   * interesting behaviour is which sentence a change produces, and asserting
   * that through a fake transport tests the transport.
   */
  lineFor(room: Room, e: RuntimeEventPayload<"room.membership_changed">): string | null {
    if (e.source === "config") return null;
    if (e.change === "left") return this.announceLeaves ? `**${e.agent}** left this room.` : null;
    if (!this.announceJoins) return null;
    return this.isCreatorJoin(room, e.agent)
      ? `**${e.agent}** created this room and joined it.`
      : `**${e.agent}** joined this room.`;
  }

  /**
   * The exact case that went unnoticed: the agent that opened the room is in
   * it, because opening one subscribes you. Worth its own sentence — "joined"
   * suggests a decision someone made about this room, and this is a side
   * effect of creating it.
   */
  private isCreatorJoin(room: Room, agent: string): boolean {
    if (!room.createdBy || room.createdBy !== agent) return false;
    const createdAt = parseRoomTimestamp(room.createdAt);
    if (createdAt === undefined) return false;
    const age = this.now() - createdAt;
    // A second of slack on the low side: the clock is SQLite's, not ours.
    return age >= -1000 && age <= this.creationWindowMs;
  }

  private async announce(e: RuntimeEventPayload<"room.membership_changed">): Promise<void> {
    // Config subscriptions are re-applied on every reconcile. Checked before
    // anything else so the suppressed path costs no queries.
    if (e.source === "config") return;

    const room = this.runtime.getRoomStore().resolve(e.roomRef);
    if (!room) return;
    const ref = parseRoomRef(`${room.ref.backend}:${room.ref.id}`);
    const backend = ref ? getRoomBackend(ref.backend) : undefined;
    if (!ref || !backend) return;

    const line = this.lineFor(room, e);
    if (!line) return;

    try {
      // No `to`, so this reaches the transcript without waking anyone who was
      // not already watching everything. Membership is worth reading, not
      // worth an interrupt.
      await backend.post(ref.id, { body: line, speaker: this.speaker });
    } catch (err) {
      console.warn(`[room-announcer] could not announce in ${e.roomRef}: ${(err as Error).message}`);
    }
  }
}

/**
 * Default-plugin entry point — loaded via `config.plugins: builtin:room-announcer`.
 * Reads optional `speaker`, `creationWindowSeconds`, `announceJoins`,
 * `announceLeaves` from `ctx.config`.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const cfg = ctx.config;
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const announcer = new RoomAnnouncer({
    runtime: ctx.runtime,
    speaker: typeof cfg.speaker === "string" ? cfg.speaker : undefined,
    creationWindowSeconds: typeof cfg.creationWindowSeconds === "number" ? cfg.creationWindowSeconds : undefined,
    announceJoins: bool(cfg.announceJoins),
    announceLeaves: bool(cfg.announceLeaves),
  });
  return () => announcer.stop();
};

export const meta: PluginMeta = {
  name: "Room announcer",
  description:
    "Posts a line in a room when an agent joins or leaves it, so membership is readable in the transcript instead of only via `/room members`.",
  registers: [{ kind: "eventSubscriber", id: "room-announcer" }],
};

export default plugin;
