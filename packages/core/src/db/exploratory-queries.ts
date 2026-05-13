import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ExploratoryRunStatus = "running" | "ok" | "noop" | "budget" | "error";

export interface ExploratoryState {
  agent_name: string;
  enabled: boolean;
  paused_until: string | null;
  last_tick_at: string | null;
  last_tick_status: string | null;
  current_interval_ms: number | null;
  tokens_today: number;
  tokens_today_resets_at: string | null;
  runs_today: number;
  updated_at: string;
}

interface ExploratoryStateRow {
  agent_name: string;
  enabled: number;
  paused_until: string | null;
  last_tick_at: string | null;
  last_tick_status: string | null;
  current_interval_ms: number | null;
  tokens_today: number;
  tokens_today_resets_at: string | null;
  runs_today: number;
  updated_at: string;
}

function rowToState(row: ExploratoryStateRow): ExploratoryState {
  return { ...row, enabled: row.enabled === 1 };
}

export function getExploratoryState(
  db: Database.Database,
  agentName: string,
): ExploratoryState | null {
  const row = db
    .prepare("SELECT * FROM exploratory_state WHERE agent_name = ?")
    .get(agentName) as ExploratoryStateRow | undefined;
  return row ? rowToState(row) : null;
}

export function listExploratoryStates(db: Database.Database): ExploratoryState[] {
  const rows = db
    .prepare("SELECT * FROM exploratory_state ORDER BY agent_name ASC")
    .all() as ExploratoryStateRow[];
  return rows.map(rowToState);
}

/**
 * Returns an existing row or inserts a default one. Use this on agent first-touch
 * so the rest of the worker can `UPDATE ... WHERE agent_name = ?` without
 * branching on null.
 */
export function ensureExploratoryState(
  db: Database.Database,
  agentName: string,
): ExploratoryState {
  const existing = getExploratoryState(db, agentName);
  if (existing) return existing;
  db.prepare("INSERT INTO exploratory_state (agent_name) VALUES (?)").run(agentName);
  return getExploratoryState(db, agentName)!;
}

export interface ExploratoryStateUpdate {
  enabled?: boolean;
  paused_until?: string | null;
  last_tick_at?: string | null;
  last_tick_status?: string | null;
  current_interval_ms?: number | null;
  tokens_today?: number;
  tokens_today_resets_at?: string | null;
  runs_today?: number;
}

export function updateExploratoryState(
  db: Database.Database,
  agentName: string,
  updates: ExploratoryStateUpdate,
): ExploratoryState {
  ensureExploratoryState(db, agentName);
  const fields: string[] = [];
  const values: unknown[] = [];
  const keys: (keyof ExploratoryStateUpdate)[] = [
    "paused_until",
    "last_tick_at",
    "last_tick_status",
    "current_interval_ms",
    "tokens_today",
    "tokens_today_resets_at",
    "runs_today",
  ];
  for (const k of keys) {
    if (updates[k] !== undefined) {
      fields.push(`${k} = ?`);
      values.push(updates[k]);
    }
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    db.prepare(
      `UPDATE exploratory_state SET ${fields.join(", ")} WHERE agent_name = ?`,
    ).run(...values, agentName);
  }
  return getExploratoryState(db, agentName)!;
}

/**
 * Resets `runs_today` / `tokens_today` when the day has rolled over.
 * Uses local-day rollover via `date('now')`. Returns the (possibly updated) state.
 */
export function maybeResetDailyCounters(
  db: Database.Database,
  agentName: string,
): ExploratoryState {
  const state = ensureExploratoryState(db, agentName);
  const today = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;
  if (state.tokens_today_resets_at !== today) {
    return updateExploratoryState(db, agentName, {
      tokens_today: 0,
      runs_today: 0,
      tokens_today_resets_at: today,
    });
  }
  return state;
}

export interface ExploratoryRun {
  id: string;
  agent_name: string;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: ExploratoryRunStatus;
  tokens_used: number | null;
  tool_calls: number | null;
  note_ids: string[];
  fact_ids: string[];
  task_ids: string[];
  notified_owner: boolean;
  summary: string | null;
  error: string | null;
}

interface ExploratoryRunRow {
  id: string;
  agent_name: string;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: ExploratoryRunStatus;
  tokens_used: number | null;
  tool_calls: number | null;
  note_ids: string;
  fact_ids: string;
  task_ids: string;
  notified_owner: number;
  summary: string | null;
  error: string | null;
}

function rowToRun(row: ExploratoryRunRow): ExploratoryRun {
  return {
    ...row,
    note_ids: safeParseArray(row.note_ids),
    fact_ids: safeParseArray(row.fact_ids),
    task_ids: safeParseArray(row.task_ids),
    notified_owner: row.notified_owner === 1,
  };
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface CreateExploratoryRunInput {
  agentName: string;
  projectId?: string | null;
}

export function createExploratoryRun(
  db: Database.Database,
  input: CreateExploratoryRunInput,
): ExploratoryRun {
  const id = `xrun_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO exploratory_runs (id, agent_name, project_id, status)
     VALUES (?, ?, ?, 'running')`,
  ).run(id, input.agentName, input.projectId ?? null);
  return getExploratoryRun(db, id)!;
}

export function getExploratoryRun(
  db: Database.Database,
  id: string,
): ExploratoryRun | null {
  const row = db.prepare("SELECT * FROM exploratory_runs WHERE id = ?").get(id) as
    | ExploratoryRunRow
    | undefined;
  return row ? rowToRun(row) : null;
}

export interface CompleteExploratoryRunInput {
  status: ExploratoryRunStatus;
  tokensUsed?: number;
  toolCalls?: number;
  noteIds?: string[];
  factIds?: string[];
  taskIds?: string[];
  notifiedOwner?: boolean;
  summary?: string;
  error?: string;
}

export function completeExploratoryRun(
  db: Database.Database,
  id: string,
  input: CompleteExploratoryRunInput,
): ExploratoryRun {
  db.prepare(
    `UPDATE exploratory_runs SET
       ended_at = datetime('now'),
       status = ?,
       tokens_used = COALESCE(?, tokens_used),
       tool_calls = COALESCE(?, tool_calls),
       note_ids = COALESCE(?, note_ids),
       fact_ids = COALESCE(?, fact_ids),
       task_ids = COALESCE(?, task_ids),
       notified_owner = COALESCE(?, notified_owner),
       summary = COALESCE(?, summary),
       error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(
    input.status,
    input.tokensUsed ?? null,
    input.toolCalls ?? null,
    input.noteIds ? JSON.stringify(input.noteIds) : null,
    input.factIds ? JSON.stringify(input.factIds) : null,
    input.taskIds ? JSON.stringify(input.taskIds) : null,
    input.notifiedOwner === undefined ? null : input.notifiedOwner ? 1 : 0,
    input.summary ?? null,
    input.error ?? null,
    id,
  );
  return getExploratoryRun(db, id)!;
}

export interface ListExploratoryRunsOptions {
  agentName?: string;
  projectId?: string | null;
  status?: ExploratoryRunStatus;
  limit?: number;
}

export function listExploratoryRuns(
  db: Database.Database,
  opts: ListExploratoryRunsOptions = {},
): ExploratoryRun[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.agentName) {
    where.push("agent_name = ?");
    values.push(opts.agentName);
  }
  if (opts.projectId !== undefined) {
    if (opts.projectId === null) {
      where.push("project_id IS NULL");
    } else {
      where.push("project_id = ?");
      values.push(opts.projectId);
    }
  }
  if (opts.status) {
    where.push("status = ?");
    values.push(opts.status);
  }
  const sql = `SELECT * FROM exploratory_runs ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY started_at DESC LIMIT ?`;
  values.push(opts.limit ?? 50);
  const rows = db.prepare(sql).all(...values) as ExploratoryRunRow[];
  return rows.map(rowToRun);
}
