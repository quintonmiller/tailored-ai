/**
 * Moving around the room: the way between spots, walking it at a steady pace
 * after turning to face the way, and when to wander or come back.
 */
import { describe, expect, it } from "vitest";
import { Director, route, turnBetween, Walker } from "./locomotion";
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
