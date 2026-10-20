/**
 * The tools over a phone's stage in one row: what is in the row and what is
 * in its menu for the room the row has, the menu with the way to where you
 * are, and an icon that says what it is under a finger held on it without
 * doing it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAR, type BarItem, barLayout, WorldBar } from "./WorldBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, rank?: number, more: Partial<BarItem> = {}): BarItem => ({
  id,
  label: id,
  icon: "map",
  onClick: () => {},
  ...(rank === undefined ? {} : { rank }),
  ...more,
});

describe("what is in the row", () => {
  const tools = [
    item("needs", 4, { tone: "needs", count: 2 }),
    item("map", 3),
    item("tasks", 2),
    item("near", 5, { label: "Talk to planner", words: "planner" }),
    item("place"),
    item("edit"),
    item("back"),
    item("voices"),
  ];

  it("keeps what is used most and what wants you now, in the order given, and the rest for the menu", () => {
    const { row, menu } = barLayout(
      tools.filter((i) => i.id !== "needs"),
      390,
    );
    expect(row.map((i) => i.id)).toEqual(["map", "tasks", "near"]);
    expect(menu.map((i) => i.id)).toEqual(["place", "edit", "back", "voices"]);
  });

  it("gives up the least wanted to the menu first when the row is too narrow for them all", () => {
    // Someone beside you and something waiting on you, on a phone: the tasks give way, the map stays.
    const { row, menu } = barLayout(tools, 390);
    expect(row.map((i) => i.id)).toEqual(["needs", "map", "near"]);
    expect(menu.map((i) => i.id)).toEqual(["tasks", "place", "edit", "back", "voices"]);
    // However narrow, nothing is lost: what isn't in the row is in the menu.
    const tight = barLayout(tools, 120);
    expect(tight.row.length + tight.menu.length).toBe(tools.length);
    // Someone to talk to beside you says so in words, but never takes the row's whole width.
    expect(BAR.wordsMax).toBeLessThan(200);
  });
});

describe("the row over a phone's stage", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const trail = [
    { id: "town", label: "Town" },
    { id: "town", label: "Maple Lane", from: "home:planner" },
    { id: "home:planner", label: "planner's home" },
  ];

  it("ends with where you are, and opens a menu of the rest in words and the way back up to the town", () => {
    const back = vi.fn();
    const onStep = vi.fn();
    const onOpen = vi.fn();
    act(() =>
      root.render(
        <WorldBar
          items={[item("map", 3), item("back", undefined, { label: "Back to planner", onClick: back })]}
          trail={trail}
          here="home:planner"
          onStep={onStep}
          onOpen={onOpen}
        />,
      ),
    );
    expect(container.querySelector(".world-bar-here")?.textContent).toBe("planner's home");
    expect(container.querySelector('[aria-label="map"]')).not.toBeNull();
    expect(container.querySelector(".world-more-menu")).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="More"]')?.click());
    const menu = container.querySelector(".world-more-menu");
    expect(onOpen).toHaveBeenLastCalledWith(true);
    expect([...(menu?.querySelectorAll("[role=menuitem]") ?? [])].map((b) => b.textContent)).toEqual([
      "Back to planner",
      "Town",
      "Maple Lane",
    ]);
    // Where you are is said, not offered.
    expect(menu?.querySelector('[aria-current="location"]')?.textContent).toBe("planner's home");
    const lane = [...(menu?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Maple Lane");
    act(() => lane?.click());
    expect(onStep).toHaveBeenCalledWith(trail[1]);
    expect(container.querySelector(".world-more-menu")).toBeNull();
    expect(onOpen).toHaveBeenLastCalledWith(false);
    // Opened again, Escape closes it.
    act(() => container.querySelector<HTMLButtonElement>(".world-bar-here")?.click());
    expect(container.querySelector(".world-more-menu")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".world-more-menu")).toBeNull();
  });

  it("says what an icon is under a finger held on it, and the lift that ends the hold isn't a press", () => {
    vi.useFakeTimers();
    const map = vi.fn();
    act(() =>
      root.render(
        <WorldBar
          items={[item("map", 3, { label: "Map", onClick: map })]}
          trail={[]}
          here={undefined}
          onStep={() => {}}
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Map"]');
    if (!button) throw new Error("no map button");
    const touch = (type: string) =>
      button.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType: "touch" }));
    act(() => touch("pointerdown"));
    expect(button.dataset.tip).toBeUndefined();
    act(() => vi.advanceTimersByTime(500));
    expect(button.dataset.tip).toBe("on");
    act(() => {
      touch("pointerup");
      button.click();
    });
    expect(map).not.toHaveBeenCalled();
    // The words go again after a moment, and a plain tap presses it.
    act(() => vi.advanceTimersByTime(2000));
    expect(button.dataset.tip).toBeUndefined();
    act(() => {
      touch("pointerdown");
      touch("pointerup");
      button.click();
    });
    expect(map).toHaveBeenCalledTimes(1);
  });
});
