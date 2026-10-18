/**
 * Events waiting to be delivered.
 *
 * Kept in SQLite rather than in memory so a restart does not lose them: a
 * digest due at 7am still arrives after the box rebooted at 3am, and an event
 * held back by the wake ceiling is still there when the ceiling resets.
 */
import type Database from "better-sqlite3";
import type { DeliveredEvent, DeliveryMode } from "./types.js";

interface PendingRow {
  id: number;
  sub_key: string;
  agent: string;
  mode: DeliveryMode;
  event: string;
  summary: string;
  at: string;
}

export class SubscriptionStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_pending (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        sub_key  TEXT NOT NULL,
        agent    TEXT NOT NULL,
        mode     TEXT NOT NULL,
        event    TEXT NOT NULL,
        summary  TEXT NOT NULL,
        at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_subscription_pending_key ON subscription_pending(sub_key, id);
      CREATE INDEX IF NOT EXISTS idx_subscription_pending_agent ON subscription_pending(agent, mode);
    `);
  }

  add(subKey: string, agent: string, mode: DeliveryMode, event: DeliveredEvent): void {
    this.db
      .prepare("INSERT INTO subscription_pending (sub_key, agent, mode, event, summary, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(subKey, agent, mode, event.event, event.summary, event.at);
  }

  /** Put events back at the front, after a delivery that could not run. */
  restore(subKey: string, agent: string, mode: DeliveryMode, events: DeliveredEvent[]): void {
    const insert = this.db.prepare(
      "INSERT INTO subscription_pending (sub_key, agent, mode, event, summary, at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      for (const e of events) insert.run(subKey, agent, mode, e.event, e.summary, e.at);
    })();
  }

  /** Every event waiting for one subscription, oldest first, removed as it is read. */
  take(subKey: string): DeliveredEvent[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM subscription_pending WHERE sub_key = ? ORDER BY at, id")
        .all(subKey) as PendingRow[];
      this.db.prepare("DELETE FROM subscription_pending WHERE sub_key = ?").run(subKey);
      return rows.map(toEvent);
    })();
  }

  /** Recorded events for an agent's next turn, oldest first, removed as they are read. */
  takeRecorded(agent: string, limit: number): DeliveredEvent[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM subscription_pending WHERE agent = ? AND mode = 'record' ORDER BY at, id LIMIT ?")
        .all(agent, limit) as PendingRow[];
      if (rows.length) {
        this.db
          .prepare(`DELETE FROM subscription_pending WHERE id IN (${rows.map(() => "?").join(", ")})`)
          .run(...rows.map((r) => r.id));
      }
      return rows.map(toEvent);
    })();
  }

  countRecorded(agent: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM subscription_pending WHERE agent = ? AND mode = 'record'")
      .get(agent) as { n: number };
    return row.n;
  }

  /** Subscription keys with something waiting, and when the oldest arrived. */
  pendingKeys(): { subKey: string; oldestAt: string; mode: DeliveryMode }[] {
    return (
      this.db
        .prepare(
          "SELECT sub_key AS subKey, MIN(at) AS oldestAt, MIN(mode) AS mode FROM subscription_pending GROUP BY sub_key",
        )
        .all() as { subKey: string; oldestAt: string; mode: DeliveryMode }[]
    ).filter((r) => r.mode !== "record");
  }

  /** Drop everything waiting for a subscription that no longer exists. */
  discard(subKey: string): number {
    return this.db.prepare("DELETE FROM subscription_pending WHERE sub_key = ?").run(subKey).changes;
  }

  /** Every key with anything waiting, including recorded events. */
  allKeys(): string[] {
    return (this.db.prepare("SELECT DISTINCT sub_key FROM subscription_pending").all() as { sub_key: string }[]).map(
      (r) => r.sub_key,
    );
  }
}

function toEvent(row: PendingRow): DeliveredEvent {
  return { event: row.event, summary: row.summary, at: row.at };
}
