/**
 * Moving around the room: the way between spots, walking it at a steady pace
 * after turning to face the way, and when to wander or come back.
 */
import { describe, expect, it } from "vitest";
import {
  ASK,
  Director,
  findPath,
  inTheWay,
  type Obstacle,
  PASSING_ROOM,
  route,
  slide,
  standingIn,
  turnBetween,
  Walker,
} from "./locomotion";
import { DEFAULT_ROOM, spotById } from "./scene";
import { VISITOR_TURN, WALK_SPEED } from "./travel";

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

  it("finds its way across a room as big as the lobby, round a row of things in the middle", () => {
    const big = { ...room, width: 14, depth: 10 };
    const row: Obstacle[] = [-4, -2, 0, 2].map((x) => ({ minX: x - 0.9, maxX: x + 0.9, minZ: -0.5, maxZ: 0.5 }));
    const from: [number, number] = [-1, -3.5];
    const to: [number, number] = [-1, 3.5];
    const way = findPath(big, from, to, row, 0.2);
    expect(way.at(-1)).toEqual(to);
    for (const o of row) expect(crosses(from, way, o, 0.2)).toBe(false);
    // Round the end of the row, not through it.
    expect(way.some(([x]) => x > 2.9 || x < -4.9)).toBe(true);
  });

  it("can start and end close to furniture, as a spot by a desk is", () => {
    const desk: Obstacle = { minX: 0.75, maxX: 1.95, minZ: -1.77, maxZ: -1.17 };
    const way = findPath(DEFAULT_ROOM, [-0.85, -0.72], [1.35, -0.98], [desk, sofa], 0.2);
    expect(way.at(-1)).toEqual([1.35, -0.98]);
  });
});

describe("walking round you", () => {
  // An empty room 8 by 6.5, you standing in the middle of it, an agent crossing it from left to right.
  const room = { ...DEFAULT_ROOM, width: 8, depth: 6.5, props: [] };
  const you: [number, number] = [0, 0];
  const yours = 0.25;
  const theirs = 0.2;
  /** The nearest the walk from `from` along `way` comes to where you stand. */
  const closest = (from: [number, number], way: [number, number][]) => {
    let near = Number.POSITIVE_INFINITY;
    let a = from;
    for (const b of way) {
      for (let k = 0; k <= 50; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / 50;
        const z = a[1] + ((b[1] - a[1]) * k) / 50;
        near = Math.min(near, Math.hypot(x - you[0], z - you[1]));
      }
      a = b;
    }
    return near;
  };

  it("goes round you with room to pass, rather than through you", () => {
    const from: [number, number] = [-3, 0.05];
    const to: [number, number] = [3, -0.05];
    // Without you in the reckoning, straight through.
    expect(closest(from, findPath(room, from, to, [], theirs))).toBeLessThan(0.1);
    const way = findPath(room, from, to, [standingIn(you, yours)], theirs);
    expect(closest(from, way)).toBeGreaterThanOrEqual(yours + PASSING_ROOM + theirs - 0.01);
    expect(way.at(-1)).toEqual(to);
  });

  it("knows when you are in the way of a walk, and when you are not", () => {
    expect(inTheWay([-3, 0], [[3, 0]], you, 0.55)).toBe(true);
    // A leg that passes you by a metre.
    expect(inTheWay([-3, 1], [[3, 1]], you, 0.55)).toBe(false);
    // You are on the second leg.
    expect(
      inTheWay(
        [-3, 2],
        [
          [-1, 0],
          [3, 0],
        ],
        you,
        0.55,
      ),
    ).toBe(true);
    // Behind it: what it has walked already doesn't count.
    expect(inTheWay([1, 0], [[3, 0]], you, 0.55)).toBe(false);
    // Nowhere to walk.
    expect(inTheWay([1, 0], [], you, 0.55)).toBe(false);
  });

  it("leaves be a walk that ends where you stand, since no way round gets it there", () => {
    expect(inTheWay([-3, 0], [[0.2, 0]], you, 0.55)).toBe(false);
  });

  it("finds no one in the way once it has gone round", () => {
    const from: [number, number] = [-3, 0.05];
    const way = findPath(room, from, [3, -0.05], [standingIn(you, yours)], theirs);
    expect(inTheWay(from, way, you, yours + theirs + 0.1)).toBe(false);
  });

  it("walks on by a new way and still turns as it meant to at the end", () => {
    const w = new Walker({ x: -3, z: 0, facing: Math.PI / 2 }, 2);
    w.go([[3, 0]], 0);
    w.reroute([
      [-1, 1],
      [3, 0],
    ]);
    expect(w.way).toEqual([
      [-1, 1],
      [3, 0],
    ]);
    for (let i = 0; i < 400; i++) w.step(0.02);
    expect([w.place.x, w.place.z]).toEqual([3, 0]);
    expect(w.place.facing).toBeCloseTo(0, 2);
    expect(w.busy).toBe(false);
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

  it("crosses a room behind it in under a second and a half at a visitor's pace, turning quickly first", () => {
    const visitor = new Walker({ x: 0, z: 0, facing: 0 }, WALK_SPEED);
    visitor.turnSpeed = VISITOR_TURN;
    visitor.go([[0, -3]], Math.PI);
    expect(walk(visitor, 10).seconds).toBeLessThan(1.5);
    // At an agent's turning pace the same walk takes longer: the turn alone is most of a second.
    const agent = new Walker({ x: 0, z: 0, facing: 0 }, WALK_SPEED);
    agent.go([[0, -3]], Math.PI);
    expect(walk(agent, 10).seconds).toBeGreaterThan(1.6);
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

describe("Director, with something to do", () => {
  it("goes where the pick says, and stays as long as the pick says", () => {
    const picks: string[] = [];
    const d = new Director(
      DEFAULT_ROOM,
      () => 0.5,
      false,
      (here) => {
        picks.push(here);
        return { spot: "bookshelf", stay: [100, 100] };
      },
    );
    d.decide(0, "middle", false);
    expect(d.decide(60, "middle", false)).toBe("bookshelf");
    expect(picks).toEqual(["middle"]);
    d.sent();
    // There, it keeps at it for the pick's stay, far longer than a wander's.
    d.decide(61, "bookshelf", false);
    expect(d.decide(150, "bookshelf", false)).toBeUndefined();
    expect(d.decide(162, "bookshelf", false)).toBe("bookshelf");
  });

  it("wanders at random when there is nothing to pick", () => {
    const d = new Director(
      DEFAULT_ROOM,
      () => 0.5,
      false,
      () => undefined,
    );
    d.decide(0, "middle", false);
    const next = d.decide(60, "middle", false);
    expect(next).toBeDefined();
    expect(next).not.toBe("middle");
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
