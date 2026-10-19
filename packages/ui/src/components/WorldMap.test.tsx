/**
 * The map: who is busy, every agent, the rooms and places, other areas, and
 * the lobby and halls last; a mark for anyone waiting on you; filtered as you
 * type, Enter to go to the first; one click to go.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateChangeInfo } from "../api";
import type { AgentActivity } from "../avatar/doing";
import { busyAgents, busyMark, doingHere, type MapPlace, markWords, useWorldMap, WorldMap } from "./WorldMap";

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

  it("keeps the lobby in view, and folds the halls away until asked for", () => {
    render({
      places: [
        { id: "lobby", name: "the lobby", kind: "lobby", agents: [] },
        { id: "hall:main:homes-1", name: "Residences", kind: "hall", agents: [], via: "lobby" },
        ...places,
      ],
    });
    expect(sections()).toEqual(["Busy now", "Agents", "Meeting rooms", "Shared places", "Lobby"]);
    const lobby = tiles().find((t) => t.classList.contains("world-map-lobby"));
    expect(lobby?.textContent).toMatch(/Make a new agent, task or room/);
    expect(lobby?.textContent).not.toMatch(/nobody here/);
    const fold = container.querySelector(".world-map-fold") as HTMLButtonElement;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toMatch(/Halls\s*1/);
    expect(container.querySelector(".world-map-hall")).toBeNull();
    act(() => fold.click());
    // A hall has nobody living in it to list.
    expect(container.querySelector(".world-map-hall")?.textContent).toBe("Residences");
  });

  it("puts other areas in a section of their own, with what is in each, and goes in by the way in", () => {
    const { onGo } = render({
      places: [
        { id: "lobby", name: "the lobby", kind: "lobby", agents: [], area: "main" },
        { ...places[0], area: "main" },
        { id: "shared:porch", name: "the summer porch", kind: "shared", agents: [], area: "summer-house" },
        { id: "shared:kitchen", name: "the summer kitchen", kind: "shared", agents: ["writer"], area: "summer-house" },
      ],
      areas: [
        { id: "main", name: "the main building", places: ["lobby", "home:planner"] },
        { id: "summer-house", name: "the summer house", places: ["shared:kitchen", "shared:porch"] },
      ],
      here: "shared:porch",
    });
    expect(sections()).toEqual(["Busy now", "Agents", "Other areas", "Lobby"]);
    const area = container.querySelector(".world-map-area-go") as HTMLButtonElement;
    expect(area.textContent).toBe("Summer houseyou are herethe summer porch · the summer kitchen");
    act(() => area.click());
    expect(onGo).toHaveBeenCalledWith("shared:kitchen");
    // Doors lead round it, so there's nothing to explain.
    expect(container.querySelector(".world-map-area-here")).toBeNull();
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
  });

  it("has no other areas while everything is in the main building", () => {
    render({ areas: [{ id: "main", name: "the main building", places: [] }] });
    expect(sections()).not.toContain("Other areas");
    expect(container.querySelector(".world-map-area-here")).toBeNull();
  });

  it("goes where you click", () => {
    const { onGo } = render();
    act(() => tiles()[0].click());
    expect(onGo).toHaveBeenCalledWith("room:local:trip");
  });

  it("finds agents, rooms and places as you type, opens the halls for a match, and Enter goes to the first", () => {
    const { onGo } = render({
      places: [{ id: "hall:main:rooms-1", name: "Meeting rooms", kind: "hall", agents: [] }, ...places],
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
    type("meeting");
    const fold = () => container.querySelector(".world-map-fold") as HTMLButtonElement;
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".world-map-hall")?.textContent).toBe("Meeting rooms");
    // Open to show what matched: folding them waits until the search is cleared, and then they are as they were.
    expect(fold().disabled).toBe(true);
    act(() => fold().click());
    expect(container.querySelector(".world-map-hall")?.textContent).toBe("Meeting rooms");
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
  });

  it("says who went to see whom, and where, in Busy now and the list of agents", () => {
    render({
      here: "home:planner",
      places: [
        { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", agents: [] },
        {
          id: "home:writer",
          name: "writer's room",
          kind: "home",
          owner: "writer",
          agents: ["planner", "writer"],
          with: { planner: "writer" },
        },
      ],
      activities: {
        planner: { agent: "planner", doing: "idle", what: "idle" },
        writer: { agent: "writer", doing: "idle", what: "idle" },
      },
    });
    const busy = [...container.querySelectorAll(".world-map-busy")] as HTMLButtonElement[];
    expect(busy.map((b) => b.textContent)).toEqual(["…plannertalking with writerin writer's room"]);
    // In the list of agents too: talking, and where; the one it came to see is as it is.
    const [planner, writer] = people();
    expect(planner.classList.contains("doing-talking")).toBe(true);
    expect(planner.querySelector(".world-map-who-doing")?.textContent).toBe("talking");
    expect(planner.parentElement?.querySelector(".world-map-away")?.textContent).toBe("in writer's home");
    expect(writer.classList.contains("doing-idle")).toBe(true);
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

  it("marks a place by the most pressing thing happening there, counting only those doing it", () => {
    expect(busyMark(map[2], { c: act("talking"), d: act("stuck") })).toEqual({ doing: "stuck", count: 1, others: 1 });
    expect(busyMark(map[2], { c: act("working"), d: act("working") })).toEqual({
      doing: "working",
      count: 2,
      others: 0,
    });
    expect(busyMark(map[1], { b: act("asleep") })).toBeUndefined();
  });

  it("has one gone to see an agent talking with it, unless it is busier than that", () => {
    const visit: MapPlace = {
      id: "home:b",
      name: "b's room",
      kind: "home",
      owner: "b",
      agents: ["a", "b"],
      with: { a: "b" },
    };
    expect(doingHere(visit, "a", { a: act("idle") })).toMatchObject({ doing: "talking", what: "talking with b" });
    expect(doingHere(visit, "a", {})).toMatchObject({ doing: "talking", with: "b" });
    // Thinking over what it heard: that is what it is doing.
    expect(doingHere(visit, "a", { a: act("thinking") })?.doing).toBe("thinking");
    // The one it came to see is as busy as its own activity says.
    expect(doingHere(visit, "b", { b: act("idle") })?.doing).toBe("idle");
    expect(busyAgents([visit], { a: act("idle"), b: act("idle") }).map((b) => [b.agent, b.activity.what])).toEqual([
      ["a", "talking with b"],
    ]);
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
