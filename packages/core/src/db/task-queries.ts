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
  assignee: string | null;
  rank: number;
  blocked_reason: string | null;
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
  assignee?: string;
  tags?: string[];
  updatedAfter?: string;
  search?: string;
  project_id?: string;
  orderBy?: "rank" | "updated_at";
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
  assignee: string | null;
  rank: number;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: ProjectTaskRow): ProjectTask {
  return {
    ...row,
    tags: JSON.parse(row.tags) as string[],
    project_id: row.project_id,
    assignee: row.assignee,
    rank: row.rank,
    blocked_reason: row.blocked_reason,
  };
}

function generateId(): string {
  return `ptask_${randomUUID().slice(0, 8)}`;
}

export function createProjectTask(
  db: Database.Database,
  input: {
    title: string;
    description?: string;
    author?: string;
    tags?: string[];
    status?: string;
    project_id?: string;
    assignee?: string | null;
    rank?: number;
  },
): ProjectTask {
  const id = generateId();
  const tags = JSON.stringify(input.tags ?? []);

  let resolvedAssignee: string | null = input.assignee ?? null;
  if (resolvedAssignee === null && input.project_id) {
    const proj = db
      .prepare("SELECT default_assignee FROM projects WHERE id = ?")
      .get(input.project_id) as { default_assignee: string | null } | undefined;
    resolvedAssignee = proj?.default_assignee ?? null;
  }

  let resolvedRank = input.rank;
  if (resolvedRank === undefined) {
    const row = input.project_id
      ? (db
          .prepare("SELECT COALESCE(MAX(rank), 0) AS m FROM project_tasks WHERE project_id = ?")
          .get(input.project_id) as { m: number })
      : (db.prepare("SELECT COALESCE(MAX(rank), 0) AS m FROM project_tasks").get() as { m: number });
    resolvedRank = row.m + 1;
  }

  db.prepare(
    "INSERT INTO project_tasks (id, title, description, author, tags, status, project_id, assignee, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.title,
    input.description ?? "",
    input.author ?? "",
    tags,
    input.status ?? "backlog",
    input.project_id ?? null,
    resolvedAssignee,
    resolvedRank,
  );

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
  updates: {
    title?: string;
    description?: string;
    status?: string;
    author?: string;
    tags?: string[];
    assignee?: string | null;
    rank?: number;
    blocked_reason?: string | null;
    project_id?: string | null;
  },
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
  if (updates.assignee !== undefined) {
    fields.push("assignee = ?");
    values.push(updates.assignee);
  }
  if (updates.rank !== undefined) {
    fields.push("rank = ?");
    values.push(updates.rank);
  }
  if (updates.blocked_reason !== undefined) {
    fields.push("blocked_reason = ?");
    values.push(updates.blocked_reason);
  }
  if (updates.project_id !== undefined) {
    fields.push("project_id = ?");
    values.push(updates.project_id);
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

/**
 * Atomically claim a backlog task: transitions status to 'in_progress' only if
 * it is currently 'backlog'. Returns the updated task on success, undefined if
 * the task is already claimed or does not exist.
 */
export function claimBacklogTask(db: Database.Database, id: string): ProjectTask | undefined {
  const result = db
    .prepare("UPDATE project_tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'backlog'")
    .run(id);
  if (result.changes === 0) return undefined;

  const row = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(id) as ProjectTaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

/**
 * Returns tasks that look stuck: assignee is in the given set of agent
 * names, status is non-terminal, and updated_at is older than the given
 * threshold. Used by the autopilot stuck-task scanner to find coder /
 * reviewer dispatches that died silently (process restart, crash, etc.)
 * so they can be requeued via `taskWatcher.notify(…, {force: true})`.
 */
export function findStuckCodingTasks(
  db: Database.Database,
  opts: { assignees: string[]; thresholdMs: number },
): ProjectTask[] {
  if (opts.assignees.length === 0) return [];
  const placeholders = opts.assignees.map(() => "?").join(", ");
  const thresholdSeconds = Math.max(1, Math.round(opts.thresholdMs / 1000));
  const rows = db
    .prepare(
      `SELECT * FROM project_tasks
        WHERE assignee IN (${placeholders})
          AND status NOT IN ('done', 'archived', 'blocked')
          AND datetime(updated_at) <= datetime('now', '-' || ? || ' seconds')`,
    )
    .all(...opts.assignees, thresholdSeconds) as ProjectTaskRow[];
  return rows.map(rowToTask);
}

/**
 * Returns the top-ranked backlog task whose assignee is in the given set, or
 * undefined if none exist. Ordered by rank ascending, then creation time.
 */
export function nextBacklogTaskForAssignees(
  db: Database.Database,
  assignees: string[],
): ProjectTask | undefined {
  if (assignees.length === 0) return undefined;
  const placeholders = assignees.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT * FROM project_tasks
       WHERE status = 'backlog' AND assignee IN (${placeholders})
       ORDER BY rank ASC, created_at ASC
       LIMIT 1`,
    )
    .get(...assignees) as ProjectTaskRow | undefined;
  return row ? rowToTask(row) : undefined;
}

/** Unblock tasks currently blocked by budget, moving them back to 'backlog' with reason cleared. */
export function unblockBudgetTasks(db: Database.Database): number {
  const result = db
    .prepare(
      "UPDATE project_tasks SET status = 'backlog', blocked_reason = NULL, updated_at = datetime('now') WHERE status = 'blocked' AND blocked_reason = 'budget'",
    )
    .run();
  return result.changes;
}

export interface TaskCommentWithTask {
  id: number;
  task_id: string;
  task_title: string;
  task_status: string;
  task_assignee: string | null;
  author: string;
  content: string;
  created_at: string;
}

/**
 * Returns the N most recent comments authored by `author`, joined with the
 * parent task's title/status/assignee. Used to surface "what has this agent
 * been working on" on the Agents page — useful for agents like coder/reviewer
 * whose task ownership churns (the assignee field doesn't preserve history,
 * but comments do).
 */
export function listRecentCommentsByAuthor(
  db: Database.Database,
  author: string,
  limit = 20,
): TaskCommentWithTask[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.task_id, c.author, c.content, c.created_at,
              t.title AS task_title, t.status AS task_status, t.assignee AS task_assignee
         FROM task_comments c
         JOIN project_tasks t ON t.id = c.task_id
        WHERE c.author = ?
        ORDER BY c.id DESC
        LIMIT ?`,
    )
    .all(author, limit) as TaskCommentWithTask[];
  return rows;
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

  if (filter?.assignee) {
    conditions.push("assignee = ?");
    params.push(filter.assignee);
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

  const orderSql = filter?.orderBy === "rank" ? "ORDER BY rank ASC, created_at ASC" : "ORDER BY updated_at DESC";
  const rows = db
    .prepare(`SELECT * FROM project_tasks ${where} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ProjectTaskRow[];

  return {
    tasks: rows.map(rowToTask),
    total: countRow.total,
  };
}
