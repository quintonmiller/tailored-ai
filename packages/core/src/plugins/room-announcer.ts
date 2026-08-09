/**
 * Room announcer — says out loud who is in the room.
 *
 * Membership used to be a thing you had to go and ask about. An agent called
 * A `room-keeper` agent created a room, stayed subscribed to it because creating a
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
  /**
   * Announce a room being retired or brought back. Default true.
   *
   * Louder than a join by design: archiving stops the room waking *everyone*
   * in it, on the judgement of whoever archived it. Without a line in the
   * transcript the others find out by never being woken again, which is
   * indistinguishable from a bug.
   */
  announceArchive?: boolean;
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
  private readonly announceArchive: boolean;
  private readonly now: () => number;
  private readonly subscriptions: Subscription[];

  constructor(opts: RoomAnnouncerOptions) {
    this.runtime = opts.runtime;
    this.speaker = opts.speaker ?? "room";
    this.creationWindowMs = (opts.creationWindowSeconds ?? DEFAULT_CREATION_WINDOW_SECONDS) * 1000;
    this.announceJoins = opts.announceJoins ?? true;
    this.announceLeaves = opts.announceLeaves ?? true;
    this.announceArchive = opts.announceArchive ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.subscriptions = [
      this.runtime.events.on("room.membership_changed", (e) => this.announce(e)),
      this.runtime.events.on("room.archived", (e) =>
        this.say(e.roomRef, this.archiveLineFor(e.by, e.reason), { evenIfArchived: true }),
      ),
      this.runtime.events.on("room.unarchived", (e) => this.say(e.roomRef, this.unarchiveLineFor(e.by))),
    ];
  }

  stop(): void {
    for (const sub of this.subscriptions) sub.dispose();
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
    await this.say(e.roomRef, line);
  }

  /**
   * Put one line in a room.
   *
   * `evenIfArchived` exists for exactly one case: the archive announcement
   * itself, which is emitted after the flag is set and would otherwise be the
   * one message that never gets written. It reaches the transcript and wakes
   * nobody — the watcher drops traffic in archived rooms — which is precisely
   * what is wanted for a notice people read and agents do not act on.
   */
  private async say(roomRef: string, line: string | null, opts?: { evenIfArchived?: boolean }): Promise<void> {
    if (!line) return;
    const store = this.runtime.getRoomStore();
    const room = store.resolve(roomRef);
    if (!room) return;
    if (room.archivedAt && !opts?.evenIfArchived) return;

    const ref = parseRoomRef(`${room.ref.backend}:${room.ref.id}`);
    const backend = ref ? getRoomBackend(ref.backend) : undefined;
    if (!ref || !backend) return;

    try {
      // No `to`, so this reaches the transcript without waking anyone who was
      // not already watching everything. Membership is worth reading, not
      // worth an interrupt.
      await backend.post(ref.id, { body: line, speaker: this.speaker });
    } catch (err) {
      console.warn(`[room-announcer] could not announce in ${roomRef}: ${(err as Error).message}`);
    }
  }

  /** Exposed so the archive wording is assertable without a fake transport. */
  archiveLineFor(by?: string, reason?: string): string | null {
    return this.announceArchive ? archiveLine(by, reason) : null;
  }

  unarchiveLineFor(by?: string): string | null {
    return this.announceArchive ? unarchiveLine(by) : null;
  }
}

// The line is posted in the room it is about, so naming the room would only
// repeat what the reader is already looking at.
function archiveLine(by?: string, reason?: string): string {
  const who = by ? `**${by}**` : "Someone";
  const why = reason ? ` — ${reason}` : "";
  return `${who} archived this room${why}. It stops waking anyone here; the messages stay readable.`;
}

function unarchiveLine(by?: string): string {
  const who = by ? `**${by}**` : "Someone";
  return `${who} reopened this room. Everyone who watched it before is watching it again.`;
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
    announceArchive: bool(cfg.announceArchive),
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
