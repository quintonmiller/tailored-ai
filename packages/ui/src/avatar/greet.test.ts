/** Where you stand when you go straight to an agent: in front of it, facing it, never in the furniture. */
import { describe, expect, it } from "vitest";
import { standsClear } from "./doors";
import { faceToFace, GREET_GAP, sideFor } from "./greet";

const room = { width: 8, depth: 6 };
const distance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The way from `from` to `to`, as the stage measures facing. */
const toward = (from: [number, number], to: [number, number]) => Math.atan2(to[0] - from[0], to[1] - from[1]);

describe("faceToFace", () => {
  it("stands in front of the agent, at the gap, turned to face it", () => {
    const at: [number, number] = [0, 0];
    const you = faceToFace(room, [], at, 0);
    expect(you.at[0]).toBeCloseTo(0);
    expect(you.at[1]).toBeCloseTo(GREET_GAP);
    expect(you.facing).toBeCloseTo(toward(you.at, at));
  });

  it("stands on the side asked for: the way the agent faces, or nearer the camera", () => {
    const you = faceToFace(room, [], [1, 0], Math.PI / 2);
    expect(you.at[0]).toBeCloseTo(1 + GREET_GAP);
    expect(you.at[1]).toBeCloseTo(0);
  });

  it("goes round the agent when a desk stands in front of it, and stays clear of the desk", () => {
    const desk = { minX: -0.6, maxX: 0.6, minZ: 0.5, maxZ: 1.5 };
    const at: [number, number] = [0, 0];
    const you = faceToFace(room, [desk], at, 0);
    expect(standsClear(room, [desk], you.at)).toBe(true);
    expect(distance(you.at, at)).toBeGreaterThan(0.8);
    expect(distance(you.at, at)).toBeLessThan(1.6);
    expect(you.facing).toBeCloseTo(toward(you.at, at));
  });

  it("stays inside the room for an agent facing a wall", () => {
    const at: [number, number] = [0, 2.6];
    const you = faceToFace(room, [], at, 0);
    expect(standsClear(room, [], you.at)).toBe(true);
    expect(Math.abs(you.at[1])).toBeLessThan(room.depth / 2);
  });
});

describe("sideFor", () => {
  const open: [number, number] = [-0.25, 1.25];

  it("stands toward the camera, at the edge of what it sees nearer the way the agent faces", () => {
    expect(sideFor(0, open)).toBe(-0.25);
    expect(sideFor(Math.PI / 2, open)).toBe(1.25);
    // Facing a wall at the back: the nearer turn round to the camera's side.
    expect(sideFor(Math.PI - 0.1, open)).toBe(1.25);
    expect(sideFor(-Math.PI / 2, open)).toBe(-0.25);
  });
});
