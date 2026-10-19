/**
 * The map: every place, grouped, with who is in each and a mark for anyone
 * waiting on you; filtered as you type; one click to go.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity } from "../avatar/doing";
import { busyAgents, busyMark, type MapPlace, WorldMap } from "./WorldMap";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const places: MapPlace[] = [
  { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", agents: [] },
  { id: "shared:lounge", name: "the lounge", kind: "shared", agents: ["planner", "writer"] },
  { id: "room:local:trip", name: "trip", kind: "room", agents: ["planner"], purpose: "Plan the trip" },
];

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
});

function render(over: Partial<Parameters<typeof WorldMap>[0]> = {}) {
  const onGo = vi.fn();
  const onClose = vi.fn();
  act(() =>
    root.render(
      <WorldMap
        places={places}
        problem={null}
        here="shared:lounge"
        activities={{ writer: { agent: "writer", doing: "waiting", what: "has a question for you" } }}
        onGo={onGo}
        onClose={onClose}
        {...over}
      />,
    ),
  );
  return { onGo, onClose };
}

const tiles = () => [...container.querySelectorAll(".world-map-place")] as HTMLButtonElement[];

describe("WorldMap", () => {
  it("groups rooms, shared places and homes, says who is in each, and where you are", () => {
    render();
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Busy now",
      "Rooms",
      "Shared places",
      "Homes",
    ]);
    expect(tiles().map((t) => t.querySelector(".world-map-name")?.textContent)).toEqual([
      "#trip",
      "the loungeyou are here",
      "planner's room",
    ]);
    expect(tiles()[0].textContent).toMatch(/Plan the trip/);
    expect(tiles()[2].textContent).toMatch(/nobody here/);
    expect(tiles()[1].getAttribute("aria-current")).toBe("location");
    // Someone waiting on you is marked.
    expect(container.querySelector(".world-map-agent.doing-waiting")?.textContent).toMatch(/!writer/);
  });

  it("puts the lobby first, as where to start", () => {
    render({ places: [{ id: "lobby", name: "the lobby", kind: "lobby", agents: [] }, ...places] });
    // After who is busy, which is always first.
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent).slice(0, 2)).toEqual([
      "Busy now",
      "Start here",
    ]);
    expect(tiles()[0].textContent).toMatch(/Make a new agent, task or room/);
    expect(tiles()[0].textContent).not.toMatch(/nobody here/);
  });

  it("groups places by area when some are elsewhere, the one you are in first, and lists the halls", () => {
    render({
      places: [
        { id: "lobby", name: "the lobby", kind: "lobby", agents: [], area: "main" },
        { id: "hall:main:homes-1", name: "Residences", kind: "hall", agents: [], area: "main" },
        { ...places[0], area: "main" },
        { id: "shared:porch", name: "the summer porch", kind: "shared", agents: [], area: "summer-house" },
        { id: "shared:kitchen", name: "the summer kitchen", kind: "shared", agents: ["writer"], area: "summer-house" },
      ],
      areas: [
        { id: "main", name: "the main building", places: ["lobby", "hall:main:homes-1", "home:planner"] },
        { id: "summer-house", name: "the summer house", places: ["shared:kitchen", "shared:porch"] },
      ],
      here: "shared:porch",
    });
    expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "The summer houseyou are here",
      "The main building",
    ]);
    expect(container.querySelector(".world-map-area-here")?.textContent).toMatch(
      /You're in the summer house\. Doors lead round it/,
    );
    const main = container.querySelectorAll(".world-map-area")[1];
    expect([...main.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Start here", "Homes", "Halls"]);
    // A hall has nobody living in it to list.
    expect(main.querySelector(".world-map-hall")?.textContent).not.toMatch(/nobody here/);
  });

  it("says a place alone in its area has no doors, rather than doors that lead nowhere", () => {
    render({
      places: [
        { id: "lobby", name: "the lobby", kind: "lobby", agents: [], area: "main" },
        { id: "shared:hideout", name: "the hideout", kind: "shared", agents: [], area: "den" },
      ],
      areas: [
        { id: "main", name: "the main building", places: ["lobby"] },
        { id: "den", name: "the den", places: ["shared:hideout"] },
      ],
      here: "shared:hideout",
    });
    const banner = container.querySelector(".world-map-area-here")?.textContent;
    expect(banner).toMatch(/You're in the den\. Nothing else is there yet, so it has no doors/);
    expect(banner).not.toMatch(/Doors lead/);
  });

  it("shows no areas while everything is in the main building", () => {
    render({ areas: [{ id: "main", name: "the main building", places: [] }] });
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector(".world-map-area-here")).toBeNull();
  });

  it("goes where you click", () => {
    const { onGo } = render();
    act(() => tiles()[0].click());
    expect(onGo).toHaveBeenCalledWith("room:local:trip");
  });

  it("finds a place by its name or by who is in it", () => {
    render();
    const input = container.querySelector("input") as HTMLInputElement;
    const type = (text: string) =>
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type("writer");
    expect(tiles().map((t) => t.querySelector(".world-map-name")?.textContent)).toEqual(["the loungeyou are here"]);
    type("zzz");
    expect(tiles()).toHaveLength(0);
    expect(container.textContent).toMatch(/Nothing matches/);
  });

  it("lists who is busy at the top, and goes straight to them", () => {
    const { onGo } = render({
      here: "home:planner",
      places: [
        { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", agents: ["planner"] },
        { id: "shared:lounge", name: "the lounge", kind: "shared", agents: ["reader"] },
        { id: "room:local:trip", name: "trip", kind: "room", agents: ["writer"], members: ["planner", "writer"] },
      ],
      activities: {
        writer: { agent: "writer", doing: "waiting", what: "has a question for you" },
        planner: { agent: "planner", doing: "working", what: "searching the web", detail: "ferries" },
        reader: { agent: "reader", doing: "thinking", what: "thinking" },
      },
    });
    const busy = [...container.querySelectorAll(".world-map-busy")] as HTMLButtonElement[];
    expect(busy.map((b) => b.textContent)).toEqual([
      "!writerhas a question for youin #trip",
      "•plannersearching the web · ferrieshere",
      "…readerthinkingin the lounge",
    ]);
    act(() => busy[0].click());
    expect(onGo).toHaveBeenCalledWith("room:local:trip");
  });

  it("marks where something is happening, and puts it first", () => {
    render({
      places: [
        { id: "home:writer", name: "writer's room", kind: "home", owner: "writer", agents: ["writer"] },
        { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", agents: ["planner"] },
        { id: "home:reader", name: "reader's room", kind: "home", owner: "reader", agents: ["reader", "planner2"] },
      ],
      activities: {
        planner: { agent: "planner", doing: "thinking", what: "thinking" },
        reader: { agent: "reader", doing: "stuck", what: "stuck" },
        planner2: { agent: "planner2", doing: "working", what: "coding" },
      },
    });
    const homes = tiles().filter((t) => t.classList.contains("world-map-home"));
    // Stuck before thinking, both before the quiet one.
    expect(homes.map((t) => t.querySelector(".world-map-name")?.textContent)).toEqual([
      "reader's room",
      "planner's room",
      "writer's room",
    ]);
    expect(homes[0].classList.contains("busy")).toBe(true);
    expect(homes[0].querySelector(".world-map-mark")?.textContent).toBe("stuck · 2");
    expect(homes[1].querySelector(".world-map-mark")?.textContent).toBe("thinking");
    expect(homes[2].querySelector(".world-map-mark")).toBeNull();
  });

  it("says when nobody is busy, and that a quiet room has members", () => {
    render({
      activities: {},
      places: [{ id: "room:local:trip", name: "trip", kind: "room", agents: [], members: ["planner", "writer"] }],
    });
    expect(container.querySelector(".world-map-quiet")?.textContent).toMatch(/Nobody is busy/);
    expect(tiles()[0].textContent).toMatch(/quiet · 2 members/);
  });

  it("closes on Escape, and says when the map can't be had", () => {
    const { onClose } = render({ places: [], problem: "The map couldn't be loaded (500)." });
    expect(container.textContent).toMatch(/couldn't be loaded/);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("busyAgents", () => {
  const act = (doing: AgentActivity["doing"], what = doing): AgentActivity => ({ agent: "x", doing, what });
  const map: MapPlace[] = [
    { id: "home:a", name: "a's room", kind: "home", owner: "a", agents: ["a"] },
    { id: "home:b", name: "b's room", kind: "home", owner: "b", agents: ["b"] },
    { id: "room:local:trip", name: "trip", kind: "room", agents: ["c", "d"] },
    { id: "home:e", name: "e's room", kind: "home", owner: "e", agents: ["e"] },
  ];

  it("ranks who needs you over who is stuck over who is at work, and leaves out the idle and asleep", () => {
    const busy = busyAgents(map, {
      a: act("thinking"),
      b: act("asleep"),
      c: act("talking"),
      d: act("waiting"),
      e: act("idle"),
      nobody: act("working"),
    });
    expect(busy.map((b) => [b.agent, b.activity.doing, b.place.id])).toEqual([
      ["d", "waiting", "room:local:trip"],
      ["c", "talking", "room:local:trip"],
      ["a", "thinking", "home:a"],
    ]);
  });

  it("marks a place by the most pressing thing happening there", () => {
    expect(busyMark(map[2], { c: act("talking"), d: act("stuck") })).toEqual({ doing: "stuck", count: 2 });
    expect(busyMark(map[1], { b: act("asleep") })).toBeUndefined();
  });
});
