/**
 * Moving around the room: the way between spots, walking it at a steady pace
 * after turning to face the way, and when to wander or come back.
 */
import { describe, expect, it } from "vitest";
import { ASK, Director, findPath, type Obstacle, route, slide, turnBetween, Walker } from "./locomotion";
import { DEFAULT_ROOM, spotById } from "./scene";

const at = (id: string) => spotById(DEFAULT_ROOM, id)?.at;

describe("route", () => {
  it("goes straight between the middle and any spot", () => {
    expect(route(DEFAULT_ROOM, "middle", "couch")).toEqual([at("couch")]);
    expect(route(DEFAULT_ROOM, "desk", "middle")).toEqual([at("middle")]);
  });

  it("goes by way of the middle between two other spots, so it never cuts through furniture", () => {
    expect(route(DEFAULT_ROOM, "couch", "desk")).toEqual([at("middle"), at("desk")]);
  });

  it("goes by way of the middle from partway along a walk", () => {
    expect(route(DEFAULT_ROOM, undefined, "window")).toEqual([at("middle"), at("window")]);
  });

  it("has nowhere to go for the spot it is at, or a spot that does not exist", () => {
    expect(route(DEFAULT_ROOM, "couch", "couch")).toEqual([]);
    expect(route(DEFAULT_ROOM, "couch", "attic")).toEqual([]);
  });
});

describe("findPath", () => {
  const room = { ...DEFAULT_ROOM, props: [], spots: [] };
  /** A sofa-sized box right across the straight way. */
  const sofa: Obstacle = { minX: -0.8, maxX: 0.8, minZ: -0.4, maxZ: 0.4 };
  /** Whether any leg of the walk passes through the box, grown by the body's radius. */
  const crosses = (from: [number, number], way: [number, number][], o: Obstacle, r: number) => {
    let a = from;
    for (const b of way) {
      for (let k = 0.02; k < 1; k += 0.02) {
        const x = a[0] + (b[0] - a[0]) * k;
        const z = a[1] + (b[1] - a[1]) * k;
        if (x > o.minX - r + 0.01 && x < o.maxX + r - 0.01 && z > o.minZ - r + 0.01 && z < o.maxZ + r - 0.01)
          return true;
      }
      a = b;
    }
    return false;
  };

  it("walks straight there when nothing is in the way", () => {
    expect(findPath(room, [-1.5, 1], [1.5, 1], [sofa], 0.2)).toEqual([[1.5, 1]]);
  });

  it("goes round something in the way in a few straight legs, ending where it was going", () => {
    const from: [number, number] = [0, -1.2];
    const to: [number, number] = [0, 1.2];
    const way = findPath(room, from, to, [sofa], 0.2);
    expect(way.at(-1)).toEqual(to);
    expect(crosses(from, way, sofa, 0.2)).toBe(false);
    expect(way.length).toBeLessThanOrEqual(4);
  });

  it("goes straight when there is no way round, rather than nowhere", () => {
    const wall: Obstacle = { minX: -3, maxX: 3, minZ: -0.1, maxZ: 0.1 };
    expect(findPath(room, [0, -1], [0, 1], [wall], 0.2)).toEqual([[0, 1]]);
  });

  it("can start and end close to furniture, as a spot by a desk is", () => {
    const desk: Obstacle = { minX: 0.75, maxX: 1.95, minZ: -1.77, maxZ: -1.17 };
    const way = findPath(DEFAULT_ROOM, [-0.85, -0.72], [1.35, -0.98], [desk, sofa], 0.2);
    expect(way.at(-1)).toEqual([1.35, -0.98]);
  });
});

describe("slide", () => {
  const room = { width: 4, depth: 4 };
  const table: Obstacle = { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 };
  const r = 0.2;

  it("walks as far as it is told when nothing is in the way", () => {
    expect(slide(room, [1, 1], [0.1, -0.2], [table], r)).toEqual([1.1, 0.8]);
  });

  it("stays on the floor", () => {
    expect(slide(room, [1.7, 0], [0.5, 0], [], r)).toEqual([1.8, 0]);
    expect(slide(room, [0, -1.7], [0, -0.5], [], r)).toEqual([0, -1.8]);
  });

  it("slides along furniture instead of stopping dead, and never walks into it", () => {
    // Walking diagonally into the table's side: the part along it still goes.
    const [x, z] = slide(room, [-0.8, 0], [0.2, 0.1], [table], r);
    expect(x).toBeCloseTo(-0.8);
    expect(z).toBeCloseTo(0.1);
    // Straight into it: no further.
    expect(slide(room, [-0.75, 0], [0.2, 0], [table], r)).toEqual([-0.75, 0]);
  });

  it("lets a body already inside something walk out", () => {
    expect(slide(room, [0, 0], [0.1, 0], [table], r)).toEqual([0.1, 0]);
  });
});

describe("turnBetween", () => {
  it("takes the short way round", () => {
    expect(turnBetween(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(turnBetween(3, -3)).toBeCloseTo(2 * Math.PI - 6);
  });
});

describe("Walker", () => {
  /** Step at 60 fps until it stops, or for `seconds` at most. */
  function walk(w: Walker, seconds: number) {
    let walked = 0;
    let steps = 0;
    for (; steps < seconds * 60 && (w.busy || steps === 0); steps++) walked += w.step(1 / 60);
    return { walked, seconds: steps / 60 };
  }

  it("turns to face the way before it walks", () => {
    const w = new Walker({ x: 0, z: 0, facing: 0 }, 1);
    w.go([[-1, 0]], 0);
    expect(w.step(1 / 60)).toBe(0);
    expect(w.place.facing).toBeLessThan(0);
  });

  it("walks the legs at its own pace, then turns to face where the spot faces", () => {
    const w = new Walker({ x: 0, z: 0, facing: 0 }, 0.5);
    w.go(
      [
        [0, 1],
        [1, 1],
      ],
      Math.PI,
    );
    const { walked, seconds } = walk(w, 20);
    expect(walked).toBeCloseTo(2, 2);
    expect(seconds).toBeGreaterThan(4);
    expect(w.place).toMatchObject({ x: 1, z: 1 });
    expect(w.place.facing).toBeCloseTo(Math.PI);
    expect(w.busy).toBe(false);
  });

  it("drops a walk under way for a new one", () => {
    const w = new Walker({ x: 0, z: 0, facing: 0 }, 1);
    w.go([[0, 5]], 0);
    walk(w, 0.5);
    w.go([[0, 0]], 0);
    walk(w, 10);
    expect(w.place.z).toBeCloseTo(0, 3);
  });
});

describe("Director", () => {
  const steady = () => 0.5;

  it("stays a while at a spot, then wanders somewhere else", () => {
    const d = new Director(DEFAULT_ROOM, steady);
    expect(d.decide(0, "middle", false)).toBeUndefined();
    expect(d.decide(10, "middle", false)).toBeUndefined();
    const next = d.decide(60, "middle", false);
    expect(next).toBeDefined();
    expect(next).not.toBe("middle");
  });

  it("stays longer once it has sat down", () => {
    const d = new Director(DEFAULT_ROOM, steady);
    d.decide(0, "couch", false);
    expect(d.decide(35, "couch", false)).toBeUndefined();
    expect(d.decide(70, "couch", false)).toBeDefined();
  });

  it("decides nothing while it is walking", () => {
    const d = new Director(DEFAULT_ROOM, steady);
    expect(d.decide(0, undefined, false)).toBeUndefined();
    expect(d.decide(500, undefined, false)).toBeUndefined();
  });

  it("comes back to the middle when a session starts, and stays put through it", () => {
    const d = new Director(DEFAULT_ROOM, steady);
    d.decide(0, "window", false);
    expect(d.decide(1, "window", true)).toBe("middle");
    expect(d.decide(2, undefined, true)).toBeUndefined();
    expect(d.decide(500, "middle", true)).toBeUndefined();
  });

  it("starts the stay over after it has been sent somewhere", () => {
    const d = new Director(DEFAULT_ROOM, steady);
    d.decide(0, "middle", false);
    d.sent();
    expect(d.decide(60, "desk", false)).toBeUndefined();
  });
});

describe("Director, when the agent chooses", () => {
  it("asks the agent every few minutes instead of picking a spot, and never during a conversation", () => {
    const d = new Director(DEFAULT_ROOM, () => 0.5, true);
    expect(d.decide(0, "middle", false)).toBeUndefined();
    expect(d.decide(60, "middle", false)).toBeUndefined();
    expect(d.decide(200, "middle", false)).toBe(ASK);
    d.sent();
    expect(d.decide(201, "middle", true)).toBeUndefined();
    expect(d.decide(900, "middle", true)).toBeUndefined();
  });
});
