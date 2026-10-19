/**
 * Tasks as the 3D world shows them: the statuses a task moves through in the
 * world's own words, the groups the boards and the task list sort them into,
 * and the list's filtering. Pure, so it is tested without a page.
 */

/** The statuses a card offers, in the order a task moves through them. */
export const STATUSES: { id: string; label: string }[] = [
  { id: "backlog", label: "To do" },
  { id: "in_progress", label: "Doing" },
  { id: "in_review", label: "In review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

/** The statuses the boards and the list keep up with: everything but archived. */
export const LIVE_STATUSES = ["backlog", "in_progress", "in_review", "blocked", "done"];

/** A status in the world's words; one it doesn't know, as the backend wrote it. */
export function statusLabel(status: string): string {
  if (status === "archived") return "Archived";
  if (status === "completed") return "Done";
  return STATUSES.find((s) => s.id === status)?.label ?? status.replace(/_/g, " ");
}

/** A column on a board, and a filter on the list: the statuses it gathers. */
export interface Group {
  id: "todo" | "doing" | "blocked" | "done";
  title: string;
  color: string;
  statuses: string[];
}

/** The board's columns, left to right. */
export const GROUPS: Group[] = [
  { id: "todo", title: "To do", color: "#f7e07a", statuses: ["backlog"] },
  { id: "doing", title: "Doing", color: "#9ec5ff", statuses: ["in_progress", "in_review"] },
  { id: "blocked", title: "Blocked", color: "#f5a26b", statuses: ["blocked"] },
  { id: "done", title: "Done", color: "#a8dca0", statuses: ["done", "completed"] },
];

/** What the list shows: what is still open, one column's worth, the archived ones, or everything. */
export type Filter = "open" | Group["id"] | "archived" | "all";

/** The list's filters, in the order they are offered. */
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "open", label: "Open" },
  ...GROUPS.map((g) => ({ id: g.id, label: g.title })),
  { id: "archived", label: "Archived" },
  { id: "all", label: "All" },
];

/** A task, as far as the list needs one. */
export interface ListedTask {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  created_at?: string;
}

const OPEN = new Set(GROUPS.filter((g) => g.id !== "done").flatMap((g) => g.statuses));

/** Whether a task is one a filter shows. */
export function shows(filter: Filter, task: { status: string }): boolean {
  if (filter === "all") return true;
  if (filter === "open") return OPEN.has(task.status);
  if (filter === "archived") return task.status === "archived";
  return GROUPS.find((g) => g.id === filter)?.statuses.includes(task.status) ?? false;
}

/**
 * Whose tasks the list shows: anyone's (undefined), nobody's yet (null),
 * or one agent's.
 */
export type Who = string | null | undefined;

function theirs(who: Who, task: ListedTask): boolean {
  if (who === undefined) return true;
  if (who === null) return !task.assignee;
  return task.assignee === who;
}

/** The tasks a filter and an assignee show, newest first; ties keep the order they came in. */
export function listTasks<T extends ListedTask>(tasks: T[], filter: Filter, who: Who): T[] {
  return tasks
    .map((task, i) => ({ task, i, made: whenMs(task.created_at) }))
    .filter(({ task }) => shows(filter, task) && theirs(who, task))
    .sort((a, b) => (b.made || 0) - (a.made || 0) || a.i - b.i)
    .map(({ task }) => task);
}

/** How many tasks each filter would show, for that assignee. */
export function countTasks(tasks: ListedTask[], who: Who): Record<Filter, number> {
  const counts = Object.fromEntries(FILTERS.map((f) => [f.id, 0])) as Record<Filter, number>;
  for (const task of tasks) {
    if (!theirs(who, task)) continue;
    for (const f of FILTERS) if (shows(f.id, task)) counts[f.id]++;
  }
  return counts;
}

/**
 * A timestamp as milliseconds, or NaN. The task store writes SQLite's
 * `YYYY-MM-DD HH:MM:SS`, which is UTC without saying so; read as it is, a
 * browser would take it for local time.
 */
export function whenMs(at: string | null | undefined): number {
  if (!at) return Number.NaN;
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(at);
  return Date.parse(bare ? `${at.replace(" ", "T")}Z` : at);
}

/** How long ago, in a few words: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: string | null | undefined, now = Date.now()): string | undefined {
  const ms = now - whenMs(at);
  if (!Number.isFinite(ms)) return undefined;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** How long something has been going on, in a few words: "a moment", "12 min", "3 h", "2 days". */
export function lasting(since: string | null | undefined, now = Date.now()): string | undefined {
  const ms = now - whenMs(since);
  if (!Number.isFinite(ms)) return undefined;
  if (ms < 60_000) return "a moment";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? "a day" : `${days} days`;
}
