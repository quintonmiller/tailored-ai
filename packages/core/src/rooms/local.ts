/**
 * The built-in `local` room backend: rooms that live entirely in SQLite.
 *
 * Every other backend is a capability of a live transport, which makes rooms
 * untestable and unusable until one is configured and connected. This one has
 * no network at all, so the room mechanism (addressing, cursors, wake budget)
 * can be exercised on a bare database — and agents get somewhere to talk that
 * does not spam a real Discord server while they learn to.
 */

import type Database from "better-sqlite3";
import type { MediaRef } from "../content/types.js";
import { formatEnvelope, parseEnvelope } from "./envelope.js";
import type { RoomStore } from "./store.js";
import {
  type CreateRoomOptions,
  formatRoomRef,
  type OutboundRoomMessage,
  type Room,
  type RoomBackend,
  type RoomCapabilities,
  type RoomMember,
  type RoomMessage,
  type RoomRef,
} from "./types.js";

interface MessageRow {
  id: number;
  room_ref: string;
  author_id: string;
  author_label: string;
  content: string;
  /** JSON array of MediaRef, or null on every message that carried none. */
  media: string | null;
  created_at: string;
}

/**
 * Cursors are compared as strings by the store (see `RoomStore.advanceCursor`),
 * but `room_messages.id` is an AUTOINCREMENT integer, and "10" sorts before "9".
 * Zero-padding restores insertion order under lexical comparison. 16 digits is
 * well past what SQLite's signed rowid can reach in any real deployment.
 */
const CURSOR_WIDTH = 16;

function toCursor(id: number): string {
  return String(id).padStart(CURSOR_WIDTH, "0");
}

/** Room names are free text; native ids have to be safe in a `local:<id>` ref. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class LocalRoomBackend implements RoomBackend {
  readonly id = "local";
  readonly capabilities: RoomCapabilities = {
    create: true,
    members: true,
    push: true,
    // No display-name concept here — identity rides the "[speaker]" prefix.
    nativeSpeakers: false,
    // Parents are stored but not rendered; a reader sees a flat log.
    threads: false,
    edit: true,
    reactions: false,
    history: true,
    // Nowhere to file a retired room: there is no channel list to tidy. The
    // archive is complete in the database either way.
    archive: false,
    // Refs, not bytes: the media store already holds the blob, so carrying an
    // attachment here is one more column. Supporting it makes the seam real
    // rather than Discord-only, which is what lets the watcher's media path be
    // tested without a gateway.
    media: true,
  };

  private readonly handlers = new Set<(message: RoomMessage) => void>();

  constructor(
    private readonly db: Database.Database,
    private readonly store: RoomStore,
  ) {}

  // ----------------------------------------------------------------- rooms

  async createRoom(opts: CreateRoomOptions): Promise<Room> {
    const name = opts.name.trim();
    const room = this.store.upsertRoom(
      { ref: { backend: this.id, id: this.uniqueNativeId(name) }, name, purpose: opts.purpose },
      opts.createdBy,
    );

    // Seeded members are kind "unknown": the backend has no view of the
    // deployment's identities, so it cannot say whether "coder" is an agent or
    // a person. Whoever holds the IdentityResolver refines this later.
    const ref = formatRoomRef(room.ref);
    for (const member of opts.members ?? []) {
      this.store.putMember(ref, { id: member, label: member, kind: "unknown" });
    }
    return room;
  }

  async listRooms(): Promise<Room[]> {
    return this.store.listRooms().filter((room) => room.ref.backend === this.id);
  }

  async getRoom(id: string): Promise<Room | null> {
    return this.store.getRoomByRef({ backend: this.id, id });
  }

  // -------------------------------------------------------------- messages

  async post(id: string, message: OutboundRoomMessage): Promise<RoomMessage | null> {
    const room = this.requireRoom(id);
    const ref = formatRoomRef(room.ref);
    const content = formatEnvelope({ speaker: message.speaker, to: message.to, body: message.body });

    // There is no bot account here, so the speaker label doubles as the author
    // id. Transport backends have a real account id to put in this column.
    const author = message.speaker ?? "unknown";
    const info = this.db
      .prepare("INSERT INTO room_messages (room_ref, author_id, author_label, content, media) VALUES (?, ?, ?, ?, ?)")
      .run(ref, author, author, content, message.media?.length ? JSON.stringify(message.media) : null);

    // Read back rather than reconstruct, so created_at is the value SQLite's
    // datetime('now') default actually wrote.
    const row = this.db.prepare("SELECT * FROM room_messages WHERE id = ?").get(info.lastInsertRowid) as MessageRow;

    const stored = this.toMessage(room.ref, row);
    this.notify(stored);
    return stored;
  }

  async edit(_id: string, messageId: string, body: string): Promise<void> {
    const info = this.db.prepare("UPDATE room_messages SET content = ? WHERE id = ?").run(body, Number(messageId));
    if (info.changes === 0) throw new Error(`No message ${messageId} to edit.`);
  }

  async fetchSince(id: string, cursor: string | null, limit: number): Promise<RoomMessage[]> {
    const room = this.requireRoom(id);
    const ref = formatRoomRef(room.ref);
    const after = parseCursor(cursor);

    const rows =
      after === null
        ? // No cursor means "catch me up", not "replay the room from the top" —
          // take the newest `limit` and flip them back into send order.
          (this.db
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM room_messages WHERE room_ref = ? ORDER BY id DESC LIMIT ?
               ) ORDER BY id ASC`,
            )
            .all(ref, limit) as MessageRow[])
        : (this.db
            .prepare("SELECT * FROM room_messages WHERE room_ref = ? AND id > ? ORDER BY id ASC LIMIT ?")
            .all(ref, after, limit) as MessageRow[]);

    return rows.map((row) => this.toMessage(room.ref, row));
  }

  /**
   * Subscribe to posts made through this backend. Delivery is in-process and
   * synchronous — nothing external can write to `room_messages`, so there is
   * no gateway event to wait on and no ordering hazard.
   */
  onMessage(handler: (message: RoomMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  // --------------------------------------------------------------- members

  async listMembers(id: string): Promise<RoomMember[]> {
    return this.store.listMembers(formatRoomRef(this.requireRoom(id).ref));
  }

  async addMember(id: string, memberId: string): Promise<void> {
    const ref = formatRoomRef(this.requireRoom(id).ref);
    this.store.putMember(ref, { id: memberId, label: memberId, kind: "unknown" });
  }

  // ------------------------------------------------------------- internals

  private requireRoom(id: string): Room {
    const room = this.store.getRoomByRef({ backend: this.id, id });
    if (!room) throw new Error(`No local room "${id}". Create it first, or check the name.`);
    return room;
  }

  /** First free slug for `name`, then `-2`, `-3`, ... on collision. */
  private uniqueNativeId(name: string): string {
    const base = slugify(name) || "room";
    let candidate = base;
    for (let n = 2; this.store.getRoomByRef({ backend: this.id, id: candidate }); n += 1) {
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  private toMessage(ref: RoomRef, row: MessageRow): RoomMessage {
    // Deliberately no isKnown predicate: the backend does not know the
    // deployment's identities. The room watcher re-parses with an
    // identity-aware predicate before deciding who was addressed, so a body
    // that merely opens with "[note]" can only be misread in this raw view.
    const parsed = parseEnvelope(row.content);
    // A row written before this column existed, or by a caller that attached
    // nothing, reads as null. Malformed JSON is dropped rather than thrown:
    // one bad row must not make a whole backlog unreadable.
    let media: MediaRef[] = [];
    if (row.media) {
      try {
        const parsedMedia: unknown = JSON.parse(row.media);
        if (Array.isArray(parsedMedia)) media = parsedMedia as MediaRef[];
      } catch {
        console.warn(`[rooms:local] message ${row.id} has unreadable media metadata; ignoring it.`);
      }
    }
    return {
      id: String(row.id),
      room: ref,
      cursor: toCursor(row.id),
      raw: row.content,
      body: parsed.body,
      speaker: parsed.speaker,
      to: parsed.to,
      mentions: [],
      authorId: row.author_id,
      authorLabel: row.author_label,
      // No bot user exists here, so "was this us?" is unanswerable at this
      // layer. The watcher decides self-ness from the speaker label instead.
      fromSelf: false,
      ...(media.length ? { media } : {}),
      createdAt: row.created_at,
    };
  }

  private notify(message: RoomMessage): void {
    // Snapshot: a handler is allowed to unsubscribe itself while being called.
    for (const handler of [...this.handlers]) {
      try {
        handler(message);
      } catch (err) {
        // The row is already committed and the poster has nothing to retry, so
        // a broken subscriber must not turn a successful post into a failure.
        console.error(`[rooms:local] Message handler failed: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Cursors this backend emits are a zero-padded row id, so parsing one back to
 * an integer is lossless and lets the (room_ref, id) index do the filtering.
 * Anything else is treated as absent rather than throwing — a corrupt cursor
 * should cost an agent some context, not wedge its subscription.
 */
function parseCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) ? n : null;
}
