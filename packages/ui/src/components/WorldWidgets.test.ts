/**
 * What the widgets in a place are given: which widgets a place has, the room
 * a ticker shows, and whose things the widgets show in each kind of place.
 */
import { describe, expect, it } from "vitest";
import type { Prop } from "../avatar/scene";
import type { MapPlace } from "../lib/wayfinding";
import { facesIn, tickerRoom, whoseIn } from "./WorldWidgets";

const places: MapPlace[] = [
  { id: "lobby", name: "the lobby", kind: "lobby", agents: [] },
  {
    id: "room:local:lisbon-trip",
    name: "lisbon-trip",
    kind: "room",
    agents: ["planner"],
    members: ["planner", "writer"],
  },
  { id: "home:planner", name: "planner's home", kind: "home", agents: ["planner"], owner: "planner" },
];

const prop = (kind: string, shows?: string) =>
  ({ id: kind, name: kind, kind, at: [0, 0], facing: 0, ...(shows ? { shows } : {}) }) as Prop;

describe("the widgets in a place", () => {
  it("are what its things show, things with no face left out", () => {
    expect(facesIn([prop("couch"), prop("chart", "time"), prop("display", "feed"), prop("board")])).toEqual([
      { face: "chart", arg: "time" },
      { face: "feed" },
      { face: "tasks" },
    ]);
  });
});

describe("a ticker's room", () => {
  it("is a room on the map by its name, with or without its #, or its ref", () => {
    expect(tickerRoom("lisbon-trip", places)?.id).toBe("room:local:lisbon-trip");
    expect(tickerRoom("#Lisbon-Trip", places)?.id).toBe("room:local:lisbon-trip");
    expect(tickerRoom("local:lisbon-trip", places)?.id).toBe("room:local:lisbon-trip");
    expect(tickerRoom("planner's home", places)).toBeUndefined();
    expect(tickerRoom(undefined, places)).toBeUndefined();
  });
});

describe("whose things the widgets show", () => {
  it("are everyone's in the lobby, the owner's in a home, the members' in a meeting room, whoever is there elsewhere", () => {
    expect(whoseIn("lobby", ["planner"], places)).toBeUndefined();
    expect(whoseIn("home:writer", [], places)).toEqual(["writer"]);
    expect(whoseIn("room:local:lisbon-trip", ["planner"], places)).toEqual(["planner", "writer"]);
    expect(whoseIn("shared:lounge", ["reviewer"], places)).toEqual(["reviewer"]);
    // Nobody there: everyone's, rather than nothing at all.
    expect(whoseIn("shared:lounge", [], places)).toBeUndefined();
  });
});
