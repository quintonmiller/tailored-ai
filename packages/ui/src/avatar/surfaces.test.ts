/**
 * Surfaces: how big a surface's HTML is, how tall it shows, which are live
 * and in how much detail, where the camera goes to read one, which one you
 * face, and where on one a pointer is.
 */
import { describe, expect, it } from "vitest";
import {
  blocksView,
  DEAD_PX,
  detailFor,
  FACE_REACH,
  FAR_PX,
  FOCUS_NEAREST,
  facingSurface,
  focusDistance,
  focusFraming,
  LIVE_PX,
  liveSurfaces,
  NEAR_PX,
  onScreenPx,
  overWalls,
  type Placed,
  type Seen,
  SURFACE_PX,
  surfacePixels,
  surfacePoint,
} from "./surfaces";

const seen = (id: string, px: number, more: Partial<Seen> = {}): Seen => ({
  id,
  px,
  facing: true,
  inView: true,
  ...more,
});

describe("surfacePixels", () => {
  it("lays a surface out at a fixed size per metre", () => {
    expect(surfacePixels([1.5, 0.5])).toEqual([1.5 * SURFACE_PX, 0.5 * SURFACE_PX]);
    expect(surfacePixels([1, 1], 100)).toEqual([100, 100]);
  });
});

describe("onScreenPx", () => {
  it("is the share of the view's height it fills, in pixels", () => {
    // At a depth where the view is exactly 2 m tall, a 1 m thing fills half of a 600 px stage.
    const fov = 60;
    const depth = 1 / Math.tan(Math.PI / 6);
    expect(onScreenPx(1, depth, fov, 600)).toBeCloseTo(300);
    expect(onScreenPx(1, depth * 2, fov, 600)).toBeCloseTo(150);
  });

  it("is nothing at or behind the camera", () => {
    expect(onScreenPx(1, 0, 35, 600)).toBe(0);
    expect(onScreenPx(1, -2, 35, 600)).toBe(0);
  });
});

describe("liveSurfaces", () => {
  it("is those tall enough to read, turned to the camera and in the picture", () => {
    const live = liveSurfaces(
      [
        seen("board", 120),
        seen("small", LIVE_PX - 1),
        seen("behind", 300, { facing: false }),
        seen("off", 300, { inView: false }),
        seen("faded", 300, { faded: true }),
      ],
      new Set(),
    );
    expect([...live]).toEqual(["board"]);
  });

  it("keeps one live a little smaller than it took to go live, so it doesn't flicker at the edge", () => {
    const between = (LIVE_PX + DEAD_PX) / 2;
    expect(liveSurfaces([seen("a", between)], new Set()).has("a")).toBe(false);
    expect(liveSurfaces([seen("a", between)], new Set(["a"])).has("a")).toBe(true);
    expect(liveSurfaces([seen("a", DEAD_PX - 1)], new Set(["a"])).has("a")).toBe(false);
  });

  it("keeps the one being read and those kept live always, whatever else is true", () => {
    const live = liveSurfaces(
      [seen("read", 0, { focused: true, facing: false, inView: false }), seen("clock", 2, { live: "always" })],
      new Set(),
    );
    expect(live).toEqual(new Set(["read", "clock"]));
  });

  it("keeps the biggest when more could be live than may be", () => {
    const live = liveSurfaces(
      [seen("a", 60), seen("b", 400), seen("c", 90), seen("d", 50), seen("read", 5, { focused: true })],
      new Set(),
      3,
    );
    expect(live).toEqual(new Set(["read", "b", "c"]));
  });
});

describe("detailFor", () => {
  it("shows everything once tall enough, and goes back only once a good deal smaller", () => {
    expect(detailFor(NEAR_PX, undefined)).toBe("near");
    expect(detailFor(NEAR_PX - 1, undefined)).toBe("far");
    expect(detailFor(FAR_PX + 1, "near")).toBe("near");
    expect(detailFor(FAR_PX - 1, "near")).toBe("far");
    expect(detailFor(FAR_PX + 1, "far")).toBe("far");
  });
});

describe("focusDistance", () => {
  const fov = 35;
  const tan = Math.tan((fov * Math.PI) / 360);

  it("fits a wide surface by its width and a tall one by its height, with a margin", () => {
    // 2 m wide on a 2:1 view needs as much room as 1 m tall.
    const wide = focusDistance([2, 0.5], { fov, aspect: 2, margin: 0 });
    expect(wide).toBeCloseTo(1 / (2 * tan));
    const tall = focusDistance([0.5, 1], { fov, aspect: 2, margin: 0 });
    expect(tall).toBeCloseTo(1 / (2 * tan));
    expect(focusDistance([0.5, 1], { fov, aspect: 2, margin: 0.1 })).toBeCloseTo(1.2 / (2 * tan));
  });

  it("stands further back when only part of the stage can be seen", () => {
    const whole = focusDistance([1, 1], { fov, aspect: 1, margin: 0 });
    expect(focusDistance([1, 1], { fov, aspect: 1, tall: 0.5, margin: 0 })).toBeCloseTo(whole * 2);
  });

  it("never comes nearer than a little way off the wall", () => {
    expect(focusDistance([0.01, 0.01], { fov, aspect: 1 })).toBe(FOCUS_NEAREST);
  });
});

describe("focusFraming", () => {
  it("stands straight out from the middle, along the way it faces, looking at it", () => {
    const f = focusFraming([1, 1.5, -5], [0, 0, 2], 1.25);
    expect(f.target).toEqual([1, 1.5, -5]);
    expect(f.position).toEqual([1, 1.5, -3.75]);
    const side = focusFraming([-4, 1, 0], [1, 0, 0], 2);
    expect(side.position).toEqual([-2, 1, 0]);
  });
});

describe("overWalls", () => {
  // A 60 degree view through a stage 1000 pixels tall, its top 500 pixels over where the camera looks.
  const view = { fov: 60, stageH: 1000, above: 500 };
  const half = Math.tan(Math.PI / 6);

  it("says how much of the dark over the room shows above a surface high on a wall", () => {
    // Two metres out, looking level at 2.4 m: the stage sees up to 2.4 + 2·tan 30° ≈ 3.55 m on the wall.
    expect(overWalls(2.4, 2, view, 3)).toBeCloseTo(2.4 + 2 * half - 3, 6);
  });

  it("is nothing when the wall goes on past the top of the stage", () => {
    expect(overWalls(1.2, 1, view, 3)).toBe(0);
  });

  it("counts from where the camera looks, not the middle of the stage", () => {
    // The box read in sits low on the stage: more of the stage is over where the camera looks, so more shows.
    const low = overWalls(2.4, 2, { ...view, above: 800 }, 3);
    expect(low).toBeGreaterThan(overWalls(2.4, 2, view, 3));
    expect(low).toBeCloseTo(2.4 + 2 * half * 1.6 - 3, 6);
  });
});

describe("blocksView", () => {
  // A board on the back wall, a metre and a half wide, read from two metres out.
  const center: [number, number, number] = [0, 1.4, -4];
  const normal: [number, number, number] = [0, 0, 1];

  it("is a body between the camera and the surface, in front of it", () => {
    expect(blocksView([0, 0, -3], center, normal, 0.75, 2)).toBe(true);
    expect(blocksView([0.9, 0, -3.5], center, normal, 0.75, 2)).toBe(true);
  });

  it("is not one off to the side, behind the camera, or behind the wall", () => {
    expect(blocksView([1.5, 0, -3], center, normal, 0.75, 2)).toBe(false);
    expect(blocksView([0, 0, -1.5], center, normal, 0.75, 2)).toBe(false);
    expect(blocksView([0, 0, -4.5], center, normal, 0.75, 2)).toBe(false);
  });

  it("goes by the way the surface faces", () => {
    // A screen on the left wall, facing right: in front of it is to its right.
    expect(blocksView([-3, 0, 0.2], [-4, 1.5, 0], [1, 0, 0], 0.75, 2)).toBe(true);
    expect(blocksView([-3, 0, 2], [-4, 1.5, 0], [1, 0, 0], 0.75, 2)).toBe(false);
  });
});

describe("facingSurface", () => {
  // A board on the back wall, facing into the room; a screen on the left wall, facing right.
  const surfaces: Placed[] = [
    { id: "board", center: [0, 1.4, -4], normal: [0, 0, 1] },
    { id: "screen", center: [-4, 1.6, 0], normal: [1, 0, 0] },
  ];

  it("is the one in front of you, within reach", () => {
    expect(facingSurface([0, 1, -2], [0, 0, -1], surfaces)).toBe("board");
    expect(facingSurface([-2, 1, 0], [-1, 0, 0], surfaces)).toBe("screen");
  });

  it("is none out of reach, behind you, or seen from behind", () => {
    expect(facingSurface([0, 1, -4 + FACE_REACH + 0.5], [0, 0, -1], surfaces)).toBeUndefined();
    expect(facingSurface([0, 1, -2], [0, 0, 1], surfaces)).toBeUndefined();
    // Behind the back wall, looking at the board's back.
    expect(facingSurface([0, 1, -5], [0, 0, 1], surfaces)).toBeUndefined();
  });

  it("is the nearer, with one off to the side counting as further", () => {
    // Two boards on the back wall, one a metre to the left, the other a metre and a half to the right.
    const pair: Placed[] = [
      { id: "left", center: [-1, 1.4, -4], normal: [0, 0, 1] },
      { id: "right", center: [1.5, 1.4, -4], normal: [0, 0, 1] },
    ];
    // Looking at the wall between them: the nearer.
    expect(facingSurface([0, 1, -2.5], [0, 0, -1], pair)).toBe("left");
    // Turned toward the further one: that one, though the other is nearer.
    expect(facingSurface([0, 1, -2.5], [0.7, 0, -1], pair)).toBe("right");
    // One straight ahead, and a nearer one well off to the side, both in sight: the one ahead.
    const ahead: Placed[] = [
      { id: "aside", center: [-1, 1.4, -3.5], normal: [0, 0, 1] },
      { id: "ahead", center: [0, 1.4, -4.2], normal: [0, 0, 1] },
    ];
    expect(facingSurface([0, 1, -2.5], [0, 0, -1], ahead)).toBe("ahead");
  });
});

describe("surfacePoint", () => {
  it("turns where on the plane a point is into the surface's pixels, from the top left", () => {
    expect(surfacePoint([0, 1], [800, 400])).toEqual([0, 0]);
    expect(surfacePoint([0.5, 0.5], [800, 400])).toEqual([400, 200]);
    expect(surfacePoint([1, 0], [800, 400])).toEqual([800, 400]);
  });
});
