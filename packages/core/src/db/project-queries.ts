import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Project {
  id: string;
  title: string;
  description: string;
  status: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithCounts extends Project {
  task_count: number;
  document_count: number;
}

export interface ProjectQueryFilter {
  status?: string | string[];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectQueryResult {
  projects: ProjectWithCounts[];
  total: number;
}

function generateId(): string {
  return `proj_${randomUUID().slice(0, 8)}`;
}

export function createProject(
  db: Database.Database,
  input: { title: string; description?: string; status?: string; due_date?: string },
): Project {
  const id = generateId();
  db.prepare(
    "INSERT INTO projects (id, title, description, status, due_date) VALUES (?, ?, ?, ?, ?)",
  ).run(id, input.title, input.description ?? "", input.status ?? "active", input.due_date ?? null);

  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project;
}

export function getProject(db: Database.Database, id: string): ProjectWithCounts | undefined {
  const row = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM project_tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM documents WHERE project_id = p.id) as document_count
    FROM projects p WHERE p.id = ?
  `).get(id) as (Project & { task_count: number; document_count: number }) | undefined;

  return row ?? undefined;
}

export function updateProject(
  db: Database.Database,
  id: string,
  updates: { title?: string; description?: string; status?: string; due_date?: string | null },
): Project | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push("description = ?");
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.due_date !== undefined) {
    fields.push("due_date = ?");
    values.push(updates.due_date);
  }

  if (fields.length === 0) return getProject(db, id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const result = db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  if (result.changes === 0) return undefined;

  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project;
}

export function deleteProject(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  return result.changes > 0;
}

export function queryProjects(db: Database.Database, filter?: ProjectQueryFilter): ProjectQueryResult {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    conditions.push(`p.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  if (filter?.search) {
    conditions.push("(p.title LIKE ? OR p.description LIKE ?)");
    const pattern = `%${filter.search}%`;
    params.push(pattern, pattern);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM projects p ${where}`).get(...params) as {
    total: number;
  };

  const limit = filter?.limit ?? 50;
  const offset = filter?.offset ?? 0;

  const rows = db
    .prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM project_tasks WHERE project_id = p.id) as task_count,
        (SELECT COUNT(*) FROM documents WHERE project_id = p.id) as document_count
      FROM projects p ${where} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as ProjectWithCounts[];

  return {
    projects: rows,
    total: countRow.total,
  };
}

export function getDefaultProjectId(db: Database.Database): string {
  const row = db.prepare("SELECT id FROM projects ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
  if (!row) {
    throw new Error("No projects exist. Database may not be initialized.");
  }
  return row.id;
}
