import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkflowInputsSchema } from "../workflows/types.js";

export type FormPendingStatus = "pending" | "submitted" | "expired" | "cancelled";

export interface WorkflowFormPending {
  id: string;
  run_id: string;
  step_id: string;
  step_name: string;
  prompt: string;
  fields: WorkflowInputsSchema;
  status: FormPendingStatus;
  submitted: Record<string, unknown> | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  run_id: string;
  step_id: string;
  step_name: string;
  prompt: string;
  fields_json: string;
  status: FormPendingStatus;
  submitted_json: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToForm(row: Row): WorkflowFormPending {
  return {
    id: row.id,
    run_id: row.run_id,
    step_id: row.step_id,
    step_name: row.step_name,
    prompt: row.prompt,
    fields: safeJson(row.fields_json, {}) as WorkflowInputsSchema,
    status: row.status,
    submitted: row.submitted_json ? (safeJson(row.submitted_json, null) as Record<string, unknown> | null) : null,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeJson(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export interface CreateFormPendingInput {
  run_id: string;
  step_id: string;
  step_name: string;
  prompt: string;
  fields: WorkflowInputsSchema;
  expires_at?: string | null;
}

export function createFormPending(db: Database.Database, input: CreateFormPendingInput): WorkflowFormPending {
  const id = `wfform_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO workflow_form_pending
       (id, run_id, step_id, step_name, prompt, fields_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.run_id,
    input.step_id,
    input.step_name,
    input.prompt,
    JSON.stringify(input.fields),
    input.expires_at ?? null,
  );
  return getFormPending(db, id)!;
}

export function getFormPending(db: Database.Database, id: string): WorkflowFormPending | null {
  const row = db.prepare("SELECT * FROM workflow_form_pending WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToForm(row) : null;
}

export function getFormPendingByStep(
  db: Database.Database,
  runId: string,
  stepName: string,
): WorkflowFormPending | null {
  const row = db
    .prepare("SELECT * FROM workflow_form_pending WHERE run_id = ? AND step_name = ?")
    .get(runId, stepName) as Row | undefined;
  return row ? rowToForm(row) : null;
}

export function listFormPending(
  db: Database.Database,
  filter: { run_id?: string; status?: FormPendingStatus } = {},
): WorkflowFormPending[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.run_id) {
    where.push("run_id = ?");
    params.push(filter.run_id);
  }
  if (filter.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM workflow_form_pending ${whereSql} ORDER BY created_at DESC`)
    .all(...params) as Row[];
  return rows.map(rowToForm);
}

export function updateFormPending(
  db: Database.Database,
  id: string,
  patch: { status?: FormPendingStatus; submitted?: Record<string, unknown> | null },
): WorkflowFormPending | null {
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.submitted !== undefined) {
    sets.push("submitted_json = ?");
    params.push(patch.submitted === null ? null : JSON.stringify(patch.submitted));
  }
  params.push(id);
  db.prepare(`UPDATE workflow_form_pending SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getFormPending(db, id);
}

/**
 * Mark all still-pending forms attached to non-active runs as `cancelled`.
 * Called from `promoteOrphanedRuns()` on engine startup so a server restart
 * doesn't leak ghost forms in the UI.
 */
export function cancelOrphanedForms(db: Database.Database): number {
  const info = db
    .prepare(
      `UPDATE workflow_form_pending SET status = 'cancelled', updated_at = datetime('now')
       WHERE status = 'pending'
         AND run_id IN (
           SELECT id FROM workflow_runs WHERE status NOT IN ('pending','running')
         )`,
    )
    .run();
  return info.changes ?? 0;
}
