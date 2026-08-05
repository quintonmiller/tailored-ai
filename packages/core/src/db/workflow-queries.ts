import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export type WorkflowStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type WorkflowTrigger = "http" | "cron" | "webhook" | "tool" | "programmatic";

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  trigger: WorkflowTrigger;
  input: unknown;
  output: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  generation: number;
}

export interface WorkflowStep {
  id: string;
  run_id: string;
  step_name: string;
  step_type: string;
  status: WorkflowStepStatus;
  attempt: number;
  output: unknown;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  parent_step_id: string | null;
  blocked_on: string | null;
  created_at: string;
}

interface RunRow {
  id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  trigger: WorkflowTrigger;
  input_json: string;
  output_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  generation: number;
}

interface StepRow {
  id: string;
  run_id: string;
  step_name: string;
  step_type: string;
  status: WorkflowStepStatus;
  attempt: number;
  output_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  parent_step_id: string | null;
  blocked_on: string | null;
  created_at: string;
}

function parseJson(text: string | null, fallback: unknown = null): unknown {
  if (text == null || text === "") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflow_name: row.workflow_name,
    status: row.status,
    trigger: row.trigger,
    input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json, null),
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
    generation: row.generation,
  };
}

function rowToStep(row: StepRow): WorkflowStep {
  return {
    id: row.id,
    run_id: row.run_id,
    step_name: row.step_name,
    step_type: row.step_type,
    status: row.status,
    attempt: row.attempt,
    output: parseJson(row.output_json, null),
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
    parent_step_id: row.parent_step_id,
    blocked_on: row.blocked_on,
    created_at: row.created_at,
  };
}

export interface CreateRunInput {
  workflow_name: string;
  trigger: WorkflowTrigger;
  input?: unknown;
  generation?: number;
  status?: WorkflowRunStatus;
}

export function createWorkflowRun(db: Database.Database, input: CreateRunInput): WorkflowRun {
  const id = `wfrun_${randomUUID().slice(0, 8)}`;
  const status = input.status ?? "pending";
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_name, status, trigger, input_json, generation)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.workflow_name, status, input.trigger, JSON.stringify(input.input ?? {}), input.generation ?? 0);
  return getWorkflowRun(db, id)!;
}

export function getWorkflowRun(db: Database.Database, id: string): WorkflowRun | null {
  const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export interface UpdateRunInput {
  status?: WorkflowRunStatus;
  output?: unknown;
  error?: string | null;
  finished_at?: string | null;
}

export function updateWorkflowRun(db: Database.Database, id: string, patch: UpdateRunInput): WorkflowRun | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.output !== undefined) {
    sets.push("output_json = ?");
    params.push(patch.output === null ? null : JSON.stringify(patch.output));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    params.push(patch.error);
  }
  if (patch.finished_at !== undefined) {
    sets.push("finished_at = ?");
    params.push(patch.finished_at);
  }
  if (sets.length === 0) return getWorkflowRun(db, id);
  params.push(id);
  db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getWorkflowRun(db, id);
}

export function listWorkflowRuns(
  db: Database.Database,
  filter: { workflow_name?: string; status?: WorkflowRunStatus; limit?: number } = {},
): WorkflowRun[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.workflow_name) {
    where.push("workflow_name = ?");
    params.push(filter.workflow_name);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  // `started_at` is `datetime('now')` — second resolution — so runs started in
  // the same second tie, and SQLite returns tied rows in whatever order it
  // likes. Anything asking for "the N newest" then gets an arbitrary N of them:
  // `pruneOldRuns` deletes the logs of a run it should have kept, and the run
  // list shows a fan-out in scrambled order. `rowid` is monotonic with insert
  // order, which is exactly the tiebreak "newest" means here.
  const rows = db
    .prepare(`SELECT * FROM workflow_runs ${whereSql} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(...params, limit) as RunRow[];
  return rows.map(rowToRun);
}

export function deleteWorkflowRun(db: Database.Database, id: string): boolean {
  const info = db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(id);
  return info.changes > 0;
}

export interface RecordStepInput {
  run_id: string;
  step_name: string;
  step_type: string;
  status?: WorkflowStepStatus;
  attempt?: number;
  parent_step_id?: string | null;
  started_at?: string | null;
  blocked_on?: string | null;
}

export function recordWorkflowStep(db: Database.Database, input: RecordStepInput): WorkflowStep {
  const id = `wfstep_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO workflow_steps
       (id, run_id, step_name, step_type, status, attempt, parent_step_id, started_at, blocked_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.run_id,
    input.step_name,
    input.step_type,
    input.status ?? "pending",
    input.attempt ?? 1,
    input.parent_step_id ?? null,
    input.started_at ?? null,
    input.blocked_on ?? null,
  );
  return getWorkflowStep(db, id)!;
}

export function getWorkflowStep(db: Database.Database, id: string): WorkflowStep | null {
  const row = db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as StepRow | undefined;
  return row ? rowToStep(row) : null;
}

export interface UpdateStepInput {
  status?: WorkflowStepStatus;
  output?: unknown;
  error?: string | null;
  attempt?: number;
  started_at?: string | null;
  finished_at?: string | null;
  blocked_on?: string | null;
}

export function updateWorkflowStep(db: Database.Database, id: string, patch: UpdateStepInput): WorkflowStep | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.output !== undefined) {
    sets.push("output_json = ?");
    params.push(patch.output === null ? null : JSON.stringify(patch.output));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    params.push(patch.error);
  }
  if (patch.attempt !== undefined) {
    sets.push("attempt = ?");
    params.push(patch.attempt);
  }
  if (patch.started_at !== undefined) {
    sets.push("started_at = ?");
    params.push(patch.started_at);
  }
  if (patch.finished_at !== undefined) {
    sets.push("finished_at = ?");
    params.push(patch.finished_at);
  }
  if (patch.blocked_on !== undefined) {
    sets.push("blocked_on = ?");
    params.push(patch.blocked_on);
  }
  if (sets.length === 0) return getWorkflowStep(db, id);
  params.push(id);
  db.prepare(`UPDATE workflow_steps SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getWorkflowStep(db, id);
}

export function listWorkflowSteps(db: Database.Database, runId: string): WorkflowStep[] {
  // ORDER BY rowid: created_at is second-resolution, so steps recorded in
  // the same second would otherwise tie-break by random UUID id.
  const rows = db.prepare("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY rowid ASC").all(runId) as StepRow[];
  return rows.map(rowToStep);
}

export function listInterruptibleRuns(db: Database.Database): WorkflowRun[] {
  const rows = db.prepare("SELECT * FROM workflow_runs WHERE status IN ('pending','running')").all() as RunRow[];
  return rows.map(rowToRun);
}
