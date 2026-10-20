/**
 * A task board's columns: each task under its status, a few to a column,
 * with a count of the rest. And where each note is, so a click on the board
 * finds the note under it.
 */
import { describe, expect, it } from "vitest";
import {
  type BoardTask,
  boardAt,
  boardAtUv,
  type ColumnSpan,
  columnAt,
  columnsFor,
  layoutBoard,
  moveTo,
} from "./boards";

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

  it("fits as many as it is told to", () => {
    const cols = columnsFor(
      Array.from({ length: 7 }, (_, i) => task(String(i), "backlog")),
      6,
    );
    expect(cols[0].notes).toHaveLength(6);
    expect(cols[0].more).toBe(1);
    expect(columnsFor([task("a", "done")], Number.POSITIVE_INFINITY)[3]).toMatchObject({ more: 0 });
  });
});

describe("columnAt", () => {
  // Four columns 200 wide with a 20 gap between, as the HTML board lays them out.
  const spans: ColumnSpan[] = (["todo", "doing", "blocked", "done"] as const).map((id, i) => ({
    id,
    left: 20 + i * 220,
    width: 200,
  }));

  it("is the column under the point", () => {
    expect(columnAt(25, spans)).toBe("todo");
    expect(columnAt(250, spans)).toBe("doing");
    expect(columnAt(519, spans)).toBe("blocked");
    expect(columnAt(700, spans)).toBe("done");
  });

  it("past either end, the column at that end", () => {
    expect(columnAt(-40, spans)).toBe("todo");
    expect(columnAt(5000, spans)).toBe("done");
  });

  it("in the gap between two, the nearer", () => {
    // "doing" ends at 440, "blocked" starts at 460.
    expect(columnAt(445, spans)).toBe("doing");
    expect(columnAt(456, spans)).toBe("blocked");
  });

  it("is none on a board with no columns", () => {
    expect(columnAt(10, [])).toBeUndefined();
  });
});

describe("moveTo", () => {
  it("is the first status the column gathers", () => {
    expect(moveTo({ status: "backlog" }, "doing")).toEqual({ status: "in_progress" });
    expect(moveTo({ status: "in_progress" }, "done")).toEqual({ status: "done" });
    expect(moveTo({ status: "done" }, "todo")).toEqual({ status: "backlog" });
  });

  it("is nothing for a task already in that column, under any of its statuses", () => {
    expect(moveTo({ status: "in_review" }, "doing")).toBeUndefined();
    expect(moveTo({ status: "completed" }, "done")).toBeUndefined();
  });

  it("lets go of the reason a task was blocked as it comes out of Blocked", () => {
    expect(moveTo({ status: "blocked" }, "doing")).toEqual({ status: "in_progress", blocked_reason: null });
    expect(moveTo({ status: "backlog" }, "blocked")).toEqual({ status: "blocked" });
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
