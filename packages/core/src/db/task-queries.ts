import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  status: string;
  author: string;
  tags: string[];
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: number;
  task_id: string;
  author: string;
  content: string;
  created_at: string;
}

export interface ProjectTaskWithComments extends ProjectTask {
  comments: TaskComment[];
}

export interface TaskQueryFilter {
  status?: string | string[];
  author?: string;
  tags?: string[];
  updatedAfter?: string;
  search?: string;
  project_id?: string;
  limit?: number;
  offset?: number;
}

export interface TaskQueryResult {
  tasks: ProjectTask[];
  total: number;
}

interface ProjectTaskRow {
  id: string;
  title: string;
  description: string;
  status: string;
  author: string;
  tags: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: ProjectTaskRow): ProjectTask {
  return {
    ...row,
    tags: JSON.parse(row.tags) as string[],
    project_id: row.project_id,
  };
}

function generateId(): string {
  return `ptask_${randomUUID().slice(0, 8)}`;
}

export function createProjectTask(
  db: Database.Database,
  input: { title: string; description?: string; author?: string; tags?: string[]; status?: string; project_id?: string },
): ProjectTask {
  const id = generateId();
  const tags = JSON.stringify(input.tags ?? []);
  db.prepare(
    "INSERT INTO project_tasks (id, title, description, author, tags, status, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.title, input.description ?? "", input.author ?? "", tags, input.status ?? "backlog", input.project_id ?? null);

  return getProjectTask(db, id)! as ProjectTask;
}

export function getProjectTask(db: Database.Database, id: string): ProjectTaskWithComments | undefined {
  const row = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(id) as ProjectTaskRow | undefined;
  if (!row) return undefined;

  const comments = db
    .prepare("SELECT * FROM task_comments WHERE task_id = ? ORDER BY id ASC")
    .all(id) as TaskComment[];

  return { ...rowToTask(row), comments };
}

export function updateProjectTask(
  db: Database.Database,
  id: string,
  updates: { title?: string; description?: string; status?: string; author?: string; tags?: string[] },
): ProjectTask | undefined {
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
  if (updates.author !== undefined) {
    fields.push("author = ?");
    values.push(updates.author);
  }
  if (updates.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(updates.tags));
  }

  if (fields.length === 0) return getProjectTask(db, id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const result = db.prepare(`UPDATE project_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  if (result.changes === 0) return undefined;

  const row = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(id) as ProjectTaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function deleteProjectTask(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM project_tasks WHERE id = ?").run(id);
  return result.changes > 0;
}

export function addTaskComment(
  db: Database.Database,
  taskId: string,
  input: { author?: string; content: string },
): TaskComment | undefined {
  // Verify task exists
  const task = db.prepare("SELECT id FROM project_tasks WHERE id = ?").get(taskId) as { id: string } | undefined;
  if (!task) return undefined;

  const result = db
    .prepare("INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, ?)")
    .run(taskId, input.author ?? "", input.content);

  // Touch parent updated_at
  db.prepare("UPDATE project_tasks SET updated_at = datetime('now') WHERE id = ?").run(taskId);

  return db.prepare("SELECT * FROM task_comments WHERE id = ?").get(result.lastInsertRowid) as TaskComment;
}

export function queryProjectTasks(db: Database.Database, filter?: TaskQueryFilter): TaskQueryResult {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  if (filter?.author) {
    conditions.push("author = ?");
    params.push(filter.author);
  }

  if (filter?.tags && filter.tags.length > 0) {
    // Match tasks that have ANY of the given tags using json_each
    const tagPlaceholders = filter.tags.map(() => "?").join(", ");
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(project_tasks.tags) WHERE json_each.value IN (${tagPlaceholders}))`,
    );
    params.push(...filter.tags);
  }

  if (filter?.updatedAfter) {
    conditions.push("updated_at > ?");
    params.push(filter.updatedAfter);
  }

  if (filter?.search) {
    conditions.push("(title LIKE ? OR description LIKE ?)");
    const pattern = `%${filter.search}%`;
    params.push(pattern, pattern);
  }

  if (filter?.project_id) {
    conditions.push("project_id = ?");
    params.push(filter.project_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM project_tasks ${where}`).get(...params) as {
    total: number;
  };

  const limit = filter?.limit ?? 50;
  const offset = filter?.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM project_tasks ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ProjectTaskRow[];

  return {
    tasks: rows.map(rowToTask),
    total: countRow.total,
  };
}
