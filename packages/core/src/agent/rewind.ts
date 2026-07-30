import type Database from "better-sqlite3";

/**
 * Take a conversation back to how it stood N turns ago.
 *
 * The blunt version of this already existed: `/room reset` detaches the
 * session key and starts a fresh session, which is right when a conversation
 * is a total loss and wrong every other time. Most conversations that go bad
 * go bad at an identifiable point — an agent misreads one instruction and
 * spends six turns compounding it, a tool returns something that poisons every
 * later answer, a room falls into two agents being polite at each other. What
 * you want then is to drop the tail, not the history.
 *
 * Nothing is deleted. A rewound message keeps its row and gains a
 * `rewound_batch` number; `getSessionMessages` skips stamped rows, so the model
 * stops seeing them while the transcript stays intact and {@link undoRewind}
 * can put them back. Deleting would make the operation unauditable and
 * unrecoverable, and "I rewound one turn too many" is the obvious mistake to
 * make with a command like this.
 */

/** A turn begins at a `user` message and runs until the next one. */
const TURN_ROLE = "user";

export interface RewindPreview {
  /** Turns that would be (or were) dropped — may be fewer than asked if the session is short. */
  turns: number;
  /** Messages in those turns, including the assistant and tool rows. */
  messages: number;
  /** When the earliest dropped message was written. */
  from: string;
  /** Opening of the earliest dropped user message, so a caller can confirm the cut lands where they meant. */
  excerpt: string;
}

interface Row {
  id: number;
  created_at: string;
  content: string | null;
}

function sessionIdsForKey(db: Database.Database, sessionKey: string): string[] {
  const rows = db.prepare("SELECT id FROM sessions WHERE key = ?").all(sessionKey) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * The id of the first message to drop, or null when there is nothing to take
 * back. Already-rewound rows are excluded from the count so repeated rewinds
 * compose instead of each one re-counting turns the model can no longer see.
 */
function cutPoint(db: Database.Database, sessionIds: string[], turns: number): number | null {
  if (sessionIds.length === 0 || turns < 1) return null;
  const placeholders = sessionIds.map(() => "?").join(",");
  const starts = db
    .prepare(
      `SELECT id FROM messages
        WHERE session_id IN (${placeholders}) AND role = ? AND rewound_batch IS NULL
        ORDER BY id DESC LIMIT ?`,
    )
    .all(...sessionIds, TURN_ROLE, turns) as { id: number }[];
  if (starts.length === 0) return null;
  return starts[starts.length - 1].id;
}

function describe(db: Database.Database, sessionIds: string[], fromId: number, turns: number): RewindPreview {
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, created_at, content FROM messages
        WHERE session_id IN (${placeholders}) AND id >= ? AND rewound_batch IS NULL
        ORDER BY id ASC`,
    )
    .all(...sessionIds, fromId) as Row[];

  const first = rows[0];
  const excerpt = (first?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  return {
    turns,
    messages: rows.length,
    from: first?.created_at ?? "",
    excerpt,
  };
}

/** What {@link rewindSession} would do, without doing it. */
export function previewRewind(db: Database.Database, sessionKey: string, turns: number): RewindPreview | null {
  const sessionIds = sessionIdsForKey(db, sessionKey);
  const fromId = cutPoint(db, sessionIds, turns);
  if (fromId === null) return null;
  const available = countTurns(db, sessionIds);
  return describe(db, sessionIds, fromId, Math.min(turns, available));
}

/** Turns still visible to the model. */
export function countTurns(db: Database.Database, sessionIds: string[]): number {
  if (sessionIds.length === 0) return 0;
  const placeholders = sessionIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE session_id IN (${placeholders}) AND role = ? AND rewound_batch IS NULL`,
    )
    .get(...sessionIds, TURN_ROLE) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Hide the last `turns` turns. Returns what was dropped, or null if there was
 * nothing to drop.
 *
 * Every message in one rewind shares a `rewound_batch` number, which is what makes
 * {@link undoRewind} able to restore exactly one step rather than everything
 * ever rewound.
 */
export function rewindSession(db: Database.Database, sessionKey: string, turns: number): RewindPreview | null {
  const sessionIds = sessionIdsForKey(db, sessionKey);
  const fromId = cutPoint(db, sessionIds, turns);
  if (fromId === null) return null;

  const available = countTurns(db, sessionIds);
  const summary = describe(db, sessionIds, fromId, Math.min(turns, available));
  const placeholders = sessionIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE messages SET rewound_batch = ?
      WHERE session_id IN (${placeholders}) AND id >= ? AND rewound_batch IS NULL`,
  ).run(nextBatch(db, sessionIds), ...sessionIds, fromId);
  return summary;
}

/**
 * Put back the most recent rewind. Only that one — rewinding twice and undoing
 * once should land you one step back, not where you started.
 */
export function undoRewind(db: Database.Database, sessionKey: string): { restored: number; batch: number } | null {
  const sessionIds = sessionIdsForKey(db, sessionKey);
  if (sessionIds.length === 0) return null;
  const placeholders = sessionIds.map(() => "?").join(",");

  const latest = db
    .prepare(`SELECT MAX(rewound_batch) AS batch FROM messages WHERE session_id IN (${placeholders})`)
    .get(...sessionIds) as { batch: number | null } | undefined;
  if (!latest?.batch) return null;

  const result = db
    .prepare(`UPDATE messages SET rewound_batch = NULL WHERE session_id IN (${placeholders}) AND rewound_batch = ?`)
    .run(...sessionIds, latest.batch);
  return { restored: result.changes, batch: latest.batch };
}

/**
 * The next rewind number for this conversation.
 *
 * Derived from the rows rather than a clock: undo has to restore exactly one
 * rewind, and two rewinds in the same millisecond share a timestamp. Ordering
 * that decides correctness should not depend on clock resolution.
 */
function nextBatch(db: Database.Database, sessionIds: string[]): number {
  const placeholders = sessionIds.map(() => "?").join(",");
  const row = db
    .prepare(`SELECT MAX(rewound_batch) AS batch FROM messages WHERE session_id IN (${placeholders})`)
    .get(...sessionIds) as { batch: number | null } | undefined;
  return (row?.batch ?? 0) + 1;
}
