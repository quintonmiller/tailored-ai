/**
 * Finding your way: where you are, from the town down, and the map's index
 * of agents, rooms and places, the town and the office last, filtered as you
 * type.
 */
import { describe, expect, it } from "vitest";
import {
  areaTitle,
  type MapArea,
  type MapPlace,
  mapIndex,
  placeTitle,
  plaqueWords,
  trailTo,
  wayInto,
} from "./wayfinding";

const places: MapPlace[] = [
  { id: "town", name: "the town", kind: "town", agents: [], area: "main" },
  { id: "lobby", name: "the town hall", kind: "lobby", agents: [], area: "main", via: "town", street: "The square" },
  { id: "office", name: "the office", kind: "office", agents: [], area: "main", via: "town", street: "The Avenue" },
  { id: "office:2", name: "the office, 2nd floor", kind: "office", agents: [], area: "main", via: "office" },
  {
    id: "home:analyst",
    name: "analyst's room",
    kind: "home",
    owner: "analyst",
    agents: ["analyst"],
    area: "main",
    via: "town",
    street: "Maple Lane",
  },
  {
    id: "home:writer",
    name: "writer's room",
    kind: "home",
    owner: "writer",
    agents: [],
    area: "main",
    via: "town",
    street: "Willow Way",
  },
  {
    id: "home:default",
    name: "the default agent's room",
    kind: "home",
    owner: "default",
    agents: ["default"],
    area: "main",
    via: "town",
    street: "Maple Lane",
  },
  {
    id: "home:meeting-summarizer",
    name: "meeting-summarizer's room",
    kind: "home",
    owner: "meeting-summarizer",
    agents: ["meeting-summarizer"],
    area: "summer-house",
    via: "town",
    street: "Summer house",
  },
  {
    id: "shared:lounge",
    name: "the lounge",
    kind: "shared",
    agents: [],
    area: "main",
    via: "town",
    street: "Main Street",
  },
  {
    id: "shared:porch",
    name: "the porch",
    kind: "shared",
    agents: [],
    area: "summer-house",
    via: "town",
    street: "Summer house",
  },
  {
    id: "room:local:budget",
    name: "budget",
    kind: "room",
    agents: ["writer"],
    area: "main",
    purpose: "Money in and out",
    via: "office",
  },
  {
    id: "room:local:trip",
    name: "trip",
    kind: "room",
    agents: [],
    area: "main",
    purpose: "Plan the Lisbon trip",
    via: "town",
    street: "The beach",
  },
  {
    id: "room:local:zines",
    name: "zines",
    kind: "room",
    agents: [],
    area: "main",
    via: "office:2",
  },
];
const areas: MapArea[] = [
  { id: "main", name: "the town", places: ["town", "lobby", "office", "home:analyst"] },
  { id: "summer-house", name: "the summer house", places: ["home:meeting-summarizer", "shared:porch"] },
];

describe("trailTo", () => {
  it("says where a home is: the town, the street its door is on, and whose home it is", () => {
    expect(trailTo("home:analyst", places, areas)).toEqual([
      { id: "town", label: "Town" },
      { id: "town", label: "Maple Lane", from: "home:analyst" },
      { id: "home:analyst", label: "analyst's home" },
    ]);
  });

  it("says where a meeting room in the office is, by its floor, and a building of its own by its street", () => {
    expect(trailTo("room:local:budget", places, areas)).toEqual([
      { id: "town", label: "Town" },
      { id: "town", label: "The Avenue", from: "office" },
      { id: "office", label: "Office" },
      { id: "room:local:budget", label: "#budget" },
    ]);
    // On the floor upstairs: the floor, reached from the one below, and still the office's street, out of its door.
    expect(trailTo("room:local:zines", places, areas)).toEqual([
      { id: "town", label: "Town" },
      { id: "town", label: "The Avenue", from: "office" },
      { id: "office:2", label: "Office, 2nd floor" },
      { id: "room:local:zines", label: "#zines" },
    ]);
    expect(trailTo("room:local:trip", places, areas).map((c) => c.label)).toEqual(["Town", "The beach", "#trip"]);
  });

  it("is the town alone for the town, and the square for the town hall", () => {
    expect(trailTo("town", places, areas)).toEqual([{ id: "town", label: "Town" }]);
    expect(trailTo("lobby", places, areas).map((c) => c.label)).toEqual(["Town", "The square", "the town hall"]);
  });

  it("says a plot's places are out on their plot", () => {
    expect(trailTo("shared:porch", places, areas)).toEqual([
      { id: "town", label: "Town" },
      { id: "town", label: "Summer house", from: "shared:porch" },
      { id: "shared:porch", label: "the porch" },
    ]);
  });

  it("calls the default agent's home by what it is, and is empty for a place not on the map", () => {
    expect(trailTo("home:default", places, areas).at(-1)?.label).toBe("the default agent's home");
    expect(trailTo("home:nobody", places, areas)).toEqual([]);
    expect(trailTo(undefined, places, areas)).toEqual([]);
    // Without the areas yet, still the town.
    expect(trailTo("home:analyst", places, [])[0]).toEqual({ id: "town", label: "Town" });
  });

  it("names areas and places the way the trail says them", () => {
    expect(areaTitle("the summer house")).toBe("Summer house");
    expect(areaTitle("Den")).toBe("Den");
    expect(placeTitle({ id: "room:local:x", kind: "room", name: "x" })).toBe("#x");
    expect(wayInto(areas[0])).toBe("town");
    expect(wayInto(areas[1])).toBe("home:meeting-summarizer");
    expect(wayInto({ id: "empty", name: "empty", places: [] })).toBeUndefined();
  });
});

describe("plaqueWords", () => {
  it("says what the trail calls a place, and keeps a name a home's agent gave it", () => {
    expect(plaqueWords("home:default", "your room")).toBe("the default agent's home");
    expect(plaqueWords("home:default", "the default agent's room")).toBe("the default agent's home");
    expect(plaqueWords("home:planner", "planner's room")).toBe("planner's home");
    expect(plaqueWords("home:planner", "The Map Room")).toBe("The Map Room");
    expect(plaqueWords("room:local:budget", "budget")).toBe("#budget");
    expect(plaqueWords("lobby", "the lobby")).toBe("the lobby");
    expect(plaqueWords("shared:lounge", "the lounge")).toBe("the lounge");
  });
});

describe("mapIndex", () => {
  it("leads with agents and rooms, keeps the town and the office's floors for last, and puts plots apart", () => {
    const index = mapIndex(places, areas, {});
    expect(index.agents.map((a) => a.agent)).toEqual(["analyst", "default", "meeting-summarizer", "writer"]);
    expect(index.rooms.map((p) => p.id)).toEqual(["room:local:budget", "room:local:trip", "room:local:zines"]);
    // The town's shared places; the porch is on the summer house's plot.
    expect(index.shared.map((p) => p.id)).toEqual(["shared:lounge"]);
    expect(index.areas).toEqual([
      {
        area: areas[1],
        way: "home:meeting-summarizer",
        places: [places[7], places[9]],
      },
    ]);
    expect(index.town?.id).toBe("town");
    expect(index.lobby?.id).toBe("lobby");
    expect(index.floors.map((p) => p.id)).toEqual(["office", "office:2"]);
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
    // A plot by its name or by what is on it; Enter goes in by its way in.
    expect(find("porch").areas.map((a) => a.area.id)).toEqual(["summer-house"]);
    expect(find("summer").first).toBe("home:meeting-summarizer");
    // The office's floors only when asked for; the town by its square, the town hall by its lobby.
    expect(find("office").floors.map((p) => p.name)).toEqual(["the office", "the office, 2nd floor"]);
    expect(find("office").lobby).toBeUndefined();
    expect(find("office").first).toBe("office");
    expect(find("square").first).toBe("town");
    expect(find("lobby").first).toBe("lobby");
    const none = find("zzz");
    expect([none.agents, none.rooms, none.shared, none.areas, none.floors].every((l) => l.length === 0)).toBe(true);
    expect(none.first).toBeUndefined();
  });

  it("finds agents by what they are for, too", () => {
    const withRoles = places.map((p) =>
      p.id === "home:writer" ? { ...p, role: "writer" } : p.id === "home:analyst" ? { ...p, role: "researcher" } : p,
    );
    expect(mapIndex(withRoles, areas, {}, "research").agents.map((a) => a.agent)).toEqual(["analyst"]);
  });

  it("puts rooms where something is happening first, and keeps the rest in the order they came", () => {
    const index = mapIndex(places, areas, {}, "", (p) => (p.id === "room:local:trip" ? 0 : 10));
    expect(index.rooms.map((p) => p.id)).toEqual(["room:local:trip", "room:local:budget", "room:local:zines"]);
  });
});
