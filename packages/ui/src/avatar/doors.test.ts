import { describe, expect, it } from "vitest";
import { ARRIVE_IN, arrivalAt, DOOR_REACH, doorFrame, doorLight, doorReached, doorTo, inDoorway } from "./doors";
import type { RoomDoor } from "./scene";

const room = {
  width: 10,
  depth: 6,
  doors: [
    { wall: "back", along: 3, to: "hall:main:homes-1", label: "Residences", kind: "hall" },
    { wall: "left", along: 1, to: "home:planner", label: "planner", kind: "home", occupant: "planner" },
    { wall: "front", along: -2, to: "lobby", label: "Lobby", kind: "lobby" },
    { wall: "right", along: 0, to: "hall:main:homes-2", label: "Residences N–Z", kind: "hall" },
  ] satisfies RoomDoor[],
};
const [back, left, front, right] = room.doors;

describe("doors", () => {
  it("stand at their side of the room, facing in", () => {
    expect(doorFrame(room, back)).toEqual({ at: [3, -3], facing: 0 });
    expect(doorFrame(room, left)).toEqual({ at: [-5, 1], facing: 90 });
    expect(doorFrame(room, front)).toEqual({ at: [-2, 3], facing: 180 });
    expect(doorFrame(room, right)).toEqual({ at: [5, 0], facing: -90 });
  });

  it("let you in just inside, facing into the room, clear of the doorway", () => {
    const at = (door: RoomDoor) => arrivalAt(room, door).at.map((n) => Math.round(n * 100) / 100);
    expect(at(back)).toEqual([3, -3 + ARRIVE_IN]);
    expect(at(left)).toEqual([-5 + ARRIVE_IN, 1]);
    expect(at(front)).toEqual([-2, 3 - ARRIVE_IN]);
    expect(at(right)).toEqual([5 - ARRIVE_IN, 0]);
    expect(arrivalAt(room, back).facing).toBe(0);
    expect(arrivalAt(room, left).facing).toBeCloseTo(Math.PI / 2);
    for (const door of room.doors) expect(inDoorway(room, door, arrivalAt(room, door).at)).toBe(false);
    expect(ARRIVE_IN).toBeGreaterThan(DOOR_REACH);
  });

  it("find the door back to where you came from", () => {
    expect(doorTo(room, "lobby")).toBe(front);
    expect(doorTo(room, "shared:attic")).toBeUndefined();
    expect(doorTo(room, undefined)).toBeUndefined();
  });

  it("take you through when you walk into one, not when you walk past it or away", () => {
    // Up to the back door, walking toward the wall.
    expect(doorReached(room, [3.2, -2.7], [0, -0.05])).toBe(back);
    // Along the wall past it.
    expect(doorReached(room, [3.2, -2.7], [0.05, 0])).toBeUndefined();
    // Away from it.
    expect(doorReached(room, [3.2, -2.7], [0, 0.05])).toBeUndefined();
    // Toward the wall, but beside the door.
    expect(doorReached(room, [4.5, -2.7], [0, -0.05])).toBeUndefined();
    // Too far into the room yet.
    expect(doorReached(room, [3, -1.5], [0, -0.05])).toBeUndefined();
    // Standing still.
    expect(doorReached(room, [3, -2.7], [0, 0])).toBeUndefined();
    // The open sides work the same way.
    expect(doorReached(room, [-2, 2.75], [0.01, 0.05])).toBe(front);
    expect(doorReached(room, [4.8, 0.2], [0.05, 0])).toBe(right);
    expect(doorReached(room, [-4.75, 1.3], [-0.05, 0])).toBe(left);
  });

  it("light up by what the agent behind them is doing, brightest when it needs you", () => {
    expect(doorLight("waiting").glow).toBeGreaterThan(doorLight("working").glow);
    expect(doorLight("asleep").glow).toBeLessThan(doorLight("idle").glow);
    expect(
      new Set(["working", "thinking", "waiting", "stuck", "idle", "asleep"].map((d) => doorLight(d as never).color))
        .size,
    ).toBe(6);
    expect(doorLight(undefined)).toEqual(doorLight("idle"));
  });
});
