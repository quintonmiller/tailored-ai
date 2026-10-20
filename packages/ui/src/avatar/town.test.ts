/**
 * The town outdoors: a house in its owner's colour, with what its owner does
 * standing by it; windows lit while someone is up, dark once they sleep; the
 * sky by the hour; the lamps that light round you; the roads' strips; the
 * doors in town a place is gone into by, and the walks between them.
 */
import { describe, expect, it } from "vitest";
import { agentColor } from "../components/WorldMap";
import { hueFor } from "./doing";
import {
  doorInTown,
  doorOfBuilding,
  featuresFor,
  footprintBox,
  houseLook,
  hsl,
  isEvening,
  lightFrom,
  nearestLamps,
  outsideDoor,
  ribbon,
  skyFor,
  type TownBuilding,
  type TownPlan,
  tripsBetween,
  windowLook,
} from "./town";

const house = (id: string, owner: string, at: [number, number], facing: number): TownBuilding => ({
  id,
  kind: "house",
  at,
  facing,
  size: [5.2, 4.6, 3],
  label: owner,
  owner,
  style: 0.3,
  street: "Maple Lane",
});
const plan = (buildings: TownBuilding[]): TownPlan => ({
  width: 120,
  depth: 100,
  square: { at: [0, 0], radius: 11 },
  shore: { sand: 40, sea: 50 },
  stream: { points: [], width: 2.6, bridges: [] },
  park: { at: [20, -20], size: [20, 14], pond: { at: [20, -20], size: [8, 5] } },
  roads: [],
  buildings,
  plots: [],
  trees: [],
  lamps: [],
});
const office: TownBuilding = {
  id: "office",
  kind: "office",
  at: [24, -10],
  facing: 0,
  size: [14, 10, 9],
  label: "Office",
  style: 0.5,
  street: "The Avenue",
};
const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

describe("a house's look", () => {
  it("is washed in its owner's colour, the one its body and the map show, with the door and trim in it", () => {
    const look = houseLook("planner", 0.3);
    const hue = (145 + (hueFor("planner") ?? 0)) % 360;
    expect(look.accent).toBe(hsl(hue, 0.52, 0.52));
    // The map's swatch is the same colour, in CSS.
    expect(agentColor("planner")).toBe(`hsl(${hue} 52% 52%)`);
    // The walls a pale wash of it, the trim deeper.
    const light = (c: number) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
    expect(light(look.walls)).toBeGreaterThan(light(look.accent));
    expect(light(look.trim)).toBeLessThan(light(look.accent));
    // Two owners, two colours.
    expect(houseLook("writer", 0.3).walls).not.toBe(look.walls);
  });

  it("takes its roof, its storeys and its chimney from its own style, the same each time", () => {
    expect(houseLook("planner", 0.1).roof).toBe("gable");
    expect(houseLook("planner", 0.5).roof).toBe("front-gable");
    expect(houseLook("planner", 0.9).roof).toBe("hip");
    expect(houseLook("planner", 0.9).storeys).toBe(2);
    expect(houseLook("planner", 0.3).storeys).toBe(1);
    expect(houseLook("planner", 0.42)).toEqual(houseLook("planner", 0.42));
  });

  it("has what its owner does standing by it, and a lantern or nothing when that can't be read", () => {
    expect(featuresFor("reporter")).toEqual(["dish"]);
    expect(featuresFor("artist")).toContain("easel");
    expect(featuresFor("ops")).toEqual(["rack", "dish"]);
    expect(featuresFor("housekeeper")).toEqual(["garden"]);
    expect(featuresFor(undefined, 0.2)).toEqual([]);
    expect(featuresFor(undefined, 0.8)).toEqual(["lantern"]);
    expect(featuresFor("no-such-role", 0.2)).toEqual([]);
  });
});

describe("windows", () => {
  it("are lit at night while the owner is up, and dark once it sleeps", () => {
    expect(windowLook("house", 22, "idle")).toBe("lit");
    expect(windowLook("house", 22, "asleep")).toBe("dark");
    expect(windowLook("house", 22, undefined)).toBe("lit");
    expect(windowLook("cottage", 5, "asleep")).toBe("dark");
  });

  it("show the sky by day, and a light inside only while the owner is at work", () => {
    expect(windowLook("house", 11, "idle")).toBe("day");
    expect(windowLook("house", 11, "asleep")).toBe("day");
    for (const doing of ["working", "thinking", "talking"] as const) expect(windowLook("house", 11, doing)).toBe("lit");
  });

  it("light up every evening in the town hall, the office and on main street", () => {
    for (const kind of ["hall", "office", "tavern", "shop"] as const) {
      expect(windowLook(kind, 19)).toBe("lit");
      expect(windowLook(kind, 12)).toBe("day");
    }
    expect(isEvening(18) && isEvening(4) && !isEvening(12)).toBe(true);
  });
});

describe("the sky", () => {
  it("is blue by day, warm at dusk, and dark with stars at night", () => {
    expect(skyFor(12).stars).toBe(false);
    expect(skyFor(23).stars).toBe(true);
    expect(skyFor(2).stars).toBe(true);
    expect(skyFor(18).horizon).not.toBe(skyFor(12).horizon);
  });

  it("lights the town from high in the south at noon, and lower late in the day", () => {
    const noon = lightFrom(13);
    const late = lightFrom(18.5);
    expect(Math.hypot(...noon)).toBeCloseTo(1);
    expect(noon[1]).toBeGreaterThan(late[1]);
    // From the south, so shadows fall away from the camera's usual side.
    expect(noon[2]).toBeGreaterThan(0);
    // Never from below the ground.
    for (let h = 0; h < 24; h++) expect(lightFrom(h)[1]).toBeGreaterThan(0);
  });

  it("lights the street lamps nearest you", () => {
    const lamps: [number, number][] = [
      [0, 0],
      [10, 0],
      [50, 50],
      [-5, 1],
    ];
    expect(nearestLamps(lamps, [1, 0], 2)).toEqual([
      [0, 0],
      [-5, 1],
    ]);
    expect(nearestLamps(lamps, [0, 0], 9)).toHaveLength(4);
  });
});

describe("roads", () => {
  it("are strips as wide at a bend as on the straight", () => {
    const pairs = ribbon(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      4,
    );
    expect(pairs).toHaveLength(3);
    for (const [a, b] of pairs) expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(4);
    // Square to the line at its ends.
    expect(pairs[0][0][0]).toBeCloseTo(0);
    expect(ribbon([[0, 0]], 4)).toEqual([]);
  });
});

describe("buildings", () => {
  it("have their door in the middle of their front, and you outside it on the street", () => {
    // Facing east, on to a lane to its east.
    const b = house("home:planner", "planner", [-36, -10], 90);
    expect(near(doorOfBuilding(b).at, [-36 + 2.3, -10])).toBe(true);
    expect(near(outsideDoor(b), [-36 + 2.3 + 1.7, -10])).toBe(true);
  });

  it("stand in a box on the floor that holds them however they are turned", () => {
    const turned = footprintBox(house("home:x", "x", [0, 0], 90));
    expect(turned.maxX - turned.minX).toBeCloseTo(4.6);
    expect(turned.maxZ - turned.minZ).toBeCloseTo(5.2);
    const slanted = footprintBox(house("home:x", "x", [0, 0], 87));
    expect(slanted.maxX - slanted.minX).toBeGreaterThan(4.6);
  });
});

describe("bodies going by", () => {
  const town = plan([
    house("home:planner", "planner", [-36, -10], 90),
    house("home:writer", "writer", [-24, -10], -90),
    office,
  ]);

  it("go in by their own building's door, or the office's for a room on one of its floors", () => {
    expect(near(doorInTown(town, "home:planner") as [number, number], outsideDoor(town.buildings[0], 1.1))).toBe(true);
    for (const place of ["room:local:standup", "office", "office:2"])
      expect(near(doorInTown(town, place) as [number, number], outsideDoor(office, 1.1))).toBe(true);
    expect(doorInTown(town, "shared:nowhere")).toBeUndefined();
  });

  it("walk from the door of where they were to the door of where they went", () => {
    const before = new Map([
      ["planner", "home:planner"],
      ["writer", "home:writer"],
    ]);
    const after = new Map([
      ["planner", "room:local:standup"],
      ["writer", "home:writer"],
    ]);
    expect(tripsBetween(before, after, town)).toEqual([
      { agent: "planner", from: doorInTown(town, "home:planner"), to: doorInTown(town, "room:local:standup") },
    ]);
  });

  it("make no walk staying in the same building, coming from nowhere, or going where the town has no door", () => {
    const office2 = tripsBetween(
      new Map([["planner", "room:local:standup"]]),
      new Map([["planner", "room:local:budget"]]),
      town,
    );
    expect(office2).toEqual([]);
    expect(tripsBetween(new Map(), new Map([["planner", "home:planner"]]), town)).toEqual([]);
    expect(tripsBetween(new Map([["planner", "home:planner"]]), new Map([["planner", "shared:gone"]]), town)).toEqual(
      [],
    );
  });
});
