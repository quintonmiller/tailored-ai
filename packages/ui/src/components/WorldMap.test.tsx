/**
 * The map: the town from above, every building a button; who is busy, every
 * agent, the rooms and places, plots, and the town and the office's floors
 * last; a mark for anyone waiting on you; filtered as you type, Enter to go
 * to the first; one click to go.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateChangeInfo } from "../api";
import type { AgentActivity } from "../avatar/doing";
import { withTalks } from "../avatar/talk";
import { busyAgents, busyMark, type MapPlace, markWords, roleWord, useWorldMap, WorldMap } from "./WorldMap";

// Changes to the world, as the page hears of them.
const heard = vi.hoisted(() => ({ listeners: new Set<(change: unknown) => void>() }));
vi.mock("../lib/state-events", () => ({
  subscribeStateChanges: (listener: (change: unknown) => void) => {
    heard.listeners.add(listener);
    return () => heard.listeners.delete(listener);
  },
}));
const hear = (change: Partial<StateChangeInfo>) =>
  act(() => {
    for (const listener of heard.listeners) listener(change);
  });

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
  const sections = () => [...container.querySelectorAll("h3")].map((h) => h.textContent);
  const people = () => [...container.querySelectorAll(".world-map-who")] as HTMLButtonElement[];
  const type = (text: string) =>
    act(() => {
      const input = container.querySelector("input") as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("leads with who is busy and every agent, then the rooms and shared places, and says where you are", () => {
    render();
    expect(sections()).toEqual(["Busy now", "Agents", "Meeting rooms", "Shared places"]);
    expect(tiles().map((t) => t.querySelector(".world-map-name")?.textContent)).toEqual([
      "#trip",
      "the loungeyou are here",
    ]);
    expect(tiles()[0].textContent).toMatch(/Plan the trip/);
    expect(tiles()[1].getAttribute("aria-current")).toBe("location");
    // Someone waiting on you is marked where they are.
    expect(container.querySelector(".world-map-agent.doing-waiting")?.textContent).toMatch(/!writer/);
    // An agent is listed by name, with what it is doing, whether or not anyone is at home. Idle is the dot's to say:
    // the word is there for a screen reader, not on the line.
    expect(people().map((p) => p.textContent)).toEqual(["planneridle"]);
    expect(people()[0].querySelector(".world-map-who-doing")?.classList.contains("calm")).toBe(true);
    // Every dot on the map says what an agent is doing, not which body it is.
    expect(container.querySelectorAll(".world-map-dot[style]")).toHaveLength(0);
    expect(container.querySelector(".world-map-busy.doing-waiting > .world-map-dot")?.textContent).toBe("!");
  });

  it("takes you into an agent's home, or to where its body is when that is somewhere else", () => {
    const { onGo } = render({
      activities: { planner: { agent: "planner", doing: "working", what: "searching the web" } },
    });
    const planner = people()[0];
    expect(planner.classList.contains("doing-working")).toBe(true);
    // Busy is said in words on the line, beside a dot with its mark.
    expect(planner.textContent).toBe("•plannerworking");
    expect(planner.querySelector(".world-map-who-doing")?.classList.contains("calm")).toBe(false);
    act(() => planner.click());
    expect(onGo).toHaveBeenLastCalledWith("home:planner");
    // Its body is in the lounge, with the writer.
    const away = container.querySelector(".world-map-away") as HTMLButtonElement;
    expect(away.textContent).toBe("in the lounge");
    act(() => away.click());
    expect(onGo).toHaveBeenLastCalledWith("shared:lounge");
  });

  it("keeps the town and the town hall in view, and folds the office's floors away until asked for", () => {
    render({
      places: [
        { id: "town", name: "the town", kind: "town", agents: [] },
        { id: "lobby", name: "the town hall", kind: "lobby", agents: [], via: "town" },
        { id: "office", name: "the office", kind: "office", agents: [], via: "town" },
        ...places,
      ],
    });
    expect(sections()).toEqual(["Busy now", "Agents", "Meeting rooms", "Shared places", "Town"]);
    const hall = tiles().find((t) => t.classList.contains("world-map-lobby"));
    expect(hall?.textContent).toMatch(/Make a new agent, task or room/);
    expect(hall?.textContent).not.toMatch(/nobody here/);
    expect(tiles().find((t) => t.classList.contains("world-map-town"))?.textContent).toMatch(/every building/);
    const fold = container.querySelector(".world-map-fold") as HTMLButtonElement;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toMatch(/Office floors\s*1/);
    expect(container.querySelector(".world-map-office")).toBeNull();
    act(() => fold.click());
    // A floor of the office has nobody living on it to list.
    expect(container.querySelector(".world-map-office")?.textContent).toBe("the office");
  });

  it("puts plots in a section of their own, with what is on each, and goes in by the way in", () => {
    const { onGo } = render({
      places: [
        { id: "town", name: "the town", kind: "town", agents: [], area: "main" },
        { ...places[0], area: "main" },
        { id: "shared:porch", name: "the summer porch", kind: "shared", agents: [], area: "summer-house" },
        { id: "shared:kitchen", name: "the summer kitchen", kind: "shared", agents: ["writer"], area: "summer-house" },
      ],
      areas: [
        { id: "main", name: "the town", places: ["town", "home:planner"] },
        { id: "summer-house", name: "the summer house", places: ["shared:kitchen", "shared:porch"] },
      ],
      here: "shared:porch",
    });
    expect(sections()).toEqual(["Busy now", "Agents", "Plots", "Town"]);
    const area = container.querySelector(".world-map-area-go") as HTMLButtonElement;
    expect(area.textContent).toBe("Summer houseyou are herethe summer porch · the summer kitchen");
    act(() => area.click());
    expect(onGo).toHaveBeenCalledWith("shared:kitchen");
  });

  it("has no plots while everything is in town", () => {
    render({ areas: [{ id: "main", name: "the town", places: [] }] });
    expect(sections()).not.toContain("Plots");
  });

  it("draws the town from above, every building a button that goes into it, the one you are in ringed", () => {
    const house = (id: string, owner: string, at: [number, number]) => ({
      id,
      kind: "house" as const,
      at,
      facing: 90,
      size: [5.2, 4.6, 3] as [number, number, number],
      label: owner,
      owner,
      style: 0.3,
      street: "Maple Lane",
    });
    const town: Parameters<typeof WorldMap>[0]["town"] = {
      width: 120,
      depth: 100,
      square: { at: [0, 0], radius: 11 },
      shore: { sand: 40, sea: 50 },
      stream: {
        points: [
          [-18, -50],
          [-18, 50],
        ],
        width: 2.6,
        bridges: [],
      },
      park: { at: [20, -20], size: [20, 14], pond: { at: [20, -20], size: [8, 5] } },
      roads: [
        {
          id: "lane-1",
          name: "Maple Lane",
          kind: "lane",
          width: 5,
          points: [
            [-30, -4],
            [-30, -40],
          ],
        },
      ],
      buildings: [
        house("home:planner", "planner", [-36, -10]),
        house("home:writer", "writer", [-24, -10]),
        {
          id: "lobby",
          kind: "hall",
          at: [0, -20],
          facing: 0,
          size: [18, 9, 6.5],
          label: "Town hall",
          style: 0.5,
          street: "The square",
        },
      ],
      plots: [],
      trees: [],
      lamps: [],
    };
    const shown = {
      places: [{ ...places[0], street: "Maple Lane" }, ...places.slice(1)],
      activities: { planner: { agent: "planner", doing: "working", what: "searching the web" } } as const,
      town,
    };
    const { onGo } = render({ ...shown, here: "home:planner", you: [0, 7] });
    // Inside a house, the house is where you are: no dot out in the street.
    expect(container.querySelector(".world-plan-you")).toBeNull();
    const buildings = [...container.querySelectorAll<HTMLButtonElement>(".world-plan-building")];
    expect(buildings).toHaveLength(3);
    const planner = buildings.find((b) => b.getAttribute("aria-current") === "location") as HTMLButtonElement;
    expect(planner.getAttribute("aria-label")).toBe("Planner's home, Maple Lane · planner is working");
    // At work: a dot on its house.
    expect(planner.querySelector(".world-plan-mark")).not.toBeNull();
    expect(container.querySelector(".world-plan-street")?.textContent).toBe("Maple Lane");
    const hall = buildings.find((b) => b.classList.contains("hall")) as HTMLButtonElement;
    expect(hall.textContent).toBe("Town hall");
    act(() => hall.click());
    expect(onGo).toHaveBeenLastCalledWith("lobby");

    // Out in the town, a dot where you stand: here, on the square, in front of the town hall.
    render({ ...shown, here: "town", you: [0, 7] });
    const you = container.querySelector<HTMLElement>(".world-plan-you");
    expect(you?.getAttribute("aria-label")).toBe("You are here");
    expect([you?.style.left, you?.style.top]).toEqual(["87.5%", "41.25%"]);
    // Off in the woods past what the plan shows, at its edge.
    render({ ...shown, here: "town", you: [-100, 7] });
    expect(container.querySelector<HTMLElement>(".world-plan-you")?.style.left).toBe("0%");
  });

  it("goes where you click", () => {
    const { onGo } = render();
    act(() => tiles()[0].click());
    expect(onGo).toHaveBeenCalledWith("room:local:trip");
  });

  it("finds agents, rooms and places as you type, opens the office's floors for a match, and Enter goes to the first", () => {
    const { onGo } = render({
      places: [{ id: "office", name: "the office", kind: "office", agents: [] }, ...places],
    });
    const input = container.querySelector("input") as HTMLInputElement;
    const enter = () => act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    // Nothing typed: Enter goes nowhere.
    enter();
    expect(onGo).not.toHaveBeenCalled();
    type("plan");
    expect(people().map((p) => p.textContent)).toEqual(["planneridle"]);
    // A room found by what it is for, after the agent; the first is marked, for Enter.
    expect(tiles().map((t) => t.querySelector(".world-map-name")?.textContent)).toEqual(["#trip"]);
    expect(people()[0].classList.contains("first")).toBe(true);
    // Busy now steps aside while you search.
    expect(sections()).not.toContain("Busy now");
    enter();
    expect(onGo).toHaveBeenLastCalledWith("home:planner");
    type("#tri");
    expect(people()).toHaveLength(0);
    enter();
    expect(onGo).toHaveBeenLastCalledWith("room:local:trip");
    type("office");
    const fold = () => container.querySelector(".world-map-fold") as HTMLButtonElement;
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".world-map-office")?.textContent).toBe("the office");
    // Open to show what matched: folding them waits until the search is cleared, and then they are as they were.
    expect(fold().disabled).toBe(true);
    act(() => fold().click());
    expect(container.querySelector(".world-map-office")?.textContent).toBe("the office");
    type("");
    expect(fold().disabled).toBe(false);
    expect(fold().getAttribute("aria-expanded")).toBe("false");
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
    // All of what each is doing is there to point at, however narrow the list cuts it.
    expect(busy[1].title).toBe("planner: searching the web · ferries");
  });

  it("says, while you visit, which place takes you back to the agent's own view rather than in as you", () => {
    render({ here: "room:local:trip", back: { place: "home:planner", agent: "planner" } });
    expect(container.querySelector(".world-map-rule")?.textContent).toBe(
      "Anywhere you pick, you walk in as you, except planner's home: that takes you back to planner's own view.",
    );
    // An agent's home is by its name in the list of agents.
    const planner = people().find((b) => b.textContent?.startsWith("planner")) as HTMLButtonElement;
    expect(planner.querySelector(".world-map-back")?.textContent).toBe("back to its view");
    expect(planner.title).toMatch(/back to planner's view$/);
    // A shared place that is the agent's own, like the default agent's lounge, says so on its card.
    render({ here: "room:local:trip", back: { place: "shared:lounge", agent: "the default agent" } });
    const lounge = tiles().find((t) => t.textContent?.startsWith("the lounge")) as HTMLButtonElement;
    expect(lounge.querySelector(".world-map-back")?.textContent).toBe("back to the default agent's view");
    // Not visiting, there is nothing to say.
    render({ here: "room:local:trip" });
    expect(container.querySelector(".world-map-rule")).toBeNull();
    expect(container.querySelector(".world-map-back")).toBeNull();
  });

  it("says who is on the phone with whom, and who is talking face to face, in Busy now and the list of agents", () => {
    const later = new Date(Date.now() + 30_000).toISOString();
    render({
      here: "home:planner",
      places: [
        { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", agents: ["planner"] },
        { id: "home:writer", name: "writer's room", kind: "home", owner: "writer", agents: ["writer"] },
        { id: "shared:lounge", name: "the lounge", kind: "shared", agents: ["editor", "reader"] },
      ],
      activities: withTalks(
        {
          planner: { agent: "planner", doing: "idle", what: "idle" },
          writer: { agent: "writer", doing: "idle", what: "idle" },
          editor: { agent: "editor", doing: "idle", what: "idle" },
          reader: { agent: "reader", doing: "idle", what: "idle" },
        },
        {
          planner: { with: "writer", phone: true, started: true, until: later },
          writer: { with: "planner", phone: true, until: later },
          editor: { with: "reader", started: true, until: later },
          reader: { with: "editor", until: later },
        },
        Date.now(),
      ),
    });
    const busy = [...container.querySelectorAll(".world-map-busy")] as HTMLButtonElement[];
    expect(busy.map((b) => b.textContent)).toEqual([
      "…editortalking with readerin the lounge",
      "…planneron the phone with writerhere",
      "…readertalking with editorin the lounge",
      "…writeron the phone with plannerat home",
    ]);
    // In the list of agents too: talking, and nobody has gone anywhere for it.
    const [planner, writer] = people();
    expect(planner.classList.contains("doing-talking")).toBe(true);
    expect(planner.querySelector(".world-map-who-doing")?.textContent).toBe("talking");
    expect(planner.parentElement?.querySelector(".world-map-away")).toBeNull();
    expect(writer.classList.contains("doing-talking")).toBe(true);
  });

  it("takes you to what someone waits on you for, when it can, and anyone else to where they are", () => {
    const onNeed = vi.fn();
    const { onGo } = render({
      onNeed,
      activities: {
        writer: { agent: "writer", doing: "waiting", what: "has a question for you" },
        planner: { agent: "planner", doing: "working", what: "searching the web" },
      },
    });
    const busy = [...container.querySelectorAll(".world-map-busy")] as HTMLButtonElement[];
    act(() => busy[0].click());
    expect(onNeed).toHaveBeenCalledWith("writer");
    expect(onGo).not.toHaveBeenCalled();
    act(() => busy[1].click());
    expect(onGo).toHaveBeenCalledWith("shared:lounge");
  });

  it("marks where something is happening, and puts it first", () => {
    render({
      places: [
        { id: "room:local:quiet", name: "quiet", kind: "room", agents: ["writer"] },
        { id: "room:local:think", name: "think", kind: "room", agents: ["planner"] },
        { id: "room:local:stuck", name: "stuck", kind: "room", agents: ["reader", "planner2"] },
      ],
      activities: {
        planner: { agent: "planner", doing: "thinking", what: "thinking" },
        reader: { agent: "reader", doing: "stuck", what: "stuck" },
        planner2: { agent: "planner2", doing: "working", what: "coding" },
      },
    });
    const rooms = tiles().filter((t) => t.classList.contains("world-map-room"));
    // Stuck before thinking, both before the quiet one.
    expect(rooms.map((t) => t.querySelector(".world-map-name")?.textContent)).toEqual(["#stuck", "#think", "#quiet"]);
    expect(rooms[0].classList.contains("busy")).toBe(true);
    // One is stuck and one working: the mark says so, rather than two stuck.
    expect(rooms[0].querySelector(".world-map-mark")?.textContent).toBe("stuck · 1 more busy");
    expect(rooms[1].querySelector(".world-map-mark")?.textContent).toBe("thinking");
    expect(rooms[2].querySelector(".world-map-mark")).toBeNull();
  });

  it("says when nobody is busy, and how many are in a quiet room, people too, as the room lists them", () => {
    render({
      activities: {},
      places: [
        { id: "room:local:trip", name: "trip", kind: "room", agents: [], members: ["planner", "writer"], everyone: 5 },
        // Three agents it wakes, one of them without a body.
        {
          id: "room:local:ideas",
          name: "ideas",
          kind: "room",
          agents: [],
          members: ["planner", "writer"],
          subscribed: 3,
        },
      ],
    });
    expect(container.querySelector(".world-map-quiet")?.textContent).toMatch(/Nobody is busy/);
    // Five in the room, though only two of them are agents it wakes: the count the Rooms page shows.
    expect(tiles()[0].textContent).toMatch(/quiet · 5 members/);
    // A room that keeps no list of who is in it says what the number is.
    expect(tiles()[1].textContent).toMatch(/quiet · 3 subscribed/);
  });

  it("closes on Escape, and says when the map can't be had", () => {
    const { onClose } = render({ places: [], problem: "The map couldn't be loaded (500)." });
    expect(container.textContent).toMatch(/couldn't be loaded/);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("what each agent is for", () => {
  it("says it in a word by each agent's name, with the body's own colour", () => {
    render({
      places: [
        { id: "home:trip-planner", name: "", kind: "home", owner: "trip-planner", role: "travel agent", agents: [] },
        { id: "home:coder", name: "", kind: "home", owner: "coder", role: "coder", agents: [] },
      ],
    });
    const roles = [...container.querySelectorAll(".world-map-who-role")];
    expect(roles.map((r) => r.textContent)).toEqual(["", "travel agent"]);
    const dot = roles[1].querySelector(".world-map-hue") as HTMLElement;
    // The coder's own line has the dot too, though its name says what it is.
    expect(roles[0].querySelector(".world-map-hue")).not.toBeNull();
    expect(dot.getAttribute("style")).toContain("background");
  });

  it("leaves the word out where the name says it already", () => {
    expect(roleWord("coder", "coder")).toBeUndefined();
    expect(roleWord("podcast-producer", "producer")).toBeUndefined();
    expect(roleWord("game-master", "game master")).toBeUndefined();
    expect(roleWord("trip-planner", "travel agent")).toBe("travel agent");
    expect(roleWord("decoder", "coder")).toBe("coder");
    expect(roleWord("anyone", undefined)).toBeUndefined();
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

  it("ranks those waiting on you as the Needs you list does: approvals first, then the longest wait", () => {
    const wait = (agent: string, since: string, request?: string): AgentActivity => ({
      agent,
      doing: "waiting",
      what: "waiting",
      since,
      ...(request ? { request } : {}),
    });
    const busy = busyAgents(map, {
      a: wait("a", "2026-10-19T09:00:00Z"),
      b: wait("b", "2026-10-19T08:00:00Z"),
      c: wait("c", "2026-10-19T09:30:00Z", "r1"),
      d: act("stuck"),
    });
    expect(busy.map((b) => b.agent)).toEqual(["c", "b", "a", "d"]);
  });

  it("marks a place by the most pressing thing happening there, counting only those doing it", () => {
    expect(busyMark(map[2], { c: act("talking"), d: act("stuck") })).toEqual({ doing: "stuck", count: 1, others: 1 });
    expect(busyMark(map[2], { c: act("working"), d: act("working") })).toEqual({
      doing: "working",
      count: 2,
      others: 0,
    });
    expect(busyMark(map[1], { b: act("asleep") })).toBeUndefined();
  });

  it("has two talking busy talking for as long as the talk lasts, unless they are busier than that", () => {
    const home: MapPlace = { id: "home:b", name: "b's room", kind: "home", owner: "b", agents: ["a", "b"] };
    const talks = {
      a: { with: "b", started: true, until: new Date(Date.now() + 30_000).toISOString() },
      b: { with: "a", until: new Date(Date.now() + 30_000).toISOString() },
    };
    const talking = withTalks({ a: act("idle"), b: act("thinking") }, talks, Date.now());
    expect(busyAgents([home], talking).map((b) => [b.agent, b.activity.doing, b.activity.what])).toEqual([
      ["a", "talking", "talking with b"],
      ["b", "thinking", "thinking"],
    ]);
    // Once the talk has run out, an idle agent is idle again.
    const over = withTalks({ a: act("idle"), b: act("idle") }, talks, Date.now() + 60_000);
    expect(busyAgents([home], over)).toEqual([]);
  });

  it("says a mark in words a glance gets right", () => {
    expect(markWords({ doing: "waiting", count: 1, others: 0 })).toBe("waiting on you");
    expect(markWords({ doing: "waiting", count: 1, others: 2 })).toBe("waiting on you · 2 more busy");
    expect(markWords({ doing: "working", count: 2, others: 0 })).toBe("2 working");
    expect(markWords({ doing: "stuck", count: 2, others: 1 })).toBe("2 stuck · 1 more busy");
  });
});

describe("useWorldMap", () => {
  let root: Root;
  let container: HTMLDivElement;
  let answers: ((body: { places: MapPlace[] }) => void)[];
  const home = (agent: string): MapPlace => ({
    id: `home:${agent}`,
    name: `${agent}'s room`,
    kind: "home",
    owner: agent,
    agents: [agent],
  });
  function Probe({ open, fresh }: { open: boolean; fresh?: boolean }) {
    const { places } = useWorldMap(open, fresh);
    return <p>{places.map((p) => p.id).join(" ")}</p>;
  }
  const show = (open: boolean, fresh?: boolean) => act(() => root.render(<Probe open={open} fresh={fresh} />));
  const answer = async (i: number, places: MapPlace[]) => act(async () => answers[i]({ places }));
  const shown = () => container.textContent;

  beforeEach(() => {
    answers = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Each ask is answered when the test says, so answers can come back in any order.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((done) =>
            answers.push((body) => done(new Response(JSON.stringify({ ...body, areas: [] })))),
          ),
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("asks again each time the map opens, for an agent or a room nobody moved to tell it about", async () => {
    show(true, false);
    await answer(0, [home("planner")]);
    expect(shown()).toBe("home:planner");
    show(true, true);
    expect(answers).toHaveLength(2);
    await answer(1, [home("planner"), home("newcomer")]);
    expect(shown()).toBe("home:planner home:newcomer");
    // Closing asks nothing; opening again asks again.
    show(true, false);
    show(true, true);
    expect(answers).toHaveLength(3);
    // Nothing is asked while the stage is away.
    show(false, true);
    expect(answers).toHaveLength(3);
  });

  it("keeps the answer last asked for, though an older one comes back after it", async () => {
    show(true);
    hear({ type: "whereabouts", id: "planner", op: "update" });
    expect(answers).toHaveLength(2);
    await answer(1, [home("planner")]);
    await answer(0, [home("stale")]);
    expect(shown()).toBe("home:planner");
  });

  it("asks again when a place is given a new purpose, but not when its furniture moves", async () => {
    show(true);
    hear({ type: "place", id: "room:local:trip", op: "update", before: { purpose: "a" }, after: { purpose: "a" } });
    expect(answers).toHaveLength(1);
    hear({ type: "place", id: "room:local:trip", op: "update", before: { purpose: "a" }, after: { purpose: "b" } });
    expect(answers).toHaveLength(2);
  });
});
