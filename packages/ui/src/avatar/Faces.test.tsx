/**
 * The faces drawn into surfaces: inert until in use, a kiosk's button pressed
 * at once, a board whose notes open their cards and move between columns (by
 * dragging, or Shift and the arrows) there at once and saved, a calendar whose
 * lines open an agent's list, and a screen whose task links stay in the world.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BoardTask } from "./boards";
import type { CalendarView } from "./calendar";
import { type FaceData, SurfacePortals, type SurfaceStage } from "./Faces";
import type { Prop } from "./scene";
import type { SurfaceView } from "./stage";

/** How many times a widget has been drawn from nothing: each time is a "Loading…" and another fetch. */
const mounted = vi.hoisted(() => ({ count: 0 }));

vi.mock("../components/widgets", async () => {
  const { useEffect } = await import("react");
  return {
    widgetRenderers: {
      tasks: () => (
        <a className="widget-task-title" href="#/tasks/t-9">
          Pack the bags
        </a>
      ),
      status: () => {
        useEffect(() => {
          mounted.count++;
        }, []);
        return <p className="widget-status">Online</p>;
      },
    },
  };
});

let host: HTMLDivElement;
let root: Root;
let stage: { surfaceReady: Mock; focusSurface: Mock; surfacePoint: Mock };

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  stage = { surfaceReady: vi.fn(), focusSurface: vi.fn(), surfacePoint: vi.fn() };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const prop = (kind: string, more: Partial<Prop> = {}): Prop =>
  ({ id: kind, name: `the ${kind}`, kind, at: [0, 0], facing: 0, ...more }) as Prop;

/** A live surface showing a prop's face, its element in the page. */
function view(kind: string, more: Partial<SurfaceView> = {}, look: Partial<Prop> = {}): SurfaceView {
  const el = document.createElement("div");
  el.className = "world-surface";
  document.body.appendChild(el);
  return {
    id: `0:${kind}`,
    el,
    px: [800, 500],
    label: `the ${kind}`,
    use: kind === "kiosk" ? "direct" : "focus",
    focused: false,
    prop: prop(kind, look),
    ...more,
  };
}

function draw(views: SurfaceView[], data: FaceData) {
  act(() => root.render(<SurfacePortals views={views} data={data} stage={stage as unknown as SurfaceStage} />));
}

const tasks: BoardTask[] = [
  { id: "t-1", title: "Book the table", status: "backlog", assignee: "planner" },
  { id: "t-2", title: "Find the hotel", status: "in_progress", assignee: "assistant" },
  { id: "t-3", title: "Ask about check-out", status: "blocked", assignee: "assistant" },
];

const press = (el: Element, type: string, init: Record<string, unknown> = {}) =>
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  });

describe("SurfacePortals", () => {
  it("keeps a kiosk inert while another surface is read, so a click off it only steps back", () => {
    const onUse = vi.fn();
    const kiosk = view("kiosk", {}, { action: "new-task", label: "New task" });
    const board = view("board", { focused: true });
    draw([kiosk, board], { tasks, onUse });
    const inert = (v: SurfaceView) => v.el.firstElementChild?.hasAttribute("inert");
    expect(inert(kiosk)).toBe(true);
    draw([kiosk, { ...board, focused: false }], { tasks, onUse });
    expect(inert(kiosk)).toBe(false);
  });

  it("draws each live surface into its own element and says when it has", () => {
    const board = view("board");
    draw([board], { tasks });
    expect(board.el.querySelector(".sf-board")).not.toBeNull();
    expect(stage.surfaceReady).toHaveBeenCalledWith("0:board");
  });

  it("keeps a face inert until it is brought up, and a kiosk's at once", () => {
    const board = view("board");
    const kiosk = view("kiosk", {}, { label: "New task", action: "new-task" });
    draw([board, kiosk], { tasks });
    // The attribute, as the page has it: jsdom has no `inert` property to read.
    const inert = (v: SurfaceView) => v.el.firstElementChild?.hasAttribute("inert");
    expect(inert(board)).toBe(true);
    expect(inert(kiosk)).toBe(false);
    draw([{ ...board, focused: true }, kiosk], { tasks });
    expect(inert(board)).toBe(false);
  });

  it("presses a kiosk's button for what the kiosk is for", () => {
    const onUse = vi.fn();
    const kiosk = view("kiosk", {}, { label: "New task", action: "new-task" });
    draw([kiosk], { tasks, onUse });
    const button = kiosk.el.querySelector("button");
    expect(button?.textContent).toContain("New task");
    press(button as Element, "click");
    // Which kiosk it was too, so what it opens is kept beside it.
    expect(onUse).toHaveBeenCalledWith("new-task", undefined, "kiosk");
  });
});

describe("the board", () => {
  it("puts each task under its column and opens a note's card", () => {
    const onUse = vi.fn();
    const board = view("board", { focused: true }, { label: "Open tasks" });
    draw([board], { tasks, onUse });
    const column = (id: string) =>
      [...board.el.querySelectorAll(`[data-column='${id}'] .sf-note-title`)].map((n) => n.textContent);
    expect(board.el.querySelector(".sf-board-title")?.textContent).toBe("Open tasks");
    expect(column("todo")).toEqual(["Book the table"]);
    expect(column("doing")).toEqual(["Find the hotel"]);
    press(board.el.querySelector("[data-column='todo'] .sf-note") as Element, "click");
    expect(onUse).toHaveBeenCalledWith("tasks", { task: "t-1" }, "board");
  });

  it("moves a note with Shift and an arrow: there at once, and saved as a card saves it", async () => {
    let saved: () => void = () => {};
    const onTaskMove = vi.fn(() => new Promise<void>((done) => (saved = done)));
    const board = view("board", { focused: true });
    draw([board], { tasks, onTaskMove });
    const note = board.el.querySelector("[data-column='blocked'] .sf-note") as HTMLElement;
    await act(async () => {
      note.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    });
    expect(onTaskMove).toHaveBeenCalledWith("t-3", { status: "in_progress", blocked_reason: null });
    const doing = () =>
      [...board.el.querySelectorAll("[data-column='doing'] .sf-note-title")].map((n) => n.textContent);
    expect(doing()).toContain("Ask about check-out");
    // Saved: the page has the task as it is now, and the board shows that.
    const now = tasks.map((t) => (t.id === "t-3" ? { ...t, status: "in_progress" } : t));
    draw([board], { tasks: now, onTaskMove });
    await act(async () => saved());
    expect(doing()).toContain("Ask about check-out");
  });

  it("shows a saved note where the page's tasks have it, not where it was asked to go", async () => {
    let saved: () => void = () => {};
    const onTaskMove = vi.fn(() => new Promise<void>((done) => (saved = done)));
    const board = view("board", { focused: true });
    draw([board], { tasks, onTaskMove });
    const note = board.el.querySelector("[data-column='todo'] .sf-note") as HTMLElement;
    await act(async () => {
      note.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    });
    // The server kept it in review, or someone moved it again: the page's tasks say so once it is saved.
    const now = tasks.map((t) => (t.id === "t-1" ? { ...t, status: "blocked" } : t));
    draw([board], { tasks: now, onTaskMove });
    await act(async () => saved());
    const column = (id: string) =>
      [...board.el.querySelectorAll(`[data-column='${id}'] .sf-note-title`)].map((n) => n.textContent);
    expect(column("doing")).not.toContain("Book the table");
    expect(column("blocked")).toContain("Book the table");
  });

  it("puts a note back, and says why, when the move can't be saved", async () => {
    const onTaskMove = vi.fn(() => Promise.reject(new Error("offline")));
    const board = view("board", { focused: true });
    draw([board], { tasks, onTaskMove });
    const note = board.el.querySelector("[data-column='todo'] .sf-note") as HTMLElement;
    await act(async () => {
      note.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    });
    expect(board.el.querySelector("[data-column='todo'] .sf-note-title")?.textContent).toBe("Book the table");
    expect(board.el.querySelector(".sf-foot")?.textContent).toContain("offline");
  });

  it("moves a note dragged to another column, and a drag is no click on it", async () => {
    const onUse = vi.fn();
    const onTaskMove = vi.fn(() => Promise.resolve());
    const board = view("board", { focused: true });
    draw([board], { tasks, onUse, onTaskMove });
    // Lay the columns out as a browser would: 200 wide, 20 apart. The surface's own pixels are the page's here.
    const face = board.el.querySelector(".sf-board") as HTMLElement;
    for (const [i, col] of [...face.querySelectorAll<HTMLElement>("[data-column]")].entries()) {
      Object.defineProperty(col, "offsetLeft", { value: 20 + i * 220 });
      Object.defineProperty(col, "offsetWidth", { value: 200 });
      Object.defineProperty(col, "offsetParent", { value: face });
    }
    stage.surfacePoint.mockImplementation((_id: string, at: { clientX: number; clientY: number }) => [
      at.clientX,
      at.clientY,
    ]);
    const note = face.querySelector("[data-column='todo'] .sf-note") as HTMLElement;
    press(note, "pointerdown", { clientX: 100, clientY: 120 });
    press(note, "pointermove", { clientX: 160, clientY: 125 });
    press(note, "pointermove", { clientX: 700, clientY: 130 });
    expect(face.querySelector(".sf-note-ghost")).not.toBeNull();
    expect(face.querySelector("[data-column='done']")?.className).toContain("is-over");
    await act(async () => {
      note.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 700, clientY: 130 }));
      note.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    expect(onTaskMove).toHaveBeenCalledWith("t-1", { status: "done" });
    expect(onUse).not.toHaveBeenCalled();
    expect(face.querySelector(".sf-note-ghost")).toBeNull();
  });

  it("has a view from across the room: each column's count, big, and a bar for each note", () => {
    const board = view("board");
    draw([board], { tasks });
    const far = [...board.el.querySelectorAll(".sf-far-col")].map((c) => [
      c.querySelector(".sf-far-title")?.textContent,
      c.querySelector(".sf-far-count")?.textContent,
      c.querySelectorAll(".sf-far-bar").length,
    ]);
    expect(far).toEqual([
      ["To do", "1", 1],
      ["Doing", "1", 1],
      ["Blocked", "1", 1],
      ["Done", "0", 0],
    ]);
  });

  it("says how many more there are under a full column as words, not a button nobody can press", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `t-${i}`, title: `Task ${i}`, status: "backlog" }));
    const board = view("board");
    draw([board], { tasks: many });
    const more = board.el.querySelector(".sf-col-more");
    expect(more?.textContent).toBe("+3 more");
    expect(more?.tagName).toBe("SPAN");
    // Brought up, every note shows and there is nothing more to say.
    draw([{ ...board, focused: true }], { tasks: many });
    expect(board.el.querySelector(".sf-col-more")).toBeNull();
    expect(board.el.querySelectorAll("[data-column='todo'] .sf-note")).toHaveLength(7);
  });

  it("leaves a note where it was when it is dropped back in its own column", async () => {
    const onTaskMove = vi.fn(() => Promise.resolve());
    const board = view("board", { focused: true });
    draw([board], { tasks, onTaskMove });
    const face = board.el.querySelector(".sf-board") as HTMLElement;
    for (const [i, col] of [...face.querySelectorAll<HTMLElement>("[data-column]")].entries()) {
      Object.defineProperty(col, "offsetLeft", { value: 20 + i * 220 });
      Object.defineProperty(col, "offsetWidth", { value: 200 });
      Object.defineProperty(col, "offsetParent", { value: face });
    }
    stage.surfacePoint.mockImplementation((_id: string, at: { clientX: number; clientY: number }) => [
      at.clientX,
      at.clientY,
    ]);
    const note = face.querySelector("[data-column='todo'] .sf-note") as HTMLElement;
    press(note, "pointerdown", { clientX: 100, clientY: 120 });
    press(note, "pointermove", { clientX: 150, clientY: 200 });
    await act(async () => {
      note.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 150, clientY: 200 }));
    });
    expect(onTaskMove).not.toHaveBeenCalled();
  });
});

describe("the calendar", () => {
  const now = new Date(2026, 9, 19, 9, 0).getTime();
  const calendar: CalendarView = {
    title: "Everyone's next wakes",
    now,
    names: true,
    wakes: [
      { key: "booked:1", agent: "planner", at: now + 3_600_000, kind: "booked", what: "check ferry times" },
      { key: "cron:2", agent: "reviewer", at: now + 7_200_000, kind: "cron", what: "go through the drafts" },
    ],
    done: [{ key: "task:t-4", agent: "writer", at: now - 600_000, what: "finished “Draft the plan”", task: "t-4" }],
  };

  it("lists the day's wakes, whose and what, and what got done", () => {
    const cal = view("calendar", { focused: true });
    draw([cal], { tasks: [], calendar });
    expect(cal.el.querySelector(".sf-cal-day")?.textContent).toBe("19");
    const lines = [...cal.el.querySelectorAll(".sf-cal-wake")].map((l) => l.textContent);
    expect(lines[0]).toContain("planner");
    expect(lines[0]).toContain("check ferry times");
    expect(lines.at(-1)).toContain("Draft the plan");
  });

  it("has a view from across the room: the next wake, whose and what", () => {
    const cal = view("calendar");
    draw([cal], { tasks: [], calendar });
    const far = cal.el.querySelector(".sf-cal-far");
    expect(far?.querySelector(".sf-cal-far-when")?.textContent).toBe("Next · Today · 1 more");
    expect(far?.querySelector(".sf-cal-far-who")?.textContent).toBe("planner");
    expect(far?.querySelector(".sf-cal-far-what")?.textContent).toBe("check ferry times");
  });

  it("opens an agent's list from a line about it, and a task's card from what got done", () => {
    const onUse = vi.fn();
    const cal = view("calendar", { focused: true });
    draw([cal], { tasks: [], calendar, onUse });
    const lines = cal.el.querySelectorAll(".sf-cal-wake");
    press(lines[1], "click");
    expect(onUse).toHaveBeenCalledWith("calendar", { agent: "reviewer" }, "calendar");
    press(lines[2], "click");
    expect(onUse).toHaveBeenCalledWith("tasks", { task: "t-4" }, "calendar");
  });
});

describe("the screen", () => {
  it("draws a dashboard widget by the Board's renderer, its title opening it there and its tasks in the world", () => {
    const onUse = vi.fn();
    const screen = view("screen", { focused: true });
    draw([screen], { tasks: [], widgets: [{ id: "needs", type: "tasks", title: "Needs you" }], onUse });
    const title = screen.el.querySelector(".sf-screen-title") as HTMLElement;
    expect(title.textContent).toBe("Needs you");
    press(title, "click");
    expect(onUse).toHaveBeenCalledWith("screen", { card: "needs" }, "screen");
    press(screen.el.querySelector("a.widget-task-title") as Element, "click");
    expect(onUse).toHaveBeenCalledWith("tasks", { task: "t-9" }, "screen");
  });

  it("turns its page with the clock, and holds the page it is on while it is read", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 1));
      const cards = [
        { id: "now", title: "planner, now", big: { text: "working", tone: "ok" as const } },
        { id: "tasks", title: "planner's tasks", rows: [], empty: "Nothing on its list." },
      ];
      const title = (v: SurfaceView) => v.el.querySelector(".sf-screen-title")?.textContent;
      const screen = view("screen");
      draw([screen], { tasks: [], cards });
      const first = title(screen);
      act(() => vi.advanceTimersByTime(15_100));
      const second = title(screen);
      expect(second).not.toBe(first);
      // Brought up: it stays on that page however long it is read.
      draw([{ ...screen, focused: true }], { tasks: [], cards });
      act(() => vi.advanceTimersByTime(45_000));
      expect(title(screen)).toBe(second);
      // The arrows turn it, from the screen itself, as it is when brought up.
      act(() => {
        screen.el
          .querySelector("section")
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
      expect(title(screen)).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every widget drawn while it turns, showing one page at a time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 19, 9, 0, 1));
      mounted.count = 0;
      const widgets = [
        { id: "health", type: "status", title: "System status" },
        { id: "uptime", type: "status", title: "Uptime" },
      ];
      const screen = view("screen");
      draw([screen], { tasks: [], widgets });
      const shown = () => [...screen.el.querySelectorAll(".sf-screen-page")].map((p) => !p.hasAttribute("hidden"));
      const first = shown();
      expect(first.filter(Boolean)).toHaveLength(1);
      act(() => vi.advanceTimersByTime(15_100));
      expect(shown()).toEqual(first.map((up) => !up));
      act(() => vi.advanceTimersByTime(15_100));
      expect(shown()).toEqual(first);
      // Two widgets, each drawn once however many times the pages turned.
      expect(mounted.count).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns its page by the arrows beside the dots, and by a swipe, while it is read", () => {
    const cards = [
      { id: "now", title: "planner, now", big: { text: "working", tone: "ok" as const } },
      { id: "tasks", title: "planner's tasks", rows: [], empty: "Nothing on its list." },
    ];
    const title = (v: SurfaceView) => v.el.querySelector(".sf-screen-title")?.textContent;
    const screen = view("screen", { focused: true });
    draw([screen], { tasks: [], cards });
    const first = title(screen);
    const [before, after] = screen.el.querySelectorAll(".sf-turn-by");
    press(after, "click");
    const second = title(screen);
    expect(second).not.toBe(first);
    press(before, "click");
    expect(title(screen)).toBe(first);
    // A finger across the page, right to left: the next page.
    const body = screen.el.querySelector(".sf-screen-body") as HTMLElement;
    const touch = (type: string, x: number) =>
      act(() => {
        const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 300 });
        Object.defineProperty(e, "pointerType", { value: "touch" });
        body.dispatchEvent(e);
      });
    touch("pointerdown", 600);
    touch("pointerup", 480);
    expect(title(screen)).toBe(second);
    // Not read, there are no arrows: the dots and the clock turn it.
    draw([{ ...screen, focused: false }], { tasks: [], cards });
    expect(screen.el.querySelectorAll(".sf-turn-by")).toHaveLength(0);
  });

  it("in a home, goes through its owner's pages, a dot for each", () => {
    const screen = view("screen");
    draw([screen], {
      tasks: [],
      cards: [
        { id: "now", title: "planner, now", big: { text: "working", tone: "ok" } },
        { id: "tasks", title: "planner's tasks", rows: [], empty: "Nothing on its list." },
      ],
    });
    expect(screen.el.querySelectorAll(".sf-dot")).toHaveLength(2);
    expect(screen.el.querySelector(".sf-screen-title")?.textContent).toMatch(/planner/);
  });
});
