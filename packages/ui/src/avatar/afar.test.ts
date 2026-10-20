/**
 * Out in the town, seen from afar: near the camera every tag is as it always
 * is; far off only a body worth a glance keeps one, smaller and a little
 * faint; idle company far off shares one chat mark; and a body a few pixels
 * high can still be pointed at. How far off is how much of the town is in
 * view, so the town's usual view is near on a phone as on a big screen.
 */
import { describe, expect, it } from "vitest";
import {
  AWAY,
  afar,
  chatGroups,
  FAR_REACH,
  FAR_SHRINK,
  FAR_STRENGTH,
  farness,
  fromAfar,
  GROUP_FROM,
  markAt,
  markLift,
  NEAR,
  NEAR_REACH,
  POINT_PX,
  pointedAt,
  type Seen,
  worthAGlance,
} from "./afar";
import { GAP_PX, metresPerPixel } from "./overhead";
import { ROOM_VIEW } from "./scene";
import { followDistance, REACH } from "./travel";

/** Metres a screen pixel covers at a body that a view `across` pixels wide, framed on it, takes in `reach` metres either side of. */
const framed = (reach: number, across: number) => (2 * reach) / across;

/**
 * A stage `w` by `h` pixels, of which `seenH` down from the top can be seen
 * (a phone's chat over the rest): the metres a pixel covers at your head,
 * with the camera following you at `reach`, as the stage frames it, and the
 * pixels across the narrower way of what can be seen.
 */
function following(reach: number, w: number, h: number, seenH = h): [number, number] {
  const aspect = w / seenH;
  const tall = seenH / h;
  const depth = followDistance(reach, aspect, ROOM_VIEW.fov, tall);
  return [metresPerPixel(depth, ROOM_VIEW.fov, h), tall * h * Math.min(1, aspect)];
}

describe("how far off a body looks", () => {
  it("is near while a view framed on it takes in little round it, far once it takes in most of the town, and eased in between", () => {
    expect(farness(framed(REACH.outdoorStart, 712), 712)).toBe(0);
    expect(farness(framed(NEAR_REACH, 712), 712)).toBe(0);
    expect(farness(framed(FAR_REACH, 712), 712)).toBe(1);
    expect(farness(framed(REACH.outdoors, 712), 712)).toBe(1);
    expect(farness(framed((NEAR_REACH + FAR_REACH) / 2, 712), 712)).toBeCloseTo(0.5, 6);
    // Further is never nearer.
    let was = 0;
    for (let reach = NEAR_REACH; reach <= FAR_REACH; reach += 0.5) {
      const far = farness(framed(reach, 712), 712);
      expect(far).toBeGreaterThanOrEqual(was);
      was = far;
    }
  });

  it("is near round you at the town's usual view, on a phone as on a big screen, and far zoomed all the way out", () => {
    const screens: [string, number, number, number?][] = [
      ["a big screen", 1100, 900],
      ["a laptop", 900, 712],
      ["a phone", 390, 760],
      ["a phone with its chat over the foot", 390, 844, 350],
    ];
    for (const [what, w, h, seenH] of screens) {
      expect(farness(...following(REACH.outdoorStart, w, h, seenH)), what).toBe(0);
      expect(farness(...following(REACH.outdoors, w, h, seenH)), what).toBe(1);
    }
  });

  it("is as far at the same zoom whatever the screen", () => {
    const big = farness(...following(20, 1100, 900));
    expect(big).toBeGreaterThan(0);
    expect(big).toBeLessThan(1);
    expect(farness(...following(20, 390, 844, 350))).toBeCloseTo(big, 6);
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

describe("who gives a chat sign up to a shared mark", () => {
  const body = (
    id: string,
    x: number,
    far: number,
    glance: Seen["glance"] = { doing: "idle" },
    chatting = true,
  ): Seen => ({
    id,
    at: [x, 0],
    screen: [x * 100, 0],
    far,
    glance,
    chatting,
  });

  it("is an idle body keeping company, once it is far enough off, its sign given to its group's one mark", () => {
    const { looks, marks } = fromAfar([body("a", 0, 0.8), body("b", 1, 0.8)]);
    expect(marks.map((m) => m.ids)).toEqual([["a", "b"]]);
    expect(looks.get("a")?.sign).toBe(0);
    expect(looks.get("b")?.sign).toBe(0);
  });

  it("isn't one nearer than that: each keeps its own sign, fading with its tag", () => {
    const far = GROUP_FROM - 0.1;
    const { looks, marks } = fromAfar([body("a", 0, far), body("b", 1, far)]);
    expect(marks).toEqual([]);
    expect(looks.get("a")).toEqual(afar(far, { doing: "idle" }));
    expect(looks.get("a")?.sign).toBeGreaterThan(0);
  });

  it("is never one worth a glance: its own sign says it for the group, and the group has no mark", () => {
    for (const glance of [
      { doing: "idle" as const, partner: true },
      { doing: "idle" as const, pointed: true },
    ]) {
      const { looks, marks } = fromAfar([body("a", 0, 0.9, glance), body("b", 1, 0.9)]);
      expect(marks).toEqual([]);
      expect(looks.get("a")?.sign).toBeGreaterThan(0);
      // The idle one it chats with is quiet: one conversation, one sign.
      expect(looks.get("b")?.sign).toBe(0);
    }
  });

  it("is nobody who isn't keeping company", () => {
    const { looks, marks } = fromAfar([body("a", 0, 0.9, { doing: "idle" }, false)]);
    expect(marks).toEqual([]);
    expect(looks.get("a")).toEqual(afar(0.9, { doing: "idle" }));
  });

  it("draws the mark as strongly as their names are faint, so it takes over from them as they fade", () => {
    const fading = fromAfar([body("a", 0, 0.6), body("b", 1, 0.7)]).marks[0];
    // The stronger name, a's, is 0.4: the mark is 0.6.
    expect(fading.strength).toBeCloseTo(0.6, 6);
    expect(fromAfar([body("a", 0, 1), body("b", 1, 1)]).marks[0].strength).toBe(1);
  });
});

describe("where a shared chat mark stands over its group", () => {
  it("is just over their heads while no name of theirs is drawn under it", () => {
    expect(markLift([100, 200], 20, [])).toBe(GAP_PX);
    // A name off to the side is not under it.
    expect(markLift([100, 200], 20, [{ left: 130, right: 180, top: 170, bottom: 186 }])).toBe(GAP_PX);
  });

  it("is over a name of theirs still drawn there, where its own sign was, never through it", () => {
    const name = { left: 80, right: 140, top: 178, bottom: 194 };
    expect(markLift([100, 200], 20, [name])).toBe(200 - 178 + GAP_PX);
    // Over the higher of two.
    expect(markLift([100, 200], 20, [name, { ...name, top: 160, bottom: 176 }])).toBe(200 - 160 + GAP_PX);
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
