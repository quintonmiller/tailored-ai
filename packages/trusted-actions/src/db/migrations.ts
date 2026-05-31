import type Database from "better-sqlite3";

export const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    input_json TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    completed_at TEXT,
    result_json TEXT,
    error TEXT
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS approvals (
    action_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    approved INTEGER
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    before TEXT,
    after TEXT,
    context TEXT,
    hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // Cleartext approval token, kept so the PWA's GET /pending fallback
  // can return a working decide payload when iOS skips SW
  // notificationclick. Trade-off: an attacker who reads the SQLite
  // file gets pending tokens (1h TTL). That same attacker already has
  // shell access, so they can run anything else anyway — net no new
  // attack surface above the existing baseline.
  `
  ALTER TABLE approvals ADD COLUMN token_cleartext TEXT;
  `,
  // Subscription approval status. New subscriptions arrive as
  // 'pending' and never receive pushes until the operator approves
  // them via the TAI dashboard. Existing rows get a one-time
  // grandfather backfill to 'active' so currently-trusted devices
  // continue to work after the upgrade.
  `
  ALTER TABLE push_subscriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
  `,
  `
  ALTER TABLE push_subscriptions ADD COLUMN user_agent TEXT;
  `,
  `
  ALTER TABLE push_subscriptions ADD COLUMN decided_at TEXT;
  `,
  // Backfill — runs once at first startup after the upgrade. Idempotent
  // because the WHERE excludes rows we've already touched.
  `
  UPDATE push_subscriptions SET status = 'active' WHERE status = 'pending' AND created_at < datetime('now', '-1 minute');
  `,
  // Callback URL — when the action enters a terminal state, the
  // executor POSTs to this URL with { action_id, status, result?,
  // error?, session_id }. TAI uses it to inject a system message
  // back into the chat session that enqueued the action.
  `
  ALTER TABLE actions ADD COLUMN callback_url TEXT;
  `,
];

export function migrate(db: Database.Database): void {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      // Idempotency: ALTER TABLE can't be expressed as IF NOT EXISTS
      // in SQLite, so re-running a migration that already applied
      // raises "duplicate column name". That's harmless — swallow it.
      const msg = (err as Error).message || "";
      if (/duplicate column name|already exists/i.test(msg)) continue;
      throw err;
    }
  }
}
