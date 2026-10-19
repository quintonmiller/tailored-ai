/**
 * Finding your way: where you are, from the area down, and the map's index
 * of agents, rooms and places, corridors last, filtered as you type.
 */
import { describe, expect, it } from "vitest";
import { areaTitle, type MapArea, type MapPlace, mapIndex, placeTitle, trailTo, wayInto } from "./wayfinding";

const places: MapPlace[] = [
  { id: "lobby", name: "the lobby", kind: "lobby", agents: [], area: "main" },
  { id: "hall:main:homes-foyer", name: "Residences", kind: "hall", agents: [], area: "main", via: "lobby" },
  {
    id: "hall:main:homes-1",
    name: "Residences A–M",
    kind: "hall",
    agents: [],
    area: "main",
    via: "hall:main:homes-foyer",
  },
  {
    id: "hall:main:homes-2",
    name: "Residences N–Z",
    kind: "hall",
    agents: [],
    area: "main",
    via: "hall:main:homes-foyer",
  },
  { id: "hall:main:rooms-1", name: "Meeting rooms", kind: "hall", agents: [], area: "main", via: "lobby" },
  {
    id: "home:analyst",
    name: "analyst's room",
    kind: "home",
    owner: "analyst",
    agents: ["analyst"],
    area: "main",
    via: "hall:main:homes-1",
  },
  {
    id: "home:writer",
    name: "writer's room",
    kind: "home",
    owner: "writer",
    agents: [],
    area: "main",
    via: "hall:main:homes-2",
  },
  {
    id: "home:default",
    name: "the default agent's room",
    kind: "home",
    owner: "default",
    agents: ["default"],
    area: "main",
    via: "hall:main:homes-1",
  },
  {
    id: "home:meeting-summarizer",
    name: "meeting-summarizer's room",
    kind: "home",
    owner: "meeting-summarizer",
    agents: ["meeting-summarizer"],
    area: "summer-house",
    via: "shared:porch",
  },
  { id: "shared:lounge", name: "the lounge", kind: "shared", agents: [], area: "main", via: "lobby" },
  {
    id: "shared:porch",
    name: "the porch",
    kind: "shared",
    agents: [],
    area: "summer-house",
    via: "home:meeting-summarizer",
  },
  {
    id: "room:local:budget",
    name: "budget",
    kind: "room",
    agents: ["writer"],
    area: "main",
    purpose: "Money in and out",
    via: "hall:main:rooms-1",
  },
  {
    id: "room:local:trip",
    name: "trip",
    kind: "room",
    agents: [],
    area: "main",
    purpose: "Plan the Lisbon trip",
    via: "hall:main:rooms-1",
  },
];
const areas: MapArea[] = [
  { id: "main", name: "the main building", places: ["lobby", "hall:main:homes-foyer", "home:analyst"] },
  { id: "summer-house", name: "the summer house", places: ["home:meeting-summarizer", "shared:porch"] },
];

describe("trailTo", () => {
  it("says where a home is: its area, the hall it opens off, and whose home it is", () => {
    expect(trailTo("home:analyst", places, areas)).toEqual([
      { id: "lobby", label: "Main building" },
      { id: "hall:main:homes-1", label: "Residences A–M" },
      { id: "home:analyst", label: "analyst's home" },
    ]);
  });

  it("says where a hall is from the foyer in front of it, and a room from its hall", () => {
    expect(trailTo("hall:main:homes-2", places, areas).map((c) => c.label)).toEqual([
      "Main building",
      "Residences",
      "Residences N–Z",
    ]);
    expect(trailTo("room:local:trip", places, areas).map((c) => c.label)).toEqual([
      "Main building",
      "Meeting rooms",
      "#trip",
    ]);
  });

  it("goes straight from the area to a place off the lobby, and to the lobby itself", () => {
    expect(trailTo("shared:lounge", places, areas).map((c) => c.label)).toEqual(["Main building", "the lounge"]);
    expect(trailTo("lobby", places, areas)).toEqual([
      { id: "lobby", label: "Main building" },
      { id: "lobby", label: "the lobby" },
    ]);
  });

  it("starts from another area's way in, and leaves out a place that isn't a hall on the way", () => {
    expect(trailTo("shared:porch", places, areas)).toEqual([
      { id: "home:meeting-summarizer", label: "Summer house" },
      { id: "shared:porch", label: "the porch" },
    ]);
  });

  it("calls the default agent's home by what it is, and is empty for a place not on the map", () => {
    expect(trailTo("home:default", places, areas).at(-1)?.label).toBe("the default agent's home");
    expect(trailTo("home:nobody", places, areas)).toEqual([]);
    expect(trailTo(undefined, places, areas)).toEqual([]);
    // Without the areas yet, still the main building.
    expect(trailTo("home:analyst", places, [])[0]).toEqual({ id: "lobby", label: "Main building" });
  });

  it("names areas and places the way the trail says them", () => {
    expect(areaTitle("the summer house")).toBe("Summer house");
    expect(areaTitle("Den")).toBe("Den");
    expect(placeTitle({ id: "room:local:x", kind: "room", name: "x" })).toBe("#x");
    expect(wayInto(areas[0])).toBe("lobby");
    expect(wayInto(areas[1])).toBe("home:meeting-summarizer");
    expect(wayInto({ id: "empty", name: "empty", places: [] })).toBeUndefined();
  });
});

describe("mapIndex", () => {
  it("leads with agents and rooms, keeps the corridors for last, and puts other areas apart", () => {
    const index = mapIndex(places, areas, {});
    expect(index.agents.map((a) => a.agent)).toEqual(["analyst", "default", "meeting-summarizer", "writer"]);
    expect(index.rooms.map((p) => p.id)).toEqual(["room:local:budget", "room:local:trip"]);
    // The main building's shared places; the porch is in the summer house.
    expect(index.shared.map((p) => p.id)).toEqual(["shared:lounge"]);
    expect(index.areas).toEqual([
      {
        area: areas[1],
        way: "home:meeting-summarizer",
        places: [places[8], places[10]],
      },
    ]);
    expect(index.lobby?.id).toBe("lobby");
    expect(index.halls.map((p) => p.id)).toEqual([
      "hall:main:homes-foyer",
      "hall:main:homes-1",
      "hall:main:homes-2",
      "hall:main:rooms-1",
    ]);
  });

  it("says where an agent's body is when it is out of its home, and what it is doing", () => {
    const index = mapIndex(places, areas, {
      writer: { agent: "writer", doing: "talking", what: "talking in #budget" },
    });
    const writer = index.agents.find((a) => a.agent === "writer");
    expect(writer?.home.id).toBe("home:writer");
    expect(writer?.away?.id).toBe("room:local:budget");
    expect(writer?.activity?.doing).toBe("talking");
    expect(index.agents.find((a) => a.agent === "analyst")?.away).toBeUndefined();
  });

  it("finds agents, rooms and places by what you type, and Enter goes to the first", () => {
    const find = (q: string) => mapIndex(places, areas, {}, q);
    expect(find("analy").agents.map((a) => a.agent)).toEqual(["analyst"]);
    expect(find("analy").first).toBe("home:analyst");
    // The default agent by what it is called on the page.
    expect(find("Default").agents.map((a) => a.agent)).toEqual(["default"]);
    // A room by its name, with or without its #, or by what it is for.
    expect(find("#bud").rooms.map((p) => p.id)).toEqual(["room:local:budget"]);
    expect(find("lisbon").rooms.map((p) => p.id)).toEqual(["room:local:trip"]);
    expect(find("lisbon").first).toBe("room:local:trip");
    // A place with or without its "the".
    expect(find("the lounge").shared.map((p) => p.id)).toEqual(["shared:lounge"]);
    // An area by its name or by what is in it; Enter goes in by its way in.
    expect(find("porch").areas.map((a) => a.area.id)).toEqual(["summer-house"]);
    expect(find("summer").first).toBe("home:meeting-summarizer");
    // Halls only when asked for, and the lobby.
    expect(find("resid").halls.map((p) => p.name)).toEqual(["Residences", "Residences A–M", "Residences N–Z"]);
    expect(find("resid").lobby).toBeUndefined();
    expect(find("resid").first).toBe("hall:main:homes-foyer");
    expect(find("lobby").first).toBe("lobby");
    const none = find("zzz");
    expect([none.agents, none.rooms, none.shared, none.areas, none.halls].every((l) => l.length === 0)).toBe(true);
    expect(none.first).toBeUndefined();
  });

  it("puts rooms where something is happening first, and keeps the rest in the order they came", () => {
    const index = mapIndex(places, areas, {}, "", (p) => (p.id === "room:local:trip" ? 0 : 10));
    expect(index.rooms.map((p) => p.id)).toEqual(["room:local:trip", "room:local:budget"]);
  });
});
