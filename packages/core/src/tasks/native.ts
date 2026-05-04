import type Database from "better-sqlite3";
import {
  addTaskComment,
  claimBacklogTask,
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  nextBacklogTaskForAssignees,
  type ProjectTask,
  type ProjectTaskWithComments,
  queryProjectTasks,
  unblockBudgetTasks,
  updateProjectTask,
} from "../db/task-queries.js";
import type {
  Task,
  TaskBackend,
  TaskComment,
  TaskCreateInput,
  TaskFilter,
  TaskQueryResult,
  TaskStatusMap,
  TaskUpdateInput,
} from "./interface.js";

const STATUSES: TaskStatusMap = {
  backlog: "backlog",
  inProgress: "in_progress",
  blocked: "blocked",
  done: "done",
};

const DONE_STATUSES = new Set(["done", "archived"]);

function toTask(row: ProjectTask | ProjectTaskWithComments): Task {
  const base: Task = {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    author: row.author,
    tags: row.tags,
    assignee: row.assignee,
    rank: row.rank,
    blocked_reason: row.blocked_reason,
    project_id: row.project_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if ("comments" in row) {
    base.comments = row.comments as unknown as TaskComment[];
  }
  return base;
}

/**
 * Native task backend backed by the existing SQLite project_tasks table.
 * Behaviour-preserving wrapper over packages/core/src/db/task-queries.ts.
 */
export class NativeTaskBackend implements TaskBackend {
  readonly name = "native";
  readonly statuses = STATUSES;
  readonly extraStatuses = ["in_review", "archived"] as const;

  constructor(private db: Database.Database) {}

  isDone(status: string): boolean {
    return DONE_STATUSES.has(status);
  }

  async create(input: TaskCreateInput): Promise<Task> {
    return toTask(createProjectTask(this.db, input));
  }

  async get(id: string): Promise<Task | undefined> {
    const row = getProjectTask(this.db, id);
    return row ? toTask(row) : undefined;
  }

  async update(id: string, patch: TaskUpdateInput): Promise<Task | undefined> {
    const row = updateProjectTask(this.db, id, patch);
    return row ? toTask(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    return deleteProjectTask(this.db, id);
  }

  async comment(id: string, content: string, author?: string): Promise<TaskComment | undefined> {
    const c = addTaskComment(this.db, id, { content, author });
    if (!c) return undefined;
    return {
      id: c.id,
      task_id: c.task_id,
      author: c.author,
      content: c.content,
      created_at: c.created_at,
    };
  }

  async query(filter?: TaskFilter): Promise<TaskQueryResult> {
    const result = queryProjectTasks(this.db, filter);
    return { tasks: result.tasks.map(toTask), total: result.total };
  }

  async nextBacklogTask(assignees: string[]): Promise<Task | undefined> {
    const row = nextBacklogTaskForAssignees(this.db, assignees);
    return row ? toTask(row) : undefined;
  }

  async claimBacklog(id: string): Promise<Task | undefined> {
    const row = claimBacklogTask(this.db, id);
    return row ? toTask(row) : undefined;
  }

  async unblockBudgetTasks(): Promise<number> {
    return unblockBudgetTasks(this.db);
  }
}
