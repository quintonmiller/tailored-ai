/**
 * Rooms: multi-party conversation destinations shared by several agents and
 * humans.
 *
 * Terminology, because the word "channel" is already spoken for:
 *   - a **channel** is a transport integration (Discord, Slack) — `channels/`
 *   - a **room** is a named destination *within* a transport that more than one
 *     participant shares (a Discord channel, a Slack channel, a local room)
 *   - a **session** is one participant's private history — still per-agent, and
 *     a room gives each subscribed agent its own session
 *
 * Core owns the mechanism (addressing, membership, subscriptions, cursors,
 * wake policy). It owns none of the behavior: what an agent says, when it
 * escalates, and who watches what are config, prompts and plugins.
 */

/**
 * A room address. Rendered as `<backend>:<id>` — e.g.
 * `discord:1234567890123456789` or `local:standup`.
 */
export interface RoomRef {
  backend: string;
  id: string;
}

/** Render a {@link RoomRef} in its canonical `<backend>:<id>` string form. */
export function formatRoomRef(ref: RoomRef): string {
  return `${ref.backend}:${ref.id}`;
}

/**
 * Parse a canonical room ref. Only the FIRST colon separates — transport ids
 * are free to contain colons (Matrix room ids look like `!abc:server.tld`).
 * Returns null for anything that isn't `<backend>:<id>` with both sides
 * non-empty.
 */
export function parseRoomRef(raw: string): RoomRef | null {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(":");
  if (sep <= 0 || sep === trimmed.length - 1) return null;
  return { backend: trimmed.slice(0, sep), id: trimmed.slice(sep + 1) };
}

export interface Room {
  ref: RoomRef;
  /** Short handle agents and humans use to name the room ("eng", "standup"). */
  name: string;
  purpose?: string;
  /** TAI identity that opened the room, when it was opened through TAI. */
  createdBy?: string;
  createdAt?: string;
  /**
   * When this room was retired. Undefined means live.
   *
   * An archived room stops waking anyone — no polls, no check-ins, no push —
   * while keeping its transcript and every subscription's cursor, role and
   * cadence, so bringing it back restores the room rather than an empty shell.
   * It stays readable by name or ref and refuses writes, and it releases its
   * name so a new room can take it.
   */
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
}

export type RoomMemberKind = "agent" | "human" | "unknown";

export interface RoomMember {
  /** Backend-native member id (a Discord user id), or a TAI identity label. */
  id: string;
  label: string;
  kind: RoomMemberKind;
}

export interface RoomMessage {
  /** Backend-native message id. */
  id: string;
  room: RoomRef;
  /**
   * Opaque, orderable position marker. Callers hand the last one they saw back
   * to {@link RoomBackend.fetchSince}. Compared as a STRING by the store, so
   * backends must emit values that sort lexicographically in send order —
   * zero-padded counters or Discord snowflakes both qualify.
   */
  cursor: string;
  /** Text exactly as it sits on the transport, envelope prefix included. */
  raw: string;
  /** The message with its `[speaker] <addressee>` envelope removed. */
  body: string;
  /** TAI identity that spoke, when one could be determined. */
  speaker?: string;
  /** TAI identities this message addresses. Empty means "the room". */
  to: string[];
  /**
   * Identities named anywhere in the body, including mid-sentence. A superset
   * of `to` in practice: "@coder you're up" at the end of a paragraph is a real
   * call-out even though the message is formally addressed elsewhere.
   */
  mentions: string[];
  /** Backend-native author id. Every agent post shares the bot's own id. */
  authorId: string;
  authorLabel: string;
  /** True when the transport reports this as our own bot user's message. */
  fromSelf: boolean;
  createdAt: string;
}

export interface OutboundRoomMessage {
  /** The message body, without an envelope — the backend adds it. */
  body: string;
  /**
   * Attach this message underneath an existing one rather than posting it at
   * the top level.
   *
   * Deliberately expressed as "a message can have a parent" and not as
   * "Discord threads": the room seam should not know what a thread is. A
   * transport that can nest renders it however it nests — Discord opens a
   * thread on the parent, another might quote or indent. One that cannot
   * declares `threads: false` and the caller decides whether to post flat or
   * not at all, rather than silently losing the nesting.
   */
  parentId?: string;
  /** TAI identity doing the talking. Stamped by core, never by the model. */
  speaker?: string;
  /** TAI identities being addressed. */
  to?: string[];
  /**
   * Whether addressing a person should actually interrupt them.
   *
   * Posting and pinging are different acts. The room is the record — an agent
   * should write to it freely, and someone reads it when they choose. A
   * notification is an interrupt, and interrupts are only worth it when the
   * agent genuinely needs that person. Default false: the name appears in the
   * transcript without a notification behind it.
   */
  notify?: boolean;
}

export interface CreateRoomOptions {
  name: string;
  purpose?: string;
  /** Backend-native ids or TAI identity labels to seed membership with. */
  members?: string[];
  /** TAI identity that asked for the room. */
  createdBy?: string;
}

/**
 * What a backend can actually do. Callers feature-detect through this rather
 * than duck-typing methods, so an unsupported action fails with a clear
 * message instead of a TypeError.
 */
export interface RoomCapabilities {
  /** Can open new rooms on the transport. */
  create: boolean;
  /** Can enumerate, and possibly modify, membership. */
  members: boolean;
  /** Emits new messages through onMessage. False forces subscribers to poll. */
  push: boolean;
  /** Can return messages older than the caller's cursor. */
  history: boolean;
  /** Can attach a message underneath another (Discord threads, say). */
  threads: boolean;
  /** Can change a message it already sent. */
  edit: boolean;
  /** Can mark a message without posting one. */
  reactions: boolean;
  /**
   * The transport can render each speaker as its own participant — a Discord
   * webhook posting under a per-message `username`, say. When true the backend
   * carries identity natively and does NOT need a `[speaker]` text prefix; the
   * envelope falls back to that prefix only where this is false.
   */
  nativeSpeakers: boolean;
}

/**
 * The seam. A room backend is usually a capability of a live transport
 * (`Channel.rooms`), but it does not have to be — the built-in `local` backend
 * is pure SQLite and needs no network at all, which is what makes rooms
 * testable and usable before any transport is configured.
 */
export interface RoomBackend {
  /** Stable id, and the `<backend>` half of every ref this backend owns. */
  readonly id: string;
  readonly capabilities: RoomCapabilities;

  listRooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | null>;

  /** Post to a room. Returns the stored message when the backend echoes one. */
  post(id: string, message: OutboundRoomMessage): Promise<RoomMessage | null>;

  /**
   * Messages after `cursor`, oldest first, at most `limit`. A null cursor
   * means "the most recent `limit` messages" — NOT the entire history.
   */
  fetchSince(id: string, cursor: string | null, limit: number): Promise<RoomMessage[]>;

  /**
   * Replace the body of a message this backend sent.
   *
   * Append-only rooms make a recurring update post a new message every time, so
   * a check-in that runs hourly is an hourly notification whether or not
   * anything changed. Editing lets one message BE the status.
   */
  edit?(id: string, messageId: string, body: string): Promise<void>;

  /**
   * Mark a message without posting one.
   *
   * Acknowledgement otherwise costs a whole turn, which is what produces
   * "Roger." and "Standing by." A reaction says the same thing without adding
   * a message, waking anyone, or counting toward the conversation-depth cap.
   */
  react?(id: string, messageId: string, emoji: string): Promise<void>;

  createRoom?(opts: CreateRoomOptions): Promise<Room>;
  /**
   * Mirror the room's purpose onto the transport, where one has a place for it
   * — Discord shows it as the channel topic. Optional: a transport with no
   * such field simply omits this, and the purpose still reaches agents.
   */
  setPurpose?(id: string, purpose: string): Promise<void>;
  listMembers?(id: string): Promise<RoomMember[]>;
  addMember?(id: string, memberId: string): Promise<void>;
  removeMember?(id: string, memberId: string): Promise<void>;

  /**
   * Subscribe to live messages. Returns an unsubscribe function. Present only
   * when `capabilities.push` is true.
   */
  onMessage?(handler: (message: RoomMessage) => void): () => void;
}

/** How soon a repeat of the same point is allowed to be raised again. */
export type RoomUrgency = "high" | "medium" | "low";

/**
 * Default re-raise windows, in hours. Deliberately soft: the posting agent
 * picks the urgency, and the notification gate only enforces the window for
 * messages that repeat something already said. Nothing here stops an agent
 * from saying something NEW at any time.
 */
export const DEFAULT_URGENCY_WINDOW_HOURS: Record<RoomUrgency, number> = {
  high: 0.25, // 15 minutes
  medium: 24, // daily
  low: 168, // weekly
};
