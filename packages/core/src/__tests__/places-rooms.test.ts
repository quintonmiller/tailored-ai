/**
 * The rooms the world starts with: homes drawn from a seed, meeting rooms sized
 * by who is in them, and the lobby. The same seed always gives the same room,
 * homes differ from each other, nothing overlaps, every spot can be walked to,
 * each room keeps a stretch of wall clear for a door, and every home has
 * somewhere to sit, somewhere to work, a window and lamps.
 */
import { describe, expect, it } from "vitest";
import {
  DOORWAY,
  doorways,
  findPlacement,
  findSpot,
  firstHome,
  footprintOf,
  KINDS,
  LIMITS,
  PHOTO_FRAMES,
  PLACE_SCHEMA,
  type Place,
  placeProblems,
  unreachable,
  withSpots,
} from "../plugins/places-layout.js";
import { homePlace, lobby, meetingRoom, PRESETS, seeded, sharedPlace, THEMES } from "../plugins/places-rooms.js";
import { validateAgainstSchema } from "../state/validate.js";

const seeds = Array.from({ length: 120 }, (_, i) => `home:agent-${i}`);
const homes = seeds.map((s) => homePlace(s, s));
const meetings = [
  ...[2, 3, 4, 5, 6, 7, 9, 12, 16].map((n) => meetingRoom("standup", n)),
  ...THEMES.flatMap((t) => [3, 8].map((n) => meetingRoom(`${t.id} room`, n, `${t.words.source.split("|")[1]}`))),
];
const every = [...homes, ...meetings, lobby()];

describe("homes drawn from a seed", () => {
  it("are the same room every time for the same seed", () => {
    expect(homePlace("home:planner", "planner's room")).toEqual(homePlace("home:planner", "planner's room"));
    const a = seeded("x");
    const b = seeded("x");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("differ from each other: their size, colours and what is in them", () => {
    const sizes = new Set(homes.map((h) => `${h.width}x${h.depth}`));
    const walls = new Set(homes.map((h) => h.walls));
    const layouts = new Set(homes.map((h) => h.props.map((p) => `${p.kind}@${p.at}`).join(" ")));
    expect(sizes.size).toBeGreaterThanOrEqual(15);
    expect(walls.size).toBeGreaterThanOrEqual(12);
    expect(layouts.size).toBeGreaterThan(homes.length * 0.95);
    // Twelve agents in a row get at least five kinds of room between them.
    const kinds = (h: Place) => new Set(h.props.map((p) => p.kind));
    const signature = (h: Place) =>
      ["bed", "tv", "fireplace", "easel", "aquarium", "pegboard", "couch", "round_table"]
        .filter((k) => kinds(h).has(k))
        .join(",");
    expect(new Set(homes.slice(0, 12).map(signature)).size).toBeGreaterThanOrEqual(5);
  });

  it("are roomy: 8 to 10 m wide and 6 to 8 m deep, within what the tool allows", () => {
    for (const h of homes) {
      expect(h.width).toBeGreaterThanOrEqual(8);
      expect(h.width).toBeLessThanOrEqual(10);
      expect(h.depth).toBeGreaterThanOrEqual(6);
      expect(h.depth).toBeLessThanOrEqual(8);
      expect(h.height).toBeLessThanOrEqual(LIMITS.height[1]);
    }
  });

  it("always have somewhere to sit, somewhere to work, a window and lamps for the evening, whatever the preset", () => {
    for (const preset of PRESETS)
      for (const seed of seeds.slice(0, 15)) {
        const h = homePlace(seed, "a room", preset.id);
        const label = `${preset.id} ${seed}`;
        expect(
          h.spots.some((s) => s.activity === "sit" && s.seat),
          label,
        ).toBe(true);
        expect(
          h.spots.some((s) => s.activity === "type"),
          label,
        ).toBe(true);
        expect(
          h.props.some((p) => p.kind === "window"),
          label,
        ).toBe(true);
        expect(
          h.props.filter((p) => ["lamp", "table_lamp", "fireplace"].includes(p.kind)).length,
          label,
        ).toBeGreaterThanOrEqual(2);
        // Somewhere for the photos taken there to hang.
        expect(
          h.props.some((p) => PHOTO_FRAMES.includes(p.kind)),
          label,
        ).toBe(true);
      }
  });

  it("keep everything tall by the back and left walls, so nothing tall stands between the camera and the room", () => {
    for (const h of homes)
      for (const p of h.props) {
        const kind = KINDS[p.kind];
        if (kind?.mount !== "floor" || p.on || (p.size?.[1] ?? kind.height * (p.scale ?? 1)) <= 1.2) continue;
        const reach = Math.max(...footprintOf(p)) / 2;
        const fromWall = Math.min(p.at[1] + h.depth / 2, p.at[0] + h.width / 2) - reach;
        expect(fromWall, `${h.name}: ${p.name} at ${p.at}`).toBeLessThan(0.7);
      }
  });

  it("are drawn as any kind of home but a bedroom when shared", () => {
    for (let i = 0; i < 60; i++) {
      const place = sharedPlace(`shared:place-${i}`, `the place ${i}`);
      expect(
        place.props.some((p) => p.kind === "bed"),
        place.name,
      ).toBe(false);
      expect(placeProblems(place), place.name).toEqual([]);
    }
  });

  it("are furnished, not bare: a couple of dozen things or more", () => {
    for (const h of homes) expect(h.props.length).toBeGreaterThanOrEqual(18);
  });
});

describe("every room the world starts with", () => {
  it("is sound: nothing overlaps, nothing is outside, and no doorway hold is left behind", () => {
    for (const p of every) {
      expect(placeProblems(p), p.name).toEqual([]);
      expect(
        p.props.some((i) => i.id.startsWith("doorway-hold")),
        p.name,
      ).toBe(false);
      expect(p.width).toBeLessThanOrEqual(LIMITS.width[1]);
      expect(p.depth).toBeLessThanOrEqual(LIMITS.depth[1]);
      expect(p.props.length).toBeLessThanOrEqual(LIMITS.items);
      // What the store accepts: a room it would refuse can never be kept or changed.
      expect(validateAgainstSchema(PLACE_SCHEMA as never, p), p.name).toEqual([]);
    }
  });

  it("leaves an agent room to add as much again as a home starts with", () => {
    for (const h of homes) expect(LIMITS.items - h.props.length, h.name).toBeGreaterThanOrEqual(h.props.length);
  });

  it("keeps a stretch of wall clear for a door, with floor in front of it", () => {
    for (const p of every) {
      const found = doorways(p);
      expect(found.length, p.name).toBeGreaterThan(0);
      expect(found[0].width).toBeGreaterThanOrEqual(DOORWAY.width);
    }
    // The lobby is the hub: room for several.
    expect(doorways(lobby()).length).toBeGreaterThanOrEqual(3);
  });

  it("can be walked round: every spot is reachable from where everyone starts", () => {
    for (const p of every)
      expect(
        unreachable(p).map((s) => s.place),
        p.name,
      ).toEqual([]);
  });

  it("can be talked about: each spot is found by its words, and things can still be added in words", () => {
    for (const p of [...homes.slice(0, 10), lobby()]) {
      for (const s of p.spots) expect(findSpot(p, s.place)?.id, `${p.name}: ${s.place}`).toBe(s.id);
      const window = p.props.find((i) => i.kind === "window");
      if (window) expect(typeof findPlacement(p, { kind: "plant" }, { near: window.name })).not.toBe("string");
      expect(typeof findPlacement(p, { kind: "armchair" }, {})).not.toBe("string");
      expect(typeof findPlacement(p, { kind: "clock" }, { wall: "back" })).not.toBe("string");
    }
  });
});

describe("getting about", () => {
  it("finds a spot furniture has boxed in, and none in a room with a way to each", () => {
    const room = firstHome();
    expect(unreachable(room)).toEqual([]);
    // Crates on three sides of the window's spot, the wall on the fourth.
    const window = room.spots.find((s) => s.id === "window")!;
    const [x, z] = window.at;
    const crate = (id: string, at: [number, number], size: [number, number, number]) => ({
      id,
      name: id,
      kind: "block",
      at,
      facing: 0,
      size,
    });
    const boxed = withSpots({
      ...room,
      props: [
        ...room.props.filter((p) => p.id !== "bookshelf"),
        crate("a", [x, z - 0.6], [0.8, 0.5, 0.3]),
        crate("b", [x, z + 0.6], [0.8, 0.5, 0.3]),
        crate("c", [x + 0.6, z], [0.3, 0.5, 1.5]),
      ],
    });
    expect(unreachable(boxed).map((s) => s.id)).toEqual(["window"]);
  });

  it("lets someone walk up to a seat set at an angle", () => {
    const room = withSpots({
      ...firstHome(),
      props: [
        ...firstHome().props,
        { id: "angled", name: "the angled chair", kind: "armchair", at: [0.9, 0.9], facing: 40 },
      ],
    });
    expect(unreachable(room)).toEqual([]);
  });
});

describe("meeting rooms", () => {
  it("seat up to six round a round table, more at a long one, each facing the table", () => {
    for (const n of [2, 4, 6]) {
      const room = meetingRoom("standup", n);
      const table = room.props.find((p) => p.id === "table-1");
      expect(table?.kind).toBe("round_table");
      for (const seat of room.props.filter((p) => p.id.startsWith("seat-"))) {
        const toTable = (Math.atan2(table!.at[0] - seat.at[0], table!.at[1] - seat.at[1]) * 180) / Math.PI;
        expect(Math.abs(((toTable - seat.facing + 540) % 360) - 180)).toBeLessThan(2);
      }
    }
    for (const n of [7, 12, 16]) {
      const room = meetingRoom("standup", n);
      expect(room.props.filter((p) => /^table-\d+$/.test(p.id)).every((t) => t.kind === "table")).toBe(true);
      expect(room.props.filter((p) => p.id.startsWith("seat-"))).toHaveLength(n);
    }
  });

  it("each seat is a place to sit", () => {
    const room = meetingRoom("standup", 9);
    for (const seat of room.props.filter((p) => p.id.startsWith("seat-")))
      expect(room.spots.find((s) => s.item === seat.id)).toMatchObject({ activity: "sit", place: seat.name });
  });

  it("differ from each other by name: colours and what is on the walls, themed or not", () => {
    const names = Array.from({ length: 24 }, (_, i) => `room ${i + 1}`);
    const signature = (p: Place) => p.props.map((i) => `${i.kind}@${i.at}`).join(" ");
    const plain = names.map((n) => meetingRoom(n, 4));
    expect(new Set(plain.map((p) => `${p.walls} ${p.floor} ${p.floorColor}`)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(plain.map((p) => [...new Set(p.props.map((i) => i.kind))].sort().join())).size).toBeGreaterThan(2);
    expect(new Set(plain.map(signature)).size).toBeGreaterThan(names.length * 0.8);
    for (const theme of THEMES) {
      const rooms = names.map((n) => meetingRoom(`${n} ${theme.words.source.split("|")[1]}`, 4));
      expect(new Set(rooms.map((p) => p.walls)).size, theme.id).toBeGreaterThan(1);
      expect(
        rooms.every((p) => theme.palettes.some((c) => c.walls === p.walls)),
        theme.id,
      ).toBe(true);
    }
  });

  it("grow with the number of seats, and the lobby is bigger than any of them", () => {
    const area = (p: Place) => p.width * p.depth;
    expect(area(meetingRoom("standup", 9))).toBeGreaterThan(area(meetingRoom("standup", 3)));
    const biggest = Math.max(...[...meetings, ...homes].map(area));
    expect(area(lobby())).toBeGreaterThan(biggest);
  });
});
