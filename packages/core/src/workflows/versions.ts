import type Database from "better-sqlite3";

/**
 * Workflow YAML version history. Every save snapshots the full file so users
 * can diff/roll back. Retention is configurable; default 50 versions per
 * workflow. The newest version is always the one currently on disk.
 */

export interface WorkflowVersion {
  id: number;
  workflow_name: string;
  version: number;
  yaml: string;
  saved_by: string | null;
  saved_at: string;
}

export interface RecordVersionInput {
  workflowName: string;
  yaml: string;
  savedBy?: string | null;
  /** Keep at most this many versions per workflow. Default 50. 0 disables pruning. */
  retain?: number;
}

const DEFAULT_RETAIN = 50;

/**
 * Persist a new version row. Auto-increments per workflow_name and prunes
 * older rows when over the retention threshold. Returns the new version row.
 */
export function recordVersion(db: Database.Database, input: RecordVersionInput): WorkflowVersion {
  const next =
    (db
      .prepare(`SELECT MAX(version) as v FROM workflow_versions WHERE workflow_name = ?`)
      .get(input.workflowName) as { v: number | null }).v ?? 0;
  const version = next + 1;

  db.prepare(
    `INSERT INTO workflow_versions (workflow_name, version, yaml, saved_by) VALUES (?, ?, ?, ?)`,
  ).run(input.workflowName, version, input.yaml, input.savedBy ?? null);

  const retain = input.retain ?? DEFAULT_RETAIN;
  if (retain > 0) {
    db.prepare(
      `DELETE FROM workflow_versions
       WHERE workflow_name = ?
         AND id NOT IN (
           SELECT id FROM workflow_versions WHERE workflow_name = ?
           ORDER BY version DESC LIMIT ?
         )`,
    ).run(input.workflowName, input.workflowName, retain);
  }

  return db
    .prepare(`SELECT * FROM workflow_versions WHERE workflow_name = ? AND version = ?`)
    .get(input.workflowName, version) as WorkflowVersion;
}

export function listVersions(db: Database.Database, workflowName: string, limit = 20): WorkflowVersion[] {
  return db
    .prepare(
      `SELECT * FROM workflow_versions WHERE workflow_name = ?
       ORDER BY version DESC LIMIT ?`,
    )
    .all(workflowName, limit) as WorkflowVersion[];
}

export function getVersion(
  db: Database.Database,
  workflowName: string,
  version: number,
): WorkflowVersion | null {
  const row = db
    .prepare(`SELECT * FROM workflow_versions WHERE workflow_name = ? AND version = ?`)
    .get(workflowName, version) as WorkflowVersion | undefined;
  return row ?? null;
}
