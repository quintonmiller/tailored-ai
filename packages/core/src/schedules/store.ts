/**
 * Persistence for agent-authored wakes.
 *
 * Times are stored the way the rest of the schema stores them: SQLite
 * `datetime()` text in UTC, no zone marker, so `next_run_at <= datetime('now')`
 * is a plain indexed comparison and the tick needs no clock of its own.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ScheduleKind = "once" | "repeat";
export type ScheduleStatus = "pending" | "done" | "cancelled" | "expired";
export type ScheduleTargetKind = "room" | "session";

export interface ScheduleRow {
  id: string;
  agent: string;
  note: string;
  kind: ScheduleKind;
  cron: string | null;
  interval_seconds: number | null;
  source: string;
  starts_at: string | null;
  ends_at: string | null;
  next_run_at: string;
  target_kind: ScheduleTargetKind;
  target: string;
  status: ScheduleStatus;
  run_count: number;
  deferrals: number;
  last_run_at: string | null;
  created_at: string;
}

export interface NewSchedule {
  agent: string;
  note: string;
  kind: ScheduleKind;
  cron?: string | null;
  intervalSeconds?: number | null;
  source: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  nextRunAt: Date;
  targetKind: ScheduleTargetKind;
  target: string;
}

/**
 * Short, pronounceable, and unique enough for a per-agent list that is capped
 * at twenty. A model has to copy this back to cancel; a full UUID is where that
 * goes wrong.
 */
function shortId(db: Database.Database): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = randomUUID().replace(/-/g, "").slice(0, 4);
    const clash = db.prepare("SELECT 1 FROM agent_schedules WHERE id = ?").get(id);
    if (!clash) return id;
  }
  return randomUUID().slice(0, 8);
}

/** UTC `YYYY-MM-DD HH:MM:SS`, matching `datetime('now')`. */
export function toDbTime(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ");
}

/** Parse a stored UTC timestamp back to a Date. */
export function fromDbTime(text: string): Date {
  return new Date(`${text.replace(" ", "T")}Z`);
}

export class ScheduleStore {
  constructor(private readonly db: Database.Database) {}

  create(input: NewSchedule): ScheduleRow {
    const id = shortId(this.db);
    this.db
      .prepare(
        `INSERT INTO agent_schedules
           (id, agent, note, kind, cron, interval_seconds, source, starts_at, ends_at,
            next_run_at, target_kind, target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agent,
        input.note,
        input.kind,
        input.cron ?? null,
        input.intervalSeconds ?? null,
        input.source,
        input.startsAt ? toDbTime(input.startsAt) : null,
        input.endsAt ? toDbTime(input.endsAt) : null,
        toDbTime(input.nextRunAt),
        input.targetKind,
        input.target,
      );
    return this.get(id)!;
  }

  get(id: string): ScheduleRow | undefined {
    return this.db.prepare("SELECT * FROM agent_schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
  }

  /** Live schedules for one agent, soonest first. */
  listForAgent(agent: string): ScheduleRow[] {
    return this.db
      .prepare("SELECT * FROM agent_schedules WHERE agent = ? AND status = 'pending' ORDER BY next_run_at")
      .all(agent) as ScheduleRow[];
  }

  countForAgent(agent: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM agent_schedules WHERE agent = ? AND status = 'pending'")
      .get(agent) as { n: number };
    return row.n;
  }

  /**
   * Everything due as of `now`. Bounded so one tick cannot try to start
   * hundreds of agent turns at once — the rest are still due and come back on
   * the next tick.
   *
   * Takes the time rather than using `datetime('now')` so the caller's clock is
   * the only clock. With the comparison in SQL, a runner with an injected clock
   * would still select rows against the wall clock, and every timing rule here
   * would be untestable without actually waiting.
   */
  listDue(now: Date, limit = 25): ScheduleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_schedules
          WHERE status = 'pending' AND next_run_at <= ?
          ORDER BY next_run_at LIMIT ?`,
      )
      .all(toDbTime(now), limit) as ScheduleRow[];
  }

  /**
   * Claim a due row: move it out of the due set, in one statement, before
   * anything is dispatched.
   *
   * The `status = 'pending'` predicate is the claim. Two ticks racing the same
   * row produce one winner, and `changes === 0` tells the loser to skip rather
   * than double-wake the agent.
   *
   * Deliberately does not touch `run_count` or `deferrals`. Claiming means the
   * row will not be picked up again, not that a turn happened — a wake the room
   * then refuses is not a run, and counting it as one would both misreport the
   * run number back to the agent and reset the deferral counter that is meant
   * to stop it retrying for ever.
   */
  claim(id: string, next: { nextRunAt: Date | null; status: ScheduleStatus }): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_schedules
            SET status = ?, next_run_at = COALESCE(?, next_run_at)
          WHERE id = ? AND status = 'pending'`,
      )
      .run(next.status, next.nextRunAt ? toDbTime(next.nextRunAt) : null, id);
    return result.changes > 0;
  }

  /** A turn actually ran. Clears the deferral streak. */
  markRan(id: string): void {
    this.db
      .prepare(
        "UPDATE agent_schedules SET run_count = run_count + 1, deferrals = 0, last_run_at = datetime('now') WHERE id = ?",
      )
      .run(id);
  }

  /** Push a due row back without counting it as a run. Used when a wake is refused. */
  defer(id: string, until: Date): void {
    this.db
      .prepare("UPDATE agent_schedules SET next_run_at = ?, deferrals = deferrals + 1 WHERE id = ?")
      .run(toDbTime(until), id);
  }

  setStatus(id: string, status: ScheduleStatus): void {
    this.db.prepare("UPDATE agent_schedules SET status = ? WHERE id = ?").run(status, id);
  }

  /** Cancel by id, scoped to the owning agent so one cannot cancel another's. */
  cancel(agent: string, ids: string[]): string[] {
    const cancelled: string[] = [];
    const stmt = this.db.prepare(
      "UPDATE agent_schedules SET status = 'cancelled' WHERE id = ? AND agent = ? AND status = 'pending'",
    );
    for (const id of ids) {
      if (stmt.run(id, agent).changes > 0) cancelled.push(id);
    }
    return cancelled;
  }

  cancelAll(agent: string): number {
    return this.db
      .prepare("UPDATE agent_schedules SET status = 'cancelled' WHERE agent = ? AND status = 'pending'")
      .run(agent).changes;
  }
}
