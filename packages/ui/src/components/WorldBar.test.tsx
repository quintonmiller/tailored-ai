/**
 * The tools over a phone's stage in one row: what is in the row and what is
 * in its menu for the room the row has, the menu with the way to where you
 * are, and an icon that says what it is under a finger held on it without
 * doing it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAR, type BarItem, barLayout, RANKS, WorldBar } from "./WorldBar";

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
  // The row is the stage less 8 pixels each side: 374 on a 390 phone, 344 on a 360 one.
  const [W390, W360] = [374, 344];
  const tools = (near: string, needs = true) => [
    ...(needs ? [item("needs", RANKS.needs, { tone: "needs", count: 2 })] : []),
    item("map", RANKS.map),
    item("tasks", RANKS.tasks),
    item("near", RANKS.near, { label: `Talk to ${near}`, words: near }),
    item("place"),
    item("edit"),
    item("back"),
    item("voices"),
  ];
  const ids = (xs: BarItem[]) => xs.map((i) => i.id);

  it("keeps what is used most and what wants you now, in the order given, and the rest for the menu", () => {
    const { row, menu, squeezed } = barLayout(tools("writer", false), W390);
    expect(ids(row)).toEqual(["map", "tasks", "near"]);
    expect(ids(menu)).toEqual(["place", "edit", "back", "voices"]);
    expect(squeezed).toEqual({});
  });

  it("gives up the tasks to the menu first when the row is too narrow, and the map stays whatever the name", () => {
    // Someone beside you and something waiting on you, on a phone: the tasks give way, the map and the count stay.
    for (const [width, near] of [
      [W390, "planner"],
      [W390, "trip-planner"],
      [W360, "planner"],
      [W360, "assistant"],
      [W360, "trip-planner"],
      [W360, "a-very-long-agent-name"],
    ] as const) {
      const { row, menu } = barLayout(tools(near), width);
      expect(ids(row), `${width} ${near}`).toEqual(["needs", "map", "near"]);
      expect(ids(menu), `${width} ${near}`).toEqual(["tasks", "place", "edit", "back", "voices"]);
    }
    // At 390 a short name like "writer" shows whole and a longer one is cut short to the room left; at 360, with the
    // count there too, there is room for the icon alone, the name in its tip.
    expect(barLayout(tools("writer"), W390).squeezed).toEqual({});
    const cut = barLayout(tools("trip-planner"), W390).squeezed.near;
    expect(cut).toBeGreaterThanOrEqual(BAR.icon + BAR.beside + 3 * BAR.letter);
    expect(barLayout(tools("writer"), W360).row.find((i) => i.id === "near")?.words).toBeUndefined();
    // Never more than the row has: what is in it, its gaps, and what is kept for the rest, add up to its width.
    const used = BAR.pad + BAR.travel + BAR.icon + BAR.here + 3 * BAR.gap + 2 * (BAR.icon + BAR.gap) + cut + BAR.gap;
    expect(used).toBeLessThanOrEqual(W390);
    // With nothing waiting on you, a name like "planner" shows whole on a 360 phone too.
    expect(barLayout(tools("planner", false), W360).squeezed).toEqual({});
  });

  it("shows the icon alone, its name in its tip, with no room for a few letters; and keeps the map however narrow", () => {
    // Room after the map and the count for an icon, not for letters.
    const width = BAR.pad + BAR.travel + BAR.icon + BAR.here + 3 * BAR.gap + 3 * (BAR.icon + BAR.gap) + 10;
    const { row } = barLayout(tools("assistant"), width);
    expect(ids(row)).toEqual(["needs", "map", "near"]);
    expect(row.find((i) => i.id === "near")?.words).toBeUndefined();
    expect(row.find((i) => i.id === "near")?.label).toBe("Talk to assistant");
    const tight = barLayout(tools("assistant"), BAR.pad + BAR.travel + BAR.icon + BAR.here + 4 * BAR.gap + BAR.icon);
    expect(ids(tight.row)).toEqual(["map"]);
    // However narrow, nothing is lost: what isn't in the row is in the menu.
    const none = barLayout(tools("assistant"), 120);
    expect(none.row.length + none.menu.length).toBe(tools("assistant").length);
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

  it("draws a name cut short no wider than the room it was given, and says it whole to a screen reader", () => {
    // The row measures itself; with nothing to measure by, it is taken as 360 wide.
    act(() =>
      root.render(
        <WorldBar
          items={[
            item("needs", RANKS.needs, { tone: "needs", count: 1 }),
            item("map", RANKS.map, { label: "Map" }),
            item("near", RANKS.near, { label: "Talk to trip-planner", words: "trip-planner", tone: "near" }),
          ]}
          trail={trail}
          here="home:planner"
          onStep={() => {}}
        />,
      ),
    );
    const near = container.querySelector<HTMLButtonElement>('[aria-label="Talk to trip-planner"]');
    const given = barLayout(
      [item("needs", RANKS.needs), item("map", RANKS.map), item("near", RANKS.near, { words: "trip-planner" })],
      360,
    ).squeezed.near;
    expect(given).toBeGreaterThan(0);
    expect(near?.style.maxWidth).toBe(`${given}px`);
    expect(near?.querySelector(".world-bar-words")?.textContent).toBe("trip-planner");
    expect(container.querySelector('[aria-label="Map"]')).not.toBeNull();
  });

  it("closes on a click elsewhere only once what was clicked has seen it open", () => {
    const onOpen = vi.fn();
    // The page's Chat button, say: pressed with the menu open, it brings the chat back, as the menu had stepped it aside.
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    const sawOpen: boolean[] = [];
    elsewhere.addEventListener("click", () => sawOpen.push(onOpen.mock.lastCall?.[0]));
    act(() =>
      root.render(
        <WorldBar items={[item("map", 5)]} trail={trail} here="home:planner" onStep={() => {}} onOpen={onOpen} />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="More"]')?.click());
    expect(onOpen).toHaveBeenLastCalledWith(true);
    // A finger or the pointer going down elsewhere isn't yet a click: the menu stays.
    act(() => {
      elsewhere.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector(".world-more-menu")).not.toBeNull();
    act(() => elsewhere.click());
    expect(sawOpen).toEqual([true]);
    expect(container.querySelector(".world-more-menu")).toBeNull();
    expect(onOpen).toHaveBeenLastCalledWith(false);
    elsewhere.remove();
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
