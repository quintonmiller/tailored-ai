/**
 * The task list in the 3D world: what each filter shows, whose tasks, newest
 * first, and the counts on the filters. And the store's timestamps, which are
 * UTC without saying so.
 */
import { describe, expect, it, vi } from "vitest";
import { ago, countTasks, type ListedTask, lasting, listTasks, statusLabel, whenMs } from "./tasks";

const task = (id: string, status: string, assignee: string | null, created_at: string): ListedTask => ({
  id,
  title: `task ${id}`,
  status,
  assignee,
  created_at,
});

const tasks = [
  task("a", "backlog", "planner", "2026-10-01 09:00:00"),
  task("b", "in_progress", "writer", "2026-10-03 09:00:00"),
  task("c", "in_review", "planner", "2026-10-02 09:00:00"),
  task("d", "blocked", null, "2026-10-04 09:00:00"),
  task("e", "done", "planner", "2026-10-05 09:00:00"),
  task("f", "archived", "writer", "2026-10-06 09:00:00"),
];
const ids = (list: ListedTask[]) => list.map((t) => t.id);

describe("listTasks", () => {
  it("shows what is still open, newest first", () => {
    expect(ids(listTasks(tasks, "open", undefined))).toEqual(["d", "b", "c", "a"]);
  });

  it("shows one column's worth, the way the board groups them", () => {
    expect(ids(listTasks(tasks, "doing", undefined))).toEqual(["b", "c"]);
    expect(ids(listTasks(tasks, "done", undefined))).toEqual(["e"]);
    expect(ids(listTasks(tasks, "archived", undefined))).toEqual(["f"]);
    expect(ids(listTasks(tasks, "all", undefined))).toEqual(["f", "e", "d", "b", "c", "a"]);
  });

  it("shows one agent's tasks, or the ones nobody has yet", () => {
    expect(ids(listTasks(tasks, "open", "planner"))).toEqual(["c", "a"]);
    expect(ids(listTasks(tasks, "open", null))).toEqual(["d"]);
  });

  it("keeps the order they came in when it can't tell which is newer", () => {
    const undated = [task("x", "backlog", null, ""), task("y", "backlog", null, "")];
    expect(ids(listTasks(undated, "open", undefined))).toEqual(["x", "y"]);
  });
});

describe("countTasks", () => {
  it("counts what each filter would show, for whoever is picked", () => {
    expect(countTasks(tasks, undefined)).toMatchObject({ open: 4, todo: 1, doing: 2, blocked: 1, done: 1, all: 6 });
    expect(countTasks(tasks, "writer")).toMatchObject({ open: 1, doing: 1, archived: 1, all: 2 });
  });
});

describe("statusLabel", () => {
  it("says a status in the world's words, and one it doesn't know as written", () => {
    expect(statusLabel("backlog")).toBe("To do");
    expect(statusLabel("in_review")).toBe("In review");
    expect(statusLabel("archived")).toBe("Archived");
    expect(statusLabel("waiting_on_vendor")).toBe("waiting on vendor");
  });
});

describe("whenMs and ago", () => {
  it("reads the store's bare timestamps as UTC, and ISO ones as they say", () => {
    // Away from UTC, where reading one as local time would show: a runner set to UTC can't tell the two apart.
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      expect(whenMs("2026-10-01 09:00:00")).toBe(Date.UTC(2026, 9, 1, 9));
      expect(whenMs("2026-10-01T09:00:00+02:00")).toBe(Date.UTC(2026, 9, 1, 7));
      expect(whenMs(null)).toBeNaN();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("says how long ago in a few words", () => {
    const now = Date.UTC(2026, 9, 10, 12);
    expect(ago("2026-10-10 11:59:30", now)).toBe("just now");
    expect(ago("2026-10-10 11:40:00", now)).toBe("20 min ago");
    expect(ago("2026-10-10 09:00:00", now)).toBe("3 h ago");
    expect(ago("2026-10-09 12:00:00", now)).toBe("yesterday");
    expect(ago("2026-10-06 12:00:00", now)).toBe("4 days ago");
    expect(ago(undefined, now)).toBeUndefined();
  });

  it("says how long something has gone on", () => {
    const now = Date.UTC(2026, 9, 10, 12);
    expect(lasting("2026-10-10 11:59:30", now)).toBe("a moment");
    expect(lasting("2026-10-10 11:48:00", now)).toBe("12 min");
    expect(lasting("2026-10-08 12:00:00", now)).toBe("2 days");
  });
});
