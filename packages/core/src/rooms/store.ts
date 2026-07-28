/**
 * SQLite persistence for the room directory, subscriptions and read cursors.
 *
 * Backends own message transport; this owns everything TAI needs to remember
 * across restarts: which rooms exist under which names, who watches them, how
 * far each watcher has read, and how many times a watcher has been woken this
 * hour.
 */

import type Database from "better-sqlite3";
import { formatRoomRef, type Room, type RoomMember, type RoomRef } from "./types.js";

export type WakeOn = "named" | "addressed" | "all" | "none";
export type Deliver = "push" | "poll";

export interface RoomSubscription {
  id: number;
  agent: string;
  roomRef: string;
  deliver: Deliver;
  wakeOn: WakeOn;
  pollSeconds: number | null;
  /** Wake every N minutes regardless of traffic. Null means only on messages. */
  checkInMinutes: number | null;
  lastCheckIn: string | null;
  cursor: string | null;
  /** "config" rows are rewritten from config on every reconcile; "agent" rows persist. */
  source: "config" | "agent";
  lastWokeAt: string | null;
  hourBucket: string | null;
  wakesThisHour: number;
}

interface RoomRow {
  ref: string;
  backend: string;
  native_id: string;
  name: string;
  purpose: string | null;
  created_by: string | null;
  created_at: string;
}

interface SubscriptionRow {
  id: number;
  agent: string;
  room_ref: string;
  deliver: string;
  wake_on: string;
  poll_seconds: number | null;
  check_in_minutes: number | null;
  last_check_in: string | null;
  cursor: string | null;
  source: string;
  last_woke_at: string | null;
  hour_bucket: string | null;
  wakes_this_hour: number;
}

function toRoom(row: RoomRow): Room {
  return {
    ref: { backend: row.backend, id: row.native_id },
    name: row.name,
    purpose: row.purpose ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
  };
}

function toSubscription(row: SubscriptionRow): RoomSubscription {
  return {
    id: row.id,
    agent: row.agent,
    roomRef: row.room_ref,
    deliver: row.deliver === "poll" ? "poll" : "push",
    wakeOn: ((): WakeOn => {
      switch (row.wake_on) {
        case "all":
        case "none":
        case "named":
          return row.wake_on;
        default:
          return "addressed";
      }
    })(),
    pollSeconds: row.poll_seconds,
    checkInMinutes: row.check_in_minutes,
    lastCheckIn: row.last_check_in,
    cursor: row.cursor,
    source: row.source === "agent" ? "agent" : "config",
    lastWokeAt: row.last_woke_at,
    hourBucket: row.hour_bucket,
    wakesThisHour: row.wakes_this_hour,
  };
}

export class RoomStore {
  constructor(private readonly db: Database.Database) {}

  // ---------------------------------------------------------------- rooms

  /**
   * Record a room under a name. Re-registering the same ref updates its name
   * and purpose; a name already taken by a DIFFERENT ref is rejected so two
   * rooms can never answer to one handle.
   */
  upsertRoom(room: Room, createdBy?: string): Room {
    const ref = formatRoomRef(room.ref);
    const clash = this.db.prepare("SELECT ref FROM rooms WHERE name = ? AND ref != ?").get(room.name, ref) as
      | { ref: string }
      | undefined;
    if (clash) {
      throw new Error(
        `Room name "${room.name}" is already used by ${clash.ref}. Pick another name or remove that room first.`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO rooms (ref, backend, native_id, name, purpose, created_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET
           name    = excluded.name,
           purpose = COALESCE(excluded.purpose, rooms.purpose)`,
      )
      .run(ref, room.ref.backend, room.ref.id, room.name, room.purpose ?? null, createdBy ?? room.createdBy ?? null);

    return this.getRoomByRef(room.ref)!;
  }

  getRoomByRef(ref: RoomRef | string): Room | null {
    const key = typeof ref === "string" ? ref : formatRoomRef(ref);
    const row = this.db.prepare("SELECT * FROM rooms WHERE ref = ?").get(key) as RoomRow | undefined;
    return row ? toRoom(row) : null;
  }

  getRoomByName(name: string): Room | null {
    const row = this.db.prepare("SELECT * FROM rooms WHERE name = ?").get(name.trim()) as RoomRow | undefined;
    return row ? toRoom(row) : null;
  }

  /**
   * Resolve either a registered name ("eng") or a raw ref
   * ("discord:14673...") to a room. Names are tried first so a rename never
   * silently resolves to a stale ref.
   */
  resolve(nameOrRef: string): Room | null {
    return this.getRoomByName(nameOrRef) ?? this.getRoomByRef(nameOrRef);
  }

  listRooms(): Room[] {
    const rows = this.db.prepare("SELECT * FROM rooms ORDER BY name").all() as RoomRow[];
    return rows.map(toRoom);
  }

  /**
   * Move a room's registration to a new backend ref, keeping its name,
   * subscriptions and membership.
   *
   * Config is authoritative about which destination a name points at, so
   * correcting a ref (or pointing at a recreated channel) must re-point rather
   * than collide with the old row. Cursors are cleared because they are
   * backend-specific position markers — a Discord snowflake means nothing in
   * the channel it did not come from.
   */
  repointRoom(fromRef: string, to: RoomRef): void {
    const toRef = formatRoomRef(to);
    if (fromRef === toRef) return;
    const move = this.db.transaction(() => {
      this.db.prepare("DELETE FROM rooms WHERE ref = ?").run(toRef);
      this.db
        .prepare("UPDATE rooms SET ref = ?, backend = ?, native_id = ? WHERE ref = ?")
        .run(toRef, to.backend, to.id, fromRef);
      this.db
        .prepare("UPDATE OR REPLACE room_subscriptions SET room_ref = ?, cursor = NULL WHERE room_ref = ?")
        .run(toRef, fromRef);
      this.db.prepare("UPDATE OR REPLACE room_members SET room_ref = ? WHERE room_ref = ?").run(toRef, fromRef);
    });
    move();
  }

  removeRoom(ref: RoomRef | string): void {
    const key = typeof ref === "string" ? ref : formatRoomRef(ref);
    this.db.prepare("DELETE FROM room_subscriptions WHERE room_ref = ?").run(key);
    this.db.prepare("DELETE FROM room_members WHERE room_ref = ?").run(key);
    this.db.prepare("DELETE FROM rooms WHERE ref = ?").run(key);
  }

  // --------------------------------------------------------- subscriptions

  /**
   * Create or update a subscription. `cursor` is deliberately NOT reset on
   * update: a config reload must not make an agent re-read and re-answer
   * everything it had already seen.
   */
  subscribe(input: {
    agent: string;
    roomRef: string;
    deliver?: Deliver;
    wakeOn?: WakeOn;
    pollSeconds?: number | null;
    checkInMinutes?: number | null;
    source?: "config" | "agent";
    /** Starting cursor for brand-new subscriptions only. */
    initialCursor?: string | null;
  }): RoomSubscription {
    this.db
      .prepare(
        `INSERT INTO room_subscriptions
           (agent, room_ref, deliver, wake_on, poll_seconds, check_in_minutes, source, cursor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent, room_ref) DO UPDATE SET
           deliver          = excluded.deliver,
           wake_on          = excluded.wake_on,
           poll_seconds     = excluded.poll_seconds,
           check_in_minutes = COALESCE(excluded.check_in_minutes, room_subscriptions.check_in_minutes),
           source           = excluded.source`,
      )
      .run(
        input.agent,
        input.roomRef,
        input.deliver ?? "push",
        input.wakeOn ?? "addressed",
        input.pollSeconds ?? null,
        input.checkInMinutes ?? null,
        input.source ?? "agent",
        input.initialCursor ?? null,
      );
    return this.getSubscription(input.agent, input.roomRef)!;
  }

  unsubscribe(agent: string, roomRef: string): boolean {
    const info = this.db.prepare("DELETE FROM room_subscriptions WHERE agent = ? AND room_ref = ?").run(agent, roomRef);
    return info.changes > 0;
  }

  getSubscription(agent: string, roomRef: string): RoomSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM room_subscriptions WHERE agent = ? AND room_ref = ?")
      .get(agent, roomRef) as SubscriptionRow | undefined;
    return row ? toSubscription(row) : null;
  }

  listSubscriptionsForAgent(agent: string): RoomSubscription[] {
    const rows = this.db
      .prepare("SELECT * FROM room_subscriptions WHERE agent = ? ORDER BY room_ref")
      .all(agent) as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  listSubscriptionsForRoom(roomRef: string): RoomSubscription[] {
    const rows = this.db
      .prepare("SELECT * FROM room_subscriptions WHERE room_ref = ? ORDER BY agent")
      .all(roomRef) as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  listSubscriptions(): RoomSubscription[] {
    const rows = this.db
      .prepare("SELECT * FROM room_subscriptions ORDER BY room_ref, agent")
      .all() as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  /** Drop config-sourced subscriptions that are no longer declared. */
  pruneConfigSubscriptions(keep: Array<{ agent: string; roomRef: string }>): number {
    const keepKeys = new Set(keep.map((k) => `${k.agent} ${k.roomRef}`));
    const existing = this.db
      .prepare("SELECT id, agent, room_ref FROM room_subscriptions WHERE source = 'config'")
      .all() as Array<{ id: number; agent: string; room_ref: string }>;
    const stmt = this.db.prepare("DELETE FROM room_subscriptions WHERE id = ?");
    let removed = 0;
    for (const row of existing) {
      if (keepKeys.has(`${row.agent} ${row.room_ref}`)) continue;
      stmt.run(row.id);
      removed += 1;
    }
    return removed;
  }

  /**
   * Move a subscriber's read cursor forward. Never moves it backwards, so an
   * out-of-order delivery cannot make an agent re-read old traffic.
   */
  advanceCursor(agent: string, roomRef: string, cursor: string): void {
    this.db
      .prepare(
        `UPDATE room_subscriptions
            SET cursor = ?
          WHERE agent = ? AND room_ref = ?
            AND (cursor IS NULL OR cursor < ?)`,
      )
      .run(cursor, agent, roomRef, cursor);
  }

  /** Stamp a check-in so the next one is measured from now. */
  recordCheckIn(agent: string, roomRef: string): void {
    this.db
      .prepare("UPDATE room_subscriptions SET last_check_in = datetime('now') WHERE agent = ? AND room_ref = ?")
      .run(agent, roomRef);
  }

  // --------------------------------------------------------------- webhooks

  /**
   * Remember a transport credential that lets each agent post under its own
   * display name. Kept in the database rather than config because it is a
   * secret, and because a config write would bounce the transport connection.
   */
  setWebhook(roomRef: string, webhook: { id: string; token: string } | null): void {
    this.db
      .prepare("UPDATE rooms SET webhook_id = ?, webhook_token = ? WHERE ref = ?")
      .run(webhook?.id ?? null, webhook?.token ?? null, roomRef);
  }

  getWebhook(roomRef: string): { id: string; token: string } | null {
    const row = this.db.prepare("SELECT webhook_id, webhook_token FROM rooms WHERE ref = ?").get(roomRef) as
      | { webhook_id: string | null; webhook_token: string | null }
      | undefined;
    if (!row?.webhook_id || !row.webhook_token) return null;
    return { id: row.webhook_id, token: row.webhook_token };
  }

  /** Every webhook id we own, so inbound traffic can be told apart from foreign webhooks. */
  knownWebhookIds(): Set<string> {
    const rows = this.db.prepare("SELECT webhook_id FROM rooms WHERE webhook_id IS NOT NULL").all() as Array<{
      webhook_id: string;
    }>;
    return new Set(rows.map((r) => r.webhook_id));
  }

  // ------------------------------------------------------- conversation depth

  /**
   * Record that a message was seen, and return how many consecutive turns the
   * agents have taken without a human.
   *
   * The hourly ceiling bounds a runaway, but it does not stop the specific
   * failure this counts: two agents being polite at each other. "Thanks" ->
   * "no problem" -> "great" is not a loop any single-message rule can see, and
   * each turn legitimately addresses the other. A human speaking resets it,
   * because that is the signal the conversation is going somewhere.
   */
  noteRoomTurn(roomRef: string, fromHuman: boolean, speaker?: string): number {
    if (fromHuman) {
      this.db.prepare("UPDATE rooms SET agent_turns = 0, last_speaker = ? WHERE ref = ?").run(speaker ?? null, roomRef);
      return 0;
    }

    // A turn is a contiguous run from one speaker, not one transport message.
    // Anything past 2000 characters is split into several Discord messages, so
    // counting messages made one long answer look like three turns and drove
    // the room into its depth cap while a single agent was still talking.
    const row = this.db.prepare("SELECT last_speaker FROM rooms WHERE ref = ?").get(roomRef) as
      | { last_speaker: string | null }
      | undefined;
    if (speaker !== undefined && row?.last_speaker === speaker) return this.agentTurns(roomRef);

    this.db
      .prepare("UPDATE rooms SET agent_turns = agent_turns + 1, last_speaker = ? WHERE ref = ?")
      .run(speaker ?? null, roomRef);
    return this.agentTurns(roomRef);
  }

  /**
   * Clear the agent-only turn count because real work happened.
   *
   * The depth cap exists to stop two agents being polite at each other, and it
   * cannot tell that apart from two agents collaborating — both look like
   * agents talking without a human. Tool use is the discriminator: an agent
   * that researched, wrote a file or queried something is making progress, not
   * filling silence.
   */
  resetAgentTurns(roomRef: string): void {
    this.db.prepare("UPDATE rooms SET agent_turns = 0 WHERE ref = ?").run(roomRef);
  }

  agentTurns(roomRef: string): number {
    const row = this.db.prepare("SELECT agent_turns FROM rooms WHERE ref = ?").get(roomRef) as
      | { agent_turns: number }
      | undefined;
    return row?.agent_turns ?? 0;
  }

  // ------------------------------------------------------------ wake budget

  /**
   * Consume one wake from the subscription's hourly allowance.
   *
   * This is the brake on agent-to-agent runaway: supervisor pings coder, coder
   * replies, supervisor replies... Without a hard ceiling that loop only stops
   * when the model does, which is to say never. Returns false when the budget
   * for this clock hour is spent.
   */
  tryConsumeWake(agent: string, roomRef: string, maxPerHour: number): boolean {
    // One statement, so the check and the increment cannot interleave. Doing
    // it as SELECT-then-UPDATE in JS let two concurrent wakes both read the
    // same count and both proceed, which is precisely the case the ceiling
    // exists to stop.
    const info = this.db
      .prepare(
        `UPDATE room_subscriptions
            SET hour_bucket     = strftime('%Y-%m-%dT%H', 'now'),
                wakes_this_hour = CASE
                                    WHEN hour_bucket = strftime('%Y-%m-%dT%H', 'now')
                                    THEN wakes_this_hour + 1
                                    ELSE 1
                                  END,
                last_woke_at    = datetime('now')
          WHERE agent = ? AND room_ref = ?
            AND (CASE
                   WHEN hour_bucket = strftime('%Y-%m-%dT%H', 'now')
                   THEN wakes_this_hour
                   ELSE 0
                 END) < ?`,
      )
      .run(agent, roomRef, maxPerHour);
    return info.changes > 0;
  }

  // --------------------------------------------------------------- members

  putMember(roomRef: string, member: RoomMember): void {
    this.db
      .prepare(
        `INSERT INTO room_members (room_ref, member_id, label, kind)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_ref, member_id) DO UPDATE SET
           label = excluded.label,
           kind  = excluded.kind`,
      )
      .run(roomRef, member.id, member.label, member.kind);
  }

  listMembers(roomRef: string): RoomMember[] {
    const rows = this.db
      .prepare("SELECT member_id, label, kind FROM room_members WHERE room_ref = ? ORDER BY label")
      .all(roomRef) as Array<{ member_id: string; label: string; kind: string }>;
    return rows.map((r) => ({
      id: r.member_id,
      label: r.label,
      kind: r.kind === "agent" ? "agent" : r.kind === "human" ? "human" : "unknown",
    }));
  }

  removeMember(roomRef: string, memberId: string): boolean {
    const info = this.db
      .prepare("DELETE FROM room_members WHERE room_ref = ? AND member_id = ?")
      .run(roomRef, memberId);
    return info.changes > 0;
  }
}
