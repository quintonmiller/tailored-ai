/**
 * The room as data: a sound default layout, problems named when a layout is
 * not, lighting that follows the hour, and a camera that backs off for a
 * narrow frame.
 */
import { describe, expect, it } from "vitest";
import {
  bodyFor,
  DEFAULT_ROOM,
  GESTURES,
  lightingFor,
  lookTarget,
  nearestWithin,
  OPEN_SIDES,
  type Room,
  roomDistance,
  roomProblems,
  spotById,
  spotFor,
} from "./scene";

describe("the default room", () => {
  it("has no problems, and the avatar starts at a real spot", () => {
    expect(roomProblems(DEFAULT_ROOM)).toEqual([]);
    expect(spotById(DEFAULT_ROOM, DEFAULT_ROOM.start)).toBeDefined();
  });

  it("names every prop and spot the way a person would say it", () => {
    for (const item of [...DEFAULT_ROOM.props, ...DEFAULT_ROOM.spots]) expect(item.name).toMatch(/^(the|by|at|on) /);
  });
});

describe("roomProblems", () => {
  it("names a repeated id, a thing outside the walls, and a missing start", () => {
    const room: Room = {
      ...DEFAULT_ROOM,
      props: [
        { id: "a", name: "the a", kind: "rug", at: [0, 0], facing: 0 },
        { id: "a", name: "the other a", kind: "plant", at: [9, 0], facing: 0 },
      ],
      start: "nowhere",
    };
    expect(roomProblems(room)).toEqual([
      '"a" is used twice.',
      '"a" is outside the room.',
      'The starting spot "nowhere" does not exist.',
    ]);
  });
});

describe("roomProblems, for spots and what leads to them", () => {
  it("names furniture that leads nowhere, and a seat-less place to sit", () => {
    const room: Room = {
      ...DEFAULT_ROOM,
      props: [{ id: "stool", name: "the stool", kind: "chair", at: [0, 0], facing: 0, spot: "perch" }],
      spots: [{ id: "middle", name: "the middle", place: "the middle", at: [0, 0], facing: 0, activity: "sit" }],
    };
    expect(roomProblems(room)).toEqual([
      '"stool" leads to a spot that does not exist.',
      '"middle" is for sitting but has no seat.',
    ]);
  });
});

describe("lightingFor", () => {
  it("lights the room through the window by day, with the lamp off", () => {
    const day = lightingFor(11);
    expect(day.lamp.on).toBe(false);
    expect(day.sun.intensity).toBeGreaterThan(2);
  });

  it("turns the lamp on in the evening and leans on it at night", () => {
    const evening = lightingFor(18);
    const night = lightingFor(23);
    expect(evening.lamp.on).toBe(true);
    expect(night.lamp.intensity).toBeGreaterThan(evening.lamp.intensity);
    expect(night.sun.intensity).toBeLessThan(evening.sun.intensity);
    expect(night.window.glow).toBeLessThan(lightingFor(11).window.glow);
  });

  it("treats the small hours as night", () => {
    expect(lightingFor(3)).toEqual(lightingFor(23));
  });
});

describe("roomDistance", () => {
  it("backs the camera off for a narrow frame, so a phone still sees the whole room", () => {
    expect(roomDistance(DEFAULT_ROOM, 0.5)).toBeGreaterThan(roomDistance(DEFAULT_ROOM, 1.8));
  });

  it("is never closer than the room's height needs", () => {
    expect(roomDistance(DEFAULT_ROOM, 10)).toBeCloseTo(roomDistance(DEFAULT_ROOM, 20), 5);
  });
});

describe("nearestWithin", () => {
  it("keeps an angle that looks in through an open side", () => {
    expect(nearestWithin(0.3, OPEN_SIDES)).toBeCloseTo(0.3);
  });

  it("swings a view that would be behind a wall to the nearest open angle", () => {
    // Facing the desk on the back wall, or the shelf on the left wall.
    expect(nearestWithin((145 * Math.PI) / 180, OPEN_SIDES)).toBe(OPEN_SIDES[1]);
    expect(nearestWithin(-Math.PI / 2, OPEN_SIDES)).toBe(OPEN_SIDES[0]);
  });

  it("reads angles the long way round the same as the short way", () => {
    expect(nearestWithin(0.3 + 2 * Math.PI, OPEN_SIDES)).toBeCloseTo(0.3);
  });
});

describe("bodyFor", () => {
  const body = bodyFor(DEFAULT_ROOM);

  it("offers the avatar's gestures, the spots to walk to, and things to look or point at", () => {
    expect(body.gestures).toEqual([...GESTURES]);
    const [go, look, point] = body.aimed;
    expect(go).toMatchObject({ verb: "go", prep: "to", targets: DEFAULT_ROOM.spots.map((s) => s.place) });
    expect(look.targets).toContain("you");
    expect(look.targets).toContain("the window");
    expect(point.targets).not.toContain("you");
  });

  it("uses only names the server accepts into a prompt: short plain words", () => {
    const names = [body.looks, ...body.gestures, ...body.aimed.flatMap((m) => [m.does, ...m.targets])];
    for (const n of names) expect(n).toMatch(/^[\p{L}\p{N}][\p{L}\p{N} '’-]{0,47}$/u);
  });
});

describe("spotFor and lookTarget", () => {
  it("finds the spot a go means, however it is named", () => {
    expect(spotFor(DEFAULT_ROOM, "the couch")?.id).toBe("couch");
    expect(spotFor(DEFAULT_ROOM, "Couch")?.id).toBe("couch");
    expect(spotFor(DEFAULT_ROOM, "the laptop")?.id).toBe("desk");
    expect(spotFor(DEFAULT_ROOM, "the middle")?.id).toBe("middle");
    expect(spotFor(DEFAULT_ROOM, "the attic")).toBeUndefined();
  });

  it("knows the viewer and where things are, at the height of their middle", () => {
    expect(lookTarget(DEFAULT_ROOM, "the user")).toEqual({ viewer: true });
    expect(lookTarget(DEFAULT_ROOM, "you")).toEqual({ viewer: true });
    expect(lookTarget(DEFAULT_ROOM, "the window")).toEqual({ at: [-2.09, 1.5, -0.45] });
    expect(lookTarget(DEFAULT_ROOM, "the moon")).toBeUndefined();
  });
});
