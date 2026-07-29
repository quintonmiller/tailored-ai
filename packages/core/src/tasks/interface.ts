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
  /** Move the task to a different project. Pass null to unassign from a project. */
  project_id?: string | null;
}

export interface TaskFilter {
  status?: string | string[];
  author?: string;
  /**
   * Who the task is assigned to.
   *
   * A single name, several names, or the sentinel `null` meaning "nobody" —
   * unassigned tasks are a real category, not an absent filter, and conflating
   * the two is how an agent asking what it was working on got handed the
   * owner's unassigned reading list.
   */
  assignee?: string | Array<string | null> | null;
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

  /**
   * Additional status values the backend accepts beyond the four normalized
   * ones in `statuses` (e.g. native SQLite has "in_review" and "archived").
   * The full accepted set is `Object.values(statuses) ∪ extraStatuses`.
   */
  readonly extraStatuses?: readonly string[];

  /** True if `status` represents a terminal/done state for this backend. */
  isDone(status: string): boolean;

  // ---- CRUD ----
  create(input: TaskCreateInput): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  update(id: string, patch: TaskUpdateInput): Promise<Task | undefined>;
  delete(id: string): Promise<boolean>;
  comment(id: string, content: string, author?: string): Promise<TaskComment | undefined>;
  query(filter?: TaskFilter): Promise<TaskQueryResult>;

  /**
   * Optional one-time setup the backend needs before serving requests
   * (e.g. creating GitHub status:* labels). Idempotent. Callers should
   * invoke this once at startup; failures are non-fatal.
   */
  bootstrap?(): Promise<{ created: string[] }>;

  // ---- Autopilot helpers ----
  /** Top-ranked backlog task whose assignee is in the given set. */
  nextBacklogTask(assignees: string[]): Promise<Task | undefined>;
  /** Atomically transition a task from backlog → in-progress. Returns undefined if already claimed. */
  claimBacklog(id: string): Promise<Task | undefined>;
  /** Move all tasks blocked due to "budget" back to backlog. Returns how many were unblocked. */
  unblockBudgetTasks(): Promise<number>;
}

/**
 * The concrete names in an assignee filter, for backends whose native query
 * takes plain strings. Drops the "unassigned" sentinel, which no remote issue
 * tracker has a word for.
 *
 * Whatever a backend does with these, it must still run {@link matchesAssignee}
 * over the result: narrowing after the fact is always safe, and a backend that
 * quietly ignored the filter would hand back everyone's tasks — which is the
 * failure the required `assignee` argument exists to prevent.
 */
export function assigneeNames(filter: TaskFilter["assignee"]): string[] {
  if (filter === undefined || filter === null) return [];
  const list = Array.isArray(filter) ? filter : [filter];
  return list.filter((a): a is string => typeof a === "string" && a.trim() !== "");
}

/**
 * Does this task's assignee satisfy the filter?
 *
 * `undefined` filter means "no opinion" and matches everything. `null` — or a
 * `null` inside a list — means "assigned to nobody", which is a real category
 * and not the absence of a question. An empty string counts as unassigned,
 * because backends differ on whether clearing an assignment writes NULL or "".
 */
export function matchesAssignee(assignee: string | null | undefined, filter: TaskFilter["assignee"]): boolean {
  if (filter === undefined) return true;
  const owner = assignee?.trim() ?? "";
  const wanted = Array.isArray(filter) ? filter : [filter];
  return wanted.some((w) =>
    w === null ? owner === "" : typeof w === "string" && w.toLowerCase() === owner.toLowerCase(),
  );
}
