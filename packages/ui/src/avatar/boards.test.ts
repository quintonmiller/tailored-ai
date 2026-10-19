/**
 * A task board's columns: each task under its status, a few to a column,
 * with a count of the rest.
 */
import { describe, expect, it } from "vitest";
import { type BoardTask, columnsFor } from "./boards";

const task = (id: string, status: string, assignee = "planner"): BoardTask => ({
  id,
  title: `task ${id}`,
  status,
  assignee,
});

describe("columnsFor", () => {
  it("puts each task under its status, in the order they came", () => {
    const cols = columnsFor([
      task("a", "backlog"),
      task("b", "in_progress"),
      task("c", "in_review"),
      task("d", "blocked"),
      task("e", "done"),
      task("f", "archived"),
    ]);
    expect(cols.map((c) => [c.title, c.notes.map((n) => n.id)])).toEqual([
      ["To do", ["a"]],
      ["Doing", ["b", "c"]],
      ["Blocked", ["d"]],
      ["Done", ["e"]],
    ]);
  });

  it("fits a few to a column and counts the rest", () => {
    const cols = columnsFor(Array.from({ length: 7 }, (_, i) => task(String(i), "backlog")));
    expect(cols[0].notes.map((n) => n.id)).toEqual(["0", "1", "2", "3"]);
    expect(cols[0].more).toBe(3);
    expect(cols[1]).toMatchObject({ notes: [], more: 0 });
  });
});
