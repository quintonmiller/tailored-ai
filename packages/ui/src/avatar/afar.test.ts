/**
 * Out in the town, seen from afar: near the camera every tag is as it always
 * is; far off only a body worth a glance keeps one, smaller and a little
 * faint; idle company far off shares one chat mark; and a body a few pixels
 * high can still be pointed at.
 */
import { describe, expect, it } from "vitest";
import {
  AWAY,
  afar,
  BODY_M,
  chatGroups,
  FAR_PX,
  FAR_SHRINK,
  FAR_STRENGTH,
  farness,
  markAt,
  NEAR,
  NEAR_PX,
  POINT_PX,
  pointedAt,
  worthAGlance,
} from "./afar";
import { metresPerPixel } from "./overhead";

/** Metres a screen pixel covers where a body is drawn `tall` pixels high. */
const drawn = (tall: number) => BODY_M / tall;

describe("how far off a body looks", () => {
  it("is near while it is drawn big enough, far once it is a few pixels high, and eased in between", () => {
    expect(farness(drawn(NEAR_PX + 30))).toBe(0);
    expect(farness(drawn(NEAR_PX))).toBe(0);
    expect(farness(drawn(FAR_PX))).toBe(1);
    expect(farness(drawn(8))).toBe(1);
    const mid = farness(drawn((NEAR_PX + FAR_PX) / 2));
    expect(mid).toBeCloseTo(0.5, 6);
    // Further is never nearer.
    let was = 0;
    for (let tall = NEAR_PX; tall >= FAR_PX; tall -= 1) {
      const far = farness(drawn(tall));
      expect(far).toBeGreaterThanOrEqual(was);
      was = far;
    }
  });

  it("is near round you at the town's usual view, and far across it zoomed all the way out", () => {
    // The camera 35 m back from you, on a stage 712 pixels high: the café beside you is near.
    expect(farness(metresPerPixel(35, 35, 712))).toBe(0);
    // Drawn back to the widest view, 114 m: the whole town is far.
    expect(farness(metresPerPixel(114, 35, 712))).toBe(1);
  });
});

describe("who keeps a tag from afar", () => {
  it("is anyone who needs you, is busy or talking, under the pointer, the one the chat is with, or you", () => {
    for (const doing of ["waiting", "stuck", "working", "thinking", "talking"] as const)
      expect(worthAGlance({ doing }), doing).toBe(true);
    expect(worthAGlance({ doing: "idle", speaking: true })).toBe(true);
    expect(worthAGlance({ doing: "idle", pointed: true })).toBe(true);
    expect(worthAGlance({ doing: "idle", partner: true })).toBe(true);
    expect(worthAGlance({ you: true })).toBe(true);
  });

  it("isn't anyone idle or asleep with none of those", () => {
    expect(worthAGlance({ doing: "idle" })).toBe(false);
    expect(worthAGlance({ doing: "asleep" })).toBe(false);
    expect(worthAGlance({})).toBe(false);
  });
});

describe("how a tag is drawn from afar", () => {
  it("is as always near, for anyone", () => {
    expect(afar(0, { doing: "idle" })).toEqual(NEAR);
    expect(afar(0, { doing: "waiting" })).toEqual(NEAR);
  });

  it("is smaller and a little faint far off for a body worth a glance, its sign kept", () => {
    expect(afar(1, { doing: "working" })).toEqual({ tag: FAR_STRENGTH, size: FAR_SHRINK, sign: 1 });
    // Still readable: never under four fifths as big as near.
    expect(FAR_SHRINK).toBeGreaterThanOrEqual(0.8);
  });

  it("fades out for an idle body, its sign with it, put away once far", () => {
    const half = afar(0.5, { doing: "idle" });
    expect(half.tag).toBeCloseTo(0.5, 6);
    expect(half.sign).toBeCloseTo(0.5, 6);
    expect(afar(1, { doing: "idle" })).toMatchObject({ tag: 0, sign: 0 });
    expect(afar(1 - AWAY / 2, { doing: "asleep" }).tag).toBe(0);
  });

  it("is as near, whatever the distance, for the body under the pointer", () => {
    expect(afar(1, { doing: "idle", pointed: true })).toEqual(NEAR);
    expect(afar(1, { doing: "working", pointed: true })).toEqual(NEAR);
  });
});

describe("chat marks shared far off", () => {
  const at = (id: string, x: number, z: number, sx = x * 100, sy = 0) => ({
    id,
    at: [x, z] as [number, number],
    screen: [sx, sy] as [number, number],
  });

  it("puts bodies at one table, and at the next, in one group", () => {
    const groups = chatGroups([at("a", 0, 0), at("b", 1.2, 0), at("c", 4, 0), at("d", 40, 0)]);
    // c is within reach of b, so of a too; d is on its own across the square.
    expect(groups).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("puts two whose marks would sit on each other on the screen in one group, however far apart they are", () => {
    // Far down the street from each other, but one behind the other from where the camera is.
    expect(chatGroups([at("a", 0, 0, 100, 100), at("b", 30, 0, 110, 96)])).toEqual([["a", "b"]]);
    expect(chatGroups([at("a", 0, 0, 100, 100), at("b", 30, 0, 300, 96)])).toEqual([["a"], ["b"]]);
  });

  it("names each group the same way every frame, whatever order they come in", () => {
    const one = chatGroups([at("writer", 0, 0), at("coder", 1, 0), at("planner", 50, 0)]);
    const two = chatGroups([at("planner", 50, 0), at("coder", 1, 0), at("writer", 0, 0)]);
    expect(one).toEqual(two);
    expect(one[0][0]).toBe("coder");
  });

  it("stands its mark over the middle of them, on the tallest head", () => {
    expect(
      markAt([
        [0, 1.6, 0],
        [2, 1.8, 1],
        [1, 1.5, 2],
      ]),
    ).toEqual([1, 1.8, 1]);
  });
});

describe("pointing at a body far off", () => {
  const tiny = { left: 100, right: 106, top: 50, bottom: 62 };

  it("finds a body a few pixels high from anywhere close to it", () => {
    expect(pointedAt([103, 56], [{ id: "a", box: tiny }])).toBe("a");
    expect(pointedAt([103 + POINT_PX / 2 - 1, 56], [{ id: "a", box: tiny }])).toBe("a");
    expect(pointedAt([103 + POINT_PX / 2 + 2, 56], [{ id: "a", box: tiny }])).toBeUndefined();
  });

  it("takes the nearer of two that overlap", () => {
    const next = { left: 110, right: 116, top: 50, bottom: 62 };
    expect(
      pointedAt(
        [111, 56],
        [
          { id: "a", box: tiny },
          { id: "b", box: next },
        ],
      ),
    ).toBe("b");
  });

  it("goes no further than a body already as big as that", () => {
    const big = { left: 0, right: 60, top: 0, bottom: 120 };
    expect(pointedAt([30, 60], [{ id: "a", box: big }])).toBe("a");
    expect(pointedAt([63, 60], [{ id: "a", box: big }])).toBeUndefined();
  });
});
