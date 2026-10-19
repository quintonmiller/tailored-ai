import { describe, expect, it } from "vitest";
import {
  ARRIVE_IN,
  arrivalAt,
  DOOR_REACH,
  doorFrame,
  doorLight,
  doorReached,
  doorTo,
  doorWords,
  fitPlate,
  inDoorway,
  plateBreak,
  standsClear,
  THRESHOLD,
  threshold,
} from "./doors";
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
  it("have a threshold just inside, where agents come in and go out, facing in", () => {
    expect(threshold(room, back)).toEqual({ at: [3, -3 + THRESHOLD], facing: 0 });
    expect(threshold(room, left)).toEqual({ at: [-5 + THRESHOLD, 1], facing: Math.PI / 2 });
    expect(threshold(room, front).at).toEqual([-2, 3 - THRESHOLD]);
    expect(threshold(room, right).at).toEqual([5 - THRESHOLD, 0]);
    // Inside the room, short of where you are put coming through: an agent walks on from it.
    for (const door of room.doors) expect(inDoorway(room, door, threshold(room, door).at)).toBe(true);
  });

  it("stand at their side of the room, facing in", () => {
    expect(doorFrame(room, back)).toEqual({ at: [3, -3], facing: 0 });
    expect(doorFrame(room, left)).toEqual({ at: [-5, 1], facing: 90 });
    expect(doorFrame(room, front)).toEqual({ at: [-2, 3], facing: 180 });
    expect(doorFrame(room, right)).toEqual({ at: [5, 0], facing: -90 });
  });

  it("let you in just inside, facing into the room, clear of the doorway; further in through a gate", () => {
    const at = (door: RoomDoor) => arrivalAt(room, door).at.map((n) => Math.round(n * 100) / 100);
    expect(at(back)).toEqual([3, -3 + ARRIVE_IN.wall]);
    expect(at(left)).toEqual([-5 + ARRIVE_IN.wall, 1]);
    // Past the gate's plate, which stands between you and the camera.
    expect(at(front)).toEqual([-2, 3 - ARRIVE_IN.open]);
    expect(at(right)).toEqual([5 - ARRIVE_IN.open, 0]);
    expect(ARRIVE_IN.open).toBeGreaterThanOrEqual(1.6);
    expect(arrivalAt(room, back).facing).toBe(0);
    expect(arrivalAt(room, left).facing).toBeCloseTo(Math.PI / 2);
    for (const door of room.doors) expect(inDoorway(room, door, arrivalAt(room, door).at)).toBe(false);
    expect(ARRIVE_IN.wall).toBeGreaterThan(DOOR_REACH);
  });

  it("let you in clear of anything standing just inside, on the line in from the door", () => {
    // An armchair right where you would come in by the back door.
    const chair = { minX: 2.55, maxX: 3.45, minZ: -2.05, maxZ: -1.25 };
    const { at } = arrivalAt(room, back, [chair]);
    expect(at[0]).toBe(3);
    expect(standsClear(room, [chair], at)).toBe(true);
    // Past it, further in, rather than squeezed between it and the door.
    expect(at[1]).toBeGreaterThan(chair.maxZ);
    expect(inDoorway(room, back, at)).toBe(false);
    // Nothing in the way, or nowhere clear at all: the usual place.
    expect(arrivalAt(room, back, []).at).toEqual(arrivalAt(room, back).at);
    const wall = { minX: -5, maxX: 5, minZ: -2.7, maxZ: 3 };
    expect(arrivalAt(room, back, [wall]).at).toEqual(arrivalAt(room, back).at);
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
    // Up against the wall in front of the door, the wall stops the step, but pressing toward the door goes through.
    expect(doorReached(room, [3.1, -2.75], [0, 0], [0, -0.05])).toBe(back);
    expect(doorReached(room, [3.1, -2.75], [0, 0], [0.05, 0])).toBeUndefined();
    expect(doorReached(room, [4.5, -2.75], [0, 0], [0, -0.05])).toBeUndefined();
    // The open sides work the same way.
    expect(doorReached(room, [-2, 2.75], [0.01, 0.05])).toBe(front);
    expect(doorReached(room, [4.8, 0.2], [0.05, 0])).toBe(right);
    expect(doorReached(room, [-4.75, 1.3], [-0.05, 0])).toBe(left);
  });

  it("light up by what the agent behind them is doing, brightest when it needs you, waiting far from gold", () => {
    // Waiting is the one that matters most: its amber must not be the gold of a brass plate.
    const { color } = doorLight("waiting");
    const [r, g, b] = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
    expect(r).toBe(255);
    expect(g / r).toBeLessThan(0.65);
    expect(b).toBeLessThan(40);
    expect(doorLight("waiting").glow).toBeGreaterThan(doorLight("working").glow);
    expect(doorLight("asleep").glow).toBeLessThan(doorLight("idle").glow);
    expect(
      new Set(["working", "thinking", "waiting", "stuck", "idle", "asleep"].map((d) => doorLight(d as never).color))
        .size,
    ).toBe(6);
    expect(doorLight(undefined)).toEqual(doorLight("idle"));
  });
});

describe("doorWords", () => {
  it("says where a door goes, as a pointer over it shows it", () => {
    expect(doorWords({ kind: "hall", label: "Residences E–N" })).toBe("to Residences E–N");
    expect(doorWords({ kind: "home", label: "analyst", occupant: "analyst" })).toBe("to analyst's home");
    expect(doorWords({ kind: "home", label: "Default agent", occupant: "default" })).toBe(
      "to the default agent's home",
    );
    expect(doorWords({ kind: "room", label: "#budget" })).toBe("to #budget");
    expect(doorWords({ kind: "lobby", label: "Lobby" })).toBe("to the lobby");
    expect(doorWords({ kind: "shared", label: "Lounge" })).toBe("to Lounge");
  });
});

describe("plate words", () => {
  // Every character half as wide as it is high, as near as matters for a plate's font.
  const measure = (text: string) => text.length * 0.55;
  // A gate's plate, as drawn: 1.36 by 0.27 metres at 440 pixels a metre.
  const [w, h] = [598, 119];

  it("puts a short name on one line, as large as the plate allows", () => {
    expect(fitPlate("analyst", measure, w, h)).toEqual({ lines: ["analyst"], size: h * 0.58 });
  });

  it("shrinks a longer name onto one line while it still reads well", () => {
    const { lines, size } = fitPlate("meeting-summarizer", measure, w, h);
    expect(lines).toEqual(["meeting-summarizer"]);
    expect(size).toBeLessThan(h * 0.58);
    expect(size * measure("meeting-summarizer")).toBeLessThanOrEqual(w * 0.9 + 1e-9);
  });

  it("puts a name too long for one line on two, broken at its hyphen, larger than one line could be", () => {
    const label = "calendar-organizer-assistant";
    const { lines, size } = fitPlate(label, measure, w, h);
    expect(lines).toEqual(["calendar-organizer-", "assistant"]);
    expect(size).toBeGreaterThan((w * 0.9) / measure(label));
    for (const line of lines) expect(size * measure(line)).toBeLessThanOrEqual(w * 0.9 + 1e-9);
    // Two lines, a little apart, inside the plate's height.
    expect(size * 2 * 1.08).toBeLessThan(h);
  });

  it("breaks where a name breaks best: at a hyphen, a space, an underscore or a capital, lines as even as can be", () => {
    expect(plateBreak("meeting-summarizer")).toEqual(["meeting-", "summarizer"]);
    expect(plateBreak("#weekly-team-sync-notes")).toEqual(["#weekly-team-", "sync-notes"]);
    expect(plateBreak("Residences E–N and more")).toEqual(["Residences", "E–N and more"]);
    expect(plateBreak("mail_sorter_two")).toEqual(["mail_", "sorter_two"]);
    expect(plateBreak("calendarOrganizer")).toEqual(["calendar", "Organizer"]);
    // A name with nowhere to break is broken in the middle, with a hyphen.
    expect(plateBreak("supercalifragilistic")).toEqual(["supercalif-", "ragilistic"]);
  });

  it("never draws a name smaller than a floor: past it, it is squeezed rather than cut off", () => {
    const label = "x".repeat(200);
    const { size } = fitPlate(label, measure, w, h);
    expect(size).toBeCloseTo(h * 0.22, 9);
  });
});
