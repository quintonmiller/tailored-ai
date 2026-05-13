import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * A single typed fact about the user, a person they know, a thing they own,
 * etc. Identified within a project by (category, entity, key). `entity` is
 * optional — bare facts like `subscription:netflix / monthly_cost` use
 * category for grouping and leave entity blank.
 */
export interface Fact {
  id: string;
  category: string;
  entity: string;
  key: string;
  value: string;
  asof: string | null;
  source: string | null;
  confidence: number | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactInput {
  category: string;
  entity?: string;
  key: string;
  value: string;
  asof?: string | null;
  source?: string | null;
  confidence?: number | null;
  project_id?: string | null;
}

export interface FactQuery {
  project_id?: string | null;
  category?: string;
  entity?: string;
  key?: string;
  search?: string;
  limit?: number;
}

export function upsertFact(db: Database.Database, input: FactInput): Fact {
  const entity = input.entity ?? "";
  const projectId = input.project_id ?? null;

  const existing = db
    .prepare(
      `SELECT * FROM facts
       WHERE category = ? AND entity = ? AND key = ?
         AND (project_id IS ? OR project_id = ?)`,
    )
    .get(input.category, entity, input.key, projectId, projectId) as Fact | undefined;

  if (existing) {
    db.prepare(
      `UPDATE facts
       SET value = ?, asof = ?, source = ?, confidence = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      input.value,
      input.asof ?? existing.asof,
      input.source ?? existing.source,
      input.confidence ?? existing.confidence,
      existing.id,
    );
    return getFact(db, existing.id)!;
  }

  const id = `fact_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO facts (id, category, entity, key, value, asof, source, confidence, project_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.category,
    entity,
    input.key,
    input.value,
    input.asof ?? null,
    input.source ?? null,
    input.confidence ?? null,
    projectId,
  );
  return getFact(db, id)!;
}

export function getFact(db: Database.Database, id: string): Fact | null {
  const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Fact | undefined;
  return row ?? null;
}

export function findFact(
  db: Database.Database,
  category: string,
  entity: string,
  key: string,
  projectId: string | null = null,
): Fact | null {
  const row = db
    .prepare(
      `SELECT * FROM facts
       WHERE category = ? AND entity = ? AND key = ?
         AND (project_id IS ? OR project_id = ?)`,
    )
    .get(category, entity, key, projectId, projectId) as Fact | undefined;
  return row ?? null;
}

export function listFacts(db: Database.Database, q: FactQuery = {}): Fact[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.project_id !== undefined) {
    if (q.project_id === null) {
      clauses.push("project_id IS NULL");
    } else {
      clauses.push("project_id = ?");
      params.push(q.project_id);
    }
  }
  if (q.category) {
    clauses.push("category = ?");
    params.push(q.category);
  }
  if (q.entity !== undefined) {
    clauses.push("entity = ?");
    params.push(q.entity);
  }
  if (q.key) {
    clauses.push("key = ?");
    params.push(q.key);
  }
  if (q.search) {
    clauses.push("(category LIKE ? OR entity LIKE ? OR key LIKE ? OR value LIKE ?)");
    const term = `%${q.search}%`;
    params.push(term, term, term, term);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = q.limit && q.limit > 0 ? `LIMIT ${Math.floor(q.limit)}` : "";
  const sql = `SELECT * FROM facts ${where} ORDER BY category, entity, key ${limit}`;
  return db.prepare(sql).all(...params) as Fact[];
}

export function deleteFact(db: Database.Database, id: string): boolean {
  const res = db.prepare("DELETE FROM facts WHERE id = ?").run(id);
  return res.changes > 0;
}

export function forgetFact(
  db: Database.Database,
  category: string,
  entity: string,
  key: string,
  projectId: string | null = null,
): boolean {
  const res = db
    .prepare(
      `DELETE FROM facts
       WHERE category = ? AND entity = ? AND key = ?
         AND (project_id IS ? OR project_id = ?)`,
    )
    .run(category, entity, key, projectId, projectId);
  return res.changes > 0;
}
