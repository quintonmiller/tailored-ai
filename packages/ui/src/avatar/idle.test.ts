/**
 * What an idle body does: somewhere to stand by things that bring no spot,
 * and a choice of small things to do from what the room has, weighted by the
 * hour and drawn per agent.
 */
import { describe, expect, it } from "vitest";
import { idleStyle } from "./body";
import { chooseErrand, errandAt, idleSpots, isMeeting, likesOf, seeded, stayLength } from "./idle";
import type { Obstacle } from "./locomotion";
import type { Prop, Room } from "./scene";

/** A box round a thing on the floor, the way the stage measures what it built. */
const box = (at: [number, number], w: number, d: number): Obstacle => ({
  minX: at[0] - w / 2,
  maxX: at[0] + w / 2,
  minZ: at[1] - d / 2,
  maxZ: at[1] + d / 2,
});

const prop = (id: string, kind: Prop["kind"], at: [number, number], extra: Partial<Prop> = {}): Prop => ({
  id,
  name: `the ${id.replace(/-/g, " ")}`,
  kind,
  at,
  facing: 0,
  ...extra,
});

/** A small home: a couch, a desk, a window, a bookshelf, and things with no spot of their own. */
const home: Room = {
  width: 8,
  depth: 6,
  height: 2.8,
  start: "middle",
  props: [
    prop("couch", "couch", [-2, -2.55], { spot: "couch" }),
    prop("desk", "desk", [1.5, -2.65], { spot: "desk" }),
    prop("window", "window", [-3.96, 0], { facing: 90, elevation: 1, spot: "window" }),
    prop("bookshelf", "bookshelf", [-3.8, 1.8], { facing: 90, spot: "bookshelf" }),
    prop("plant", "plant", [3.6, 2.6]),
    prop("board", "board", [0, -2.97], { elevation: 1.05 }),
    prop("sideboard", "sideboard", [3.7, -0.5], { facing: -90 }),
    prop("aquarium", "aquarium", [3.7, -0.5], { on: "sideboard", elevation: 0.8 }),
    prop("lamp", "lamp", [-3.6, -2.6]),
  ],
  spots: [
    { id: "middle", name: "in the middle", place: "the middle", at: [0, 0.5], facing: 20 },
    {
      id: "couch",
      name: "on the couch",
      place: "the couch",
      at: [-2, -1.9],
      facing: 0,
      activity: "sit",
      seat: { at: [-2, -2.4], height: 0.47 },
      item: "couch",
    },
    {
      id: "desk",
      name: "at the desk",
      place: "the desk",
      at: [1.5, -2.15],
      facing: 180,
      activity: "type",
      item: "desk",
    },
    {
      id: "window",
      name: "at the window",
      place: "the window",
      at: [-3.4, 0],
      facing: -90,
      activity: "look",
      item: "window",
    },
    {
      id: "bookshelf",
      name: "by the bookshelf",
      place: "the bookshelf",
      at: [-3.3, 1.8],
      facing: -90,
      activity: "browse",
      item: "bookshelf",
    },
  ],
};
const plantBox = box([3.6, 2.6], 0.34, 0.34);
const obstacles = [
  box([-2, -2.55], 1.6, 0.8),
  box([1.5, -2.65], 1.2, 0.6),
  box([-3.8, 1.8], 0.32, 0.9),
  plantBox,
  box([3.7, -0.5], 0.45, 1.6),
  box([-3.6, -2.6], 0.36, 0.36),
];
const withSpots = (room: Room): Room => ({ ...room, spots: [...room.spots, ...idleSpots(room, obstacles)] });

describe("idleSpots", () => {
  it("adds somewhere to stand by a plant, the task board and a sideboard, facing each", () => {
    const spots = idleSpots(home, obstacles);
    expect(spots.map((s) => [s.id, s.for])).toEqual([
      ["idle:plant", "plant"],
      ["idle:board", "board"],
      ["idle:sideboard", "fish"],
    ]);
    const board = spots.find((s) => s.id === "idle:board");
    // In front of it, looking at it, chin up.
    expect(board?.at[1]).toBeCloseTo(-1.97, 1);
    expect(Math.abs(board?.facing ?? 0)).toBeCloseTo(180, 0);
    expect(board?.activity).toBe("look");
    // The plant is in the front right corner: stood by on its side toward the middle of the room.
    const plant = spots.find((s) => s.id === "idle:plant");
    expect(plant?.at[0]).toBeLessThan(3.6);
    expect(plant?.at[1]).toBeLessThan(2.6);
  });

  it("stands clear of the furniture and of the room's own spots", () => {
    // A plant out in the floor, with something right where it would stand to water it: it goes round to another side.
    const room = {
      ...home,
      props: home.props.map((p) => (p.id === "plant" ? { ...p, at: [2.5, 2.2] as [number, number] } : p)),
    };
    const crowded = [
      ...obstacles.filter((o) => o !== plantBox),
      box([2.5, 2.2], 0.34, 0.34),
      box([2.09, 1.84], 0.2, 0.2),
    ];
    const spots = idleSpots(room, crowded);
    expect(spots.some((s) => s.id === "idle:plant")).toBe(true);
    for (const s of spots) {
      for (const o of crowded) {
        const inside =
          s.at[0] > o.minX - 0.2 && s.at[0] < o.maxX + 0.2 && s.at[1] > o.minZ - 0.2 && s.at[1] < o.maxZ + 0.2;
        expect(inside, `${s.id} in the way of something`).toBe(false);
      }
      for (const own of home.spots) expect(Math.hypot(own.at[0] - s.at[0], own.at[1] - s.at[1])).toBeGreaterThan(0.5);
    }
  });

  it("adds somewhere to stand in front of what an agent made, on the floor or on a wall, but nothing to do there", () => {
    const room: Room = {
      ...home,
      props: [
        ...home.props,
        // A bookcase out on the floor, turned to face the couch, as big as it was made.
        prop("bookcase", "model", [2, 1.2], { facing: 180, size: [1.2, 1.6, 0.4], scale: 2 }),
        prop("clock", "wall_model", [3.96, 1], { facing: -90, elevation: 1.6, size: [0.4, 0.4, 0.06] }),
        prop("vase", "small_model", [1.5, -2.65], { on: "desk", size: [0.2, 0.3, 0.2] }),
      ],
    };
    const spots = idleSpots(room, [...obstacles, box([2, 1.2], 1.2, 0.4)]);
    const bookcase = spots.find((s) => s.id === "idle:bookcase");
    // A step out past its front: half its depth, already as big as it was made, and a step as long as it is big.
    expect(bookcase?.at[0]).toBeCloseTo(2, 2);
    expect(bookcase?.at[1]).toBeCloseTo(1.2 - 0.2 - 1, 2);
    expect(Math.abs(bookcase?.facing ?? 0)).toBeCloseTo(0, 0);
    expect(bookcase).toMatchObject({ name: "by the bookcase", place: "the bookcase", activity: "look" });
    expect(bookcase?.for).toBeUndefined();
    const clock = spots.find((s) => s.id === "idle:clock");
    expect(clock?.at[0]).toBeLessThan(3.96 - 0.5);
    // One on top of something else is stood by at that, not here.
    expect(spots.some((s) => s.id === "idle:vase")).toBe(false);
    // Nothing to do there of its own accord: a body only goes there when it says so.
    const all = { ...room, spots: [...room.spots, ...spots] };
    expect(errandAt(all, "idle:bookcase", 10, seeded("x"))).toBeUndefined();
  });

  it("adds none for a thing with nowhere clear in front of it", () => {
    const blocked = [...obstacles, box([0, -2.3], 3, 1.2)];
    expect(idleSpots(home, blocked).some((s) => s.id === "idle:board")).toBe(false);
  });
});

describe("chooseErrand", () => {
  const room = withSpots(home);
  const tally = (hour: number, n = 400, seed = "planner") => {
    const random = seeded(seed);
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const e = chooseErrand(room, { hour, random });
      if (e) counts[e.id] = (counts[e.id] ?? 0) + 1;
    }
    return counts;
  };

  it("does something specific with what the room has, at a spot it has", () => {
    const e = chooseErrand(room, { hour: 10, random: seeded("planner") });
    expect(e).toBeDefined();
    expect(room.spots.map((s) => s.id)).toContain(e?.spot);
    expect(e?.label).toMatch(/\w/);
  });

  it("makes coffee in the morning and naps late at night", () => {
    const top = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    // A sideboard with nothing on it is somewhere to make a coffee.
    const kitchen = withSpots({ ...home, props: home.props.filter((p) => p.kind !== "aquarium") });
    const random = seeded("planner");
    const coffees = (hour: number) =>
      Array.from({ length: 400 }, () => chooseErrand(kitchen, { hour, random })?.id).filter((id) => id === "coffee")
        .length;
    expect(coffees(8)).toBeGreaterThan(2 * coffees(20));
    const morning = tally(8);
    expect(morning.nap ?? 0).toBeLessThan(10);
    const night = tally(2);
    expect(top(night)).toBe("nap");
    expect(night.water ?? 0).toBeLessThan(10);
    // The task board is for the working day.
    expect(tally(11).board ?? 0).toBeGreaterThan(3 * (tally(21).board ?? 0));
  });

  it("holds what it needs and does what the spot is for", () => {
    const random = seeded("writer");
    const seen = new Map<string, ReturnType<typeof chooseErrand>>();
    for (let i = 0; i < 300; i++) {
      const e = chooseErrand(room, { hour: 9, random });
      if (e) seen.set(e.id, e);
    }
    expect(seen.get("water")).toMatchObject({ spot: "idle:plant", hold: { prop: "watering_can", how: "out" } });
    expect(seen.get("board")).toMatchObject({ spot: "idle:board", activity: "look" });
    expect(seen.get("tidy")).toMatchObject({ spot: "desk", hold: { prop: "folder" } });
    // Tidying stands at the desk rather than typing at it.
    expect(seen.get("tidy")?.activity).toBeUndefined();
    expect(seen.get("stretch")).toMatchObject({ spot: "middle", gesture: "stretch" });
  });

  it("draws differently for different agents, and the same for the same one", () => {
    const run = (seed: string) => {
      const random = seeded(seed);
      return Array.from({ length: 8 }, () => chooseErrand(room, { hour: 15, random })?.id).join(",");
    };
    expect(run("planner")).toBe(run("planner"));
    expect(run("planner")).not.toBe(run("writer"));
  });

  it("moves on: what it did last comes up less", () => {
    const random = seeded("planner");
    let again = 0;
    for (let i = 0; i < 300; i++) if (chooseErrand(room, { hour: 8, random, last: "water" })?.id === "water") again++;
    const fresh = tally(8, 300).water ?? 0;
    expect(fresh).toBeGreaterThan(20);
    expect(again).toBeLessThan(fresh / 3);
  });

  it("moves on: where it is now comes up less", () => {
    const random = seeded("planner");
    let stays = 0;
    for (let i = 0; i < 300; i++)
      if (chooseErrand(room, { hour: 8, random, here: "idle:plant" })?.spot === "idle:plant") stays++;
    expect(stays).toBeLessThan((tally(8, 300).water ?? 0) / 3);
  });

  it("does more of what it likes, and what its idle style draws it to", () => {
    const count = (likes: Record<string, number>, id: string) => {
      const random = seeded("planner");
      let n = 0;
      for (let i = 0; i < 400; i++) if (chooseErrand(room, { hour: 15, random, likes })?.id === id) n++;
      return n;
    };
    expect(count(likesOf({}, ["read"]), "read")).toBeGreaterThan(1.6 * count({}, "read"));
    expect(count(likesOf(idleStyle("sleepy").likes), "nap")).toBeGreaterThan(3 * count({}, "nap"));
    // What it likes is never all it does.
    expect(400 - count(likesOf({}, ["read"]), "read")).toBeGreaterThan(100);
    expect(errandAt(room, "couch", 15, seeded("x"), likesOf({}, ["nap"]))).toBeDefined();
  });

  it("never goes where someone else is", () => {
    const random = seeded("planner");
    const taken = new Set(room.spots.map((s) => s.id).filter((id) => id !== "window"));
    for (let i = 0; i < 20; i++) expect(chooseErrand(room, { hour: 10, random, taken })?.spot).toBe("window");
    expect(chooseErrand(room, { hour: 10, random, taken: new Set(room.spots.map((s) => s.id)) })).toBeUndefined();
  });

  it("sits in at a meeting room's table", () => {
    const meeting: Room = {
      ...home,
      spots: [
        ...home.spots,
        ...[1, 2, 3].map((i) => ({
          id: `seat-${i}`,
          name: `seat ${i}`,
          place: `seat ${i}`,
          at: [i - 2, 1.5] as [number, number],
          facing: 180,
          activity: "sit" as const,
          seat: { at: [i - 2, 1.9] as [number, number], height: 0.45 },
        })),
      ],
    };
    expect(isMeeting(meeting)).toBe(true);
    expect(isMeeting(home)).toBe(false);
    const random = seeded("planner");
    let seated = 0;
    for (let i = 0; i < 100; i++) if (chooseErrand(meeting, { hour: 15, random })?.id === "listen") seated++;
    expect(seated).toBeGreaterThan(50);
    // Its tag says what it sits in on: "sitting in" alone reads as cut off.
    expect(errandAt(meeting, "seat-1", 15, seeded("a"))?.label).toBe("sitting in on the meeting");
  });
});

describe("errandAt", () => {
  const room = withSpots(home);
  it("says what it does at a spot it was sent to", () => {
    expect(errandAt(room, "bookshelf", 15, seeded("a"))?.id).toMatch(/^(read|browse)$/);
    expect(errandAt(room, "window", 15, seeded("a"))).toMatchObject({ id: "window", activity: "look" });
    expect(errandAt(room, "idle:sideboard", 15, seeded("a"))).toMatchObject({ id: "fish" });
  });

  it("naps on the couch late at night", () => {
    const random = seeded("planner");
    let naps = 0;
    for (let i = 0; i < 100; i++) {
      const e = errandAt(room, "couch", 2, random);
      if (e?.id === "nap") {
        naps++;
        expect(e).toMatchObject({ doze: true, activity: "sit" });
      }
    }
    expect(naps).toBeGreaterThan(50);
  });

  it("perches on a stool, but never naps on one", () => {
    const perch: Room = {
      ...room,
      props: [...room.props, prop("stool", "stool", [2, 1])],
      spots: [
        ...room.spots,
        {
          id: "stool",
          name: "on the stool",
          place: "the stool",
          at: [2, 1.38],
          facing: 0,
          activity: "sit",
          seat: { at: [2, 1], height: 0.5 },
          item: "stool",
        },
      ],
    };
    const random = seeded("planner");
    const ids = new Set(Array.from({ length: 60 }, () => errandAt(perch, "stool", 2, random)?.id));
    expect(ids.has("nap")).toBe(false);
    expect(ids.has("sit")).toBe(true);
  });

  it("has nothing to do at a spot it doesn't know", () => {
    expect(errandAt(room, "nowhere", 15, seeded("a"))).toBeUndefined();
  });

  it("staying at a spot it chose, does only what lasts there, and something else after what it did last", () => {
    // In the middle there is only a stretch, a one-off gesture: staying there, nothing to do over and over.
    expect(errandAt(room, "middle", 15, seeded("a"))?.id).toBe("stretch");
    expect(errandAt(room, "middle", 15, seeded("a"), {}, {})).toBeUndefined();
    // At the bookshelf, after reading, browsing comes up far more often than reading again.
    const random = seeded("planner");
    const picks = Array.from({ length: 200 }, () => errandAt(room, "bookshelf", 15, random, {}, { last: "read" })?.id);
    const again = picks.filter((id) => id === "read").length;
    expect(again).toBeLessThan(picks.length - again);
  });

  it("keeps at it, staying, for a time in its own span, longer or shorter as its idle style has it", () => {
    const errand = errandAt(room, "window", 15, seeded("a"));
    if (!errand) throw new Error("no errand at the window");
    const [lo, hi] = errand.seconds;
    expect(stayLength(errand, 1, () => 0)).toBe(lo);
    expect(stayLength(errand, 1, () => 0.999)).toBeCloseTo(hi, 0);
    expect(stayLength(errand, 1.5, () => 0)).toBe(lo * 1.5);
  });
});
