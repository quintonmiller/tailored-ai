/**
 * Pluggable task backend abstraction.
 *
 * Decouples the autopilot worker (and, eventually, the tasks/task_query agent
 * tools) from any single storage system. The `native` backend wraps the
 * existing SQLite project_tasks table; other backends adapt external systems
 * like GitHub Issues, beans, or beads.
 */

export interface TaskComment {
  id: string | number;
  task_id: string;
  author: string;
  content: string;
  created_at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  /** Backend-native status string. Use `backend.isDone(status)` to test for completion. */
  status: string;
  author: string;
  tags: string[];
  assignee: string | null;
  rank: number;
  blocked_reason: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  /** Populated by `get()`; may be omitted from `query()` results. */
  comments?: TaskComment[];
}

export interface TaskCreateInput {
  title: string;
  description?: string;
  author?: string;
  tags?: string[];
  status?: string;
  project_id?: string;
  assignee?: string | null;
  rank?: number;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: string;
  author?: string;
  tags?: string[];
  assignee?: string | null;
  rank?: number;
  blocked_reason?: string | null;
}

export interface TaskFilter {
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
  tasks: Task[];
  total: number;
}

/**
 * Normalized status names. Each backend maps its native enum onto these so
 * autopilot logic ("claim a backlog task", "mark blocked due to budget") is
 * portable across backends.
 */
export interface TaskStatusMap {
  backlog: string;
  inProgress: string;
  blocked: string;
  done: string;
}

export interface TaskBackend {
  /** Backend identifier, e.g. "native", "github", "beans". */
  readonly name: string;

  /** Native status names mapped onto autopilot's normalized roles. */
  readonly statuses: TaskStatusMap;

  /** True if `status` represents a terminal/done state for this backend. */
  isDone(status: string): boolean;

  // ---- CRUD ----
  create(input: TaskCreateInput): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  update(id: string, patch: TaskUpdateInput): Promise<Task | undefined>;
  delete(id: string): Promise<boolean>;
  comment(id: string, content: string, author?: string): Promise<TaskComment | undefined>;
  query(filter?: TaskFilter): Promise<TaskQueryResult>;

  // ---- Autopilot helpers ----
  /** Top-ranked backlog task whose assignee is in the given set. */
  nextBacklogTask(assignees: string[]): Promise<Task | undefined>;
  /** Atomically transition a task from backlog → in-progress. Returns undefined if already claimed. */
  claimBacklog(id: string): Promise<Task | undefined>;
  /** Move all tasks blocked due to "budget" back to backlog. Returns how many were unblocked. */
  unblockBudgetTasks(): Promise<number>;
}
