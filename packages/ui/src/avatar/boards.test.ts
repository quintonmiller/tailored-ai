/**
 * A task board's columns: each task under its status, a few to a column,
 * with a count of the rest. And where each note is, so a click on the board
 * finds the note under it.
 */
import { describe, expect, it } from "vitest";
import { type BoardTask, boardAt, boardAtUv, columnsFor, layoutBoard } from "./boards";

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

// The size the board's canvas is drawn at: 1.32 m by 0.82 m at 640 px a metre.
const W = 845;
const H = 525;
const tasks = [task("a", "backlog"), task("b", "backlog"), task("c", "in_progress"), task("d", "done")];

describe("layoutBoard", () => {
  it("stacks each column's notes down its own strip, side by side, inside the board", () => {
    const { columns } = layoutBoard(W, H, tasks);
    const [todo, doing] = columns;
    const [a, b] = todo.notes.map((n) => n.rect);
    expect(b.y).toBeGreaterThan(a.y + a.h);
    expect(b.x).toBe(a.x);
    expect(doing.notes[0].rect.x).toBeGreaterThan(a.x + a.w);
    for (const col of columns) {
      expect(col.strip.x + col.strip.w).toBeLessThanOrEqual(W);
      for (const { rect } of col.notes) {
        expect(rect.x).toBeGreaterThanOrEqual(col.strip.x);
        expect(rect.x + rect.w).toBeLessThanOrEqual(col.strip.x + col.strip.w);
        expect(rect.y + rect.h).toBeLessThanOrEqual(H);
      }
    }
  });
});

describe("boardAt", () => {
  const layout = layoutBoard(W, H, tasks);
  const middle = (id: string) => {
    const r = layout.columns.flatMap((c) => c.notes).find((n) => n.task.id === id)?.rect;
    if (!r) throw new Error(`no note for ${id}`);
    return [r.x + r.w / 2, r.y + r.h / 2] as const;
  };

  it("finds the note under a point", () => {
    expect(boardAt(layout, ...middle("a"))).toEqual({ task: "a" });
    expect(boardAt(layout, ...middle("b"))).toEqual({ task: "b" });
    expect(boardAt(layout, ...middle("c"))).toEqual({ task: "c" });
    expect(boardAt(layout, ...middle("d"))).toEqual({ task: "d" });
  });

  it("gives the column for a point between notes, under them, or on its heading", () => {
    const [x, y] = middle("c");
    const [, below] = middle("b");
    expect(boardAt(layout, x, below)).toEqual({ column: "doing" });
    expect(boardAt(layout, x, layout.top - 10)).toEqual({ column: "doing" });
    expect(boardAt(layout, x, H - 30)).toEqual({ column: "doing" });
    expect(boardAt(layout, x, y)).toEqual({ task: "c" });
  });

  it("is over nothing on the board's title or its frame", () => {
    expect(boardAt(layout, W / 2, 10)).toEqual({});
    expect(boardAt(layout, 2, H / 2)).toEqual({});
  });
});

describe("boardAtUv", () => {
  it("turns the texture's upside-down coordinates into the canvas's", () => {
    const { rect } = layoutBoard(W, H, tasks).columns[0].notes[0];
    const u = (rect.x + rect.w / 2) / W;
    // Near the top of the canvas is near the top of the texture, which is v close to 1.
    const v = 1 - (rect.y + rect.h / 2) / H;
    expect(boardAtUv(W, H, tasks, u, v)).toEqual({ task: "a" });
    expect(boardAtUv(W, H, tasks, u, 1 - v)).not.toEqual({ task: "a" });
  });
});
