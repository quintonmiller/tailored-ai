import type Database from "better-sqlite3";

/**
 * Operational telemetry for every exploratory / heartbeat tick.
 * Lives in a separate table from `notes` by design — this never
 * enters semantic recall.
 *
 * Conventional `kind` values (open TEXT — add more without ALTER):
 *   - `start`     — tick begins; tick_id is now valid
 *   - `noop`      — agent decided no action this tick (Sleep)
 *   - `material`  — agent did real work this tick; summary is one-line
 *   - `delegate`  — agent delegated to a specialist
 *   - `workflow`  — agent invoked a workflow
 *   - `error`     — tick crashed; summary is the error message
 */
export interface TickLogRow {
  id: number;
  tick_id: string;
  agent: string;
  project_id: string | null;
  kind: string;
  summary: string | null;
  payload: string | null;
  created_at: string;
}

export interface TickLogInput {
  tick_id: string;
  agent: string;
  project_id?: string | null;
  kind: string;
  summary?: string | null;
  /** Anything JSON-serializable; stored as TEXT. */
  payload?: unknown;
}

export function appendTickLog(
  db: Database.Database,
  input: TickLogInput,
): TickLogRow {
  const payload =
    input.payload === undefined
      ? null
      : typeof input.payload === "string"
        ? input.payload
        : JSON.stringify(input.payload);
  const res = db
    .prepare(
      `INSERT INTO tick_log (tick_id, agent, project_id, kind, summary, payload)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.tick_id,
      input.agent,
      input.project_id ?? null,
      input.kind,
      input.summary ?? null,
      payload,
    ) as TickLogRow;
  return res;
}

export interface TickLogQuery {
  tick_id?: string;
  agent?: string;
  kind?: string | string[];
  since?: string;     // ISO datetime
  limit?: number;
}

export function listTickLogs(
  db: Database.Database,
  q: TickLogQuery = {},
): TickLogRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.tick_id) { clauses.push("tick_id = ?"); params.push(q.tick_id); }
  if (q.agent)   { clauses.push("agent = ?");   params.push(q.agent); }
  if (q.kind) {
    if (Array.isArray(q.kind)) {
      const placeholders = q.kind.map(() => "?").join(",");
      clauses.push(`kind IN (${placeholders})`);
      params.push(...q.kind);
    } else {
      clauses.push("kind = ?");
      params.push(q.kind);
    }
  }
  if (q.since)   { clauses.push("created_at >= ?"); params.push(q.since); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = q.limit && q.limit > 0 ? `LIMIT ${Math.floor(q.limit)}` : "";
  const sql = `SELECT * FROM tick_log ${where} ORDER BY created_at DESC ${limit}`;
  return db.prepare(sql).all(...params) as TickLogRow[];
}

/**
 * Outcomes rollup for the "Stagnation check" / "Outcomes last window"
 * section of TickContext. Counts ticks by kind over the last N ticks
 * (default 20) for a given agent.
 */
export interface TickOutcomesWindow {
  ticks: number;
  byKind: Record<string, number>;
  materialTicks: number;
  noopTicks: number;
  stagnation: boolean;
  windowStart: string | null;
  windowEnd: string | null;
}

export function getTickOutcomesWindow(
  db: Database.Database,
  agent: string,
  windowTicks = 20,
): TickOutcomesWindow {
  // Pull the last N distinct tick_ids (a tick can have multiple rows —
  // e.g. start + material + delegate). Then aggregate kinds over those.
  const recentTickIds = db
    .prepare(
      `SELECT tick_id, MAX(created_at) AS last_seen
       FROM tick_log
       WHERE agent = ?
       GROUP BY tick_id
       ORDER BY last_seen DESC
       LIMIT ?`,
    )
    .all(agent, windowTicks) as Array<{ tick_id: string; last_seen: string }>;

  if (recentTickIds.length === 0) {
    return {
      ticks: 0, byKind: {}, materialTicks: 0, noopTicks: 0,
      stagnation: false, windowStart: null, windowEnd: null,
    };
  }

  const placeholders = recentTickIds.map(() => "?").join(",");
  const counts = db
    .prepare(
      `SELECT kind, COUNT(DISTINCT tick_id) AS n
       FROM tick_log
       WHERE tick_id IN (${placeholders})
       GROUP BY kind`,
    )
    .all(...recentTickIds.map((r) => r.tick_id)) as Array<{ kind: string; n: number }>;

  const byKind = Object.fromEntries(counts.map(({ kind, n }) => [kind, n]));
  const materialTicks = (byKind.material ?? 0) + (byKind.delegate ?? 0) + (byKind.workflow ?? 0);
  const noopTicks = byKind.noop ?? 0;
  // "Stagnation" = at least half the window, nothing material happened.
  const stagnation = recentTickIds.length >= Math.floor(windowTicks / 2) && materialTicks === 0;

  return {
    ticks: recentTickIds.length,
    byKind,
    materialTicks,
    noopTicks,
    stagnation,
    windowStart: recentTickIds[recentTickIds.length - 1].last_seen,
    windowEnd: recentTickIds[0].last_seen,
  };
}

/**
 * Delete tick_log rows older than `keepDays`. Returns the number of
 * rows removed. Default retention is 30 days.
 */
export function sweepOldTickLogs(
  db: Database.Database,
  keepDays = 30,
): number {
  const res = db
    .prepare(
      `DELETE FROM tick_log
       WHERE datetime(created_at) < datetime('now', ?)`,
    )
    .run(`-${Math.floor(keepDays)} days`);
  return res.changes;
}
