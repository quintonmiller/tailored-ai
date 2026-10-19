/**
 * Tags, signs and speech bubbles on the screen: big enough to read at any
 * zoom, never too big up close, and kept off each other where bodies stand
 * close, with the newest bubble over its speaker.
 */
import { describe, expect, it } from "vitest";
import { BUBBLE_PX, type Column, drawnScale, GAP_PX, metresPerPixel, stack, TAG_PX, TAIL_PX } from "./overhead";

describe("metresPerPixel", () => {
  it("covers the frame's height in metres at that depth, over its height in pixels", () => {
    // 35° of view, 10 m away: 2 · 10 · tan(17.5°) ≈ 6.31 m over 631 pixels.
    expect(metresPerPixel(10, 35, 631)).toBeCloseTo(0.01, 4);
  });

  it("covers twice as much twice as far away, and half as much on a stage twice as tall", () => {
    const near = metresPerPixel(5, 35, 600);
    expect(metresPerPixel(10, 35, 600)).toBeCloseTo(2 * near, 9);
    expect(metresPerPixel(5, 35, 1200)).toBeCloseTo(near / 2, 9);
  });
});

describe("drawnScale", () => {
  const made = 0.002;

  it("draws a tag as made where that already reads", () => {
    // 0.002 m a canvas pixel, at 0.005 m a screen pixel: 0.4 screen pixels a canvas pixel, within the limits.
    expect(drawnScale(made, 0.005, TAG_PX)).toBeCloseTo(made, 9);
  });

  it("draws it bigger from a camera far back, so its words stay readable", () => {
    // 14 m back on a 667-pixel stage, the name would be 7 pixels high; drawn at the least that reads instead.
    const perPixel = metresPerPixel(14.3, 35, 667);
    expect(made / perPixel).toBeLessThan(TAG_PX[0]);
    expect(drawnScale(made, perPixel, TAG_PX) / perPixel).toBeCloseTo(TAG_PX[0], 9);
  });

  it("draws it smaller up close, so it never fills the frame", () => {
    const perPixel = metresPerPixel(1.2, 35, 667);
    expect(made / perPixel).toBeGreaterThan(TAG_PX[1]);
    expect(drawnScale(made, perPixel, TAG_PX) / perPixel).toBeCloseTo(TAG_PX[1], 9);
  });

  it("keeps a bubble's words at least 13 pixels high however far back the camera is", () => {
    // A bubble's words are drawn 38 pixels high on its canvas.
    for (const depth of [3, 8, 14, 30]) {
      const perPixel = metresPerPixel(depth, 35, 667);
      expect((38 * drawnScale(0.12 / 72, perPixel, BUBBLE_PX)) / perPixel).toBeGreaterThanOrEqual(13);
    }
  });
});

/** A body's things at (x, y), with a tag 100 by 20. */
const body = (id: string, x: number, y: number, more: Partial<Column> = {}): Column => ({
  id,
  x,
  y,
  tag: [100, 20],
  rank: 0,
  ...more,
});

describe("stack", () => {
  it("puts a tag just over its head, and a bubble over its tag with room for its tail", () => {
    const out = stack([body("a", 300, 400, { bubble: [200, 60], said: 1 })]);
    expect(out.get("a")).toEqual({
      tag: GAP_PX,
      sign: GAP_PX + 20 + GAP_PX,
      bubble: GAP_PX + 20 + GAP_PX + TAIL_PX,
      across: 0,
    });
  });

  it("leaves bodies apart where they are", () => {
    const out = stack([body("a", 100, 400), body("b", 400, 400)]);
    expect(out.get("a")?.tag).toBe(GAP_PX);
    expect(out.get("b")?.tag).toBe(GAP_PX);
  });

  it("lifts the lower ranked of two tags that would meet clear of the other, over its own head", () => {
    const out = stack([body("a", 300, 400), body("b", 340, 402, { rank: 5 })]);
    // b keeps its place; a goes up past the top of b's tag.
    expect(out.get("b")?.tag).toBe(GAP_PX);
    const bTop = 402 - GAP_PX - 20;
    const aBottom = 400 - (out.get("a")?.tag ?? 0);
    expect(aBottom).toBeLessThanOrEqual(bTop - GAP_PX);
    expect(aBottom).toBeGreaterThan(bTop - GAP_PX - 1);
  });

  it("makes room for a sign over a tag", () => {
    const out = stack([body("a", 300, 400, { sign: 30, rank: 1 }), body("b", 320, 400)]);
    // b's tag goes above a's tag and a's sign, not into the sign.
    expect(400 - (out.get("b")?.tag ?? 0)).toBeLessThanOrEqual(400 - GAP_PX - 20 - GAP_PX - 30 - GAP_PX);
  });

  it("keeps the newest bubble over its speaker and puts the earlier one above it", () => {
    const out = stack([
      body("writer", 300, 400, { bubble: [220, 70], said: 10, rank: 1 }),
      body("editor", 360, 400, { bubble: [220, 70], said: 20 }),
    ]);
    const writer = out.get("writer") as { tag: number; bubble: number };
    const editor = out.get("editor") as { tag: number; bubble: number };
    // The editor spoke last: its bubble sits on its own tag, wherever that went.
    expect(editor.bubble).toBe(editor.tag + 20 + GAP_PX + TAIL_PX);
    // The writer's earlier bubble clears the editor's: its bottom above the editor's top.
    expect(400 - writer.bubble).toBeLessThanOrEqual(400 - editor.bubble - 70 - GAP_PX);
  });

  it("never covers someone else's tag with a bubble", () => {
    // b's tag was lifted over a's; a's bubble goes over that too rather than across it.
    const out = stack([body("a", 300, 400, { bubble: [200, 50], said: 1, rank: 1 }), body("b", 330, 400)]);
    const a = out.get("a") as { bubble: number };
    const b = out.get("b") as { tag: number };
    expect(400 - a.bubble).toBeLessThanOrEqual(400 - b.tag - 20 - GAP_PX);
  });

  it("stacks three talking at once in the order they spoke, newest lowest", () => {
    const out = stack([
      body("a", 300, 400, { bubble: [200, 40], said: 1 }),
      body("b", 310, 400, { bubble: [200, 40], said: 2 }),
      body("c", 320, 400, { bubble: [200, 40], said: 3 }),
    ]);
    const [a, b, c] = ["a", "b", "c"].map((id) => out.get(id)?.bubble ?? 0);
    expect(c).toBeLessThan(b);
    expect(b).toBeLessThan(a);
  });

  it("lays out the same way whatever order the bodies come in", () => {
    const cols = [body("a", 300, 400), body("b", 320, 400), body("c", 340, 400)];
    const one = stack(cols);
    const two = stack([...cols].reverse());
    for (const id of ["a", "b", "c"]) expect(two.get(id)).toEqual(one.get(id));
  });

  it("gives a body with nothing over its head nothing to lift", () => {
    const out = stack([{ id: "a", x: 0, y: 0, rank: 0 }]);
    expect(out.get("a")).toEqual({ tag: GAP_PX, sign: GAP_PX, bubble: GAP_PX + TAIL_PX, across: 0 });
  });

  it("puts a speaker's bubble straight over its head when it shows no tag while it speaks", () => {
    const out = stack([{ id: "a", x: 300, y: 400, rank: 0, bubble: [200, 60], said: 1 }]);
    expect(out.get("a")?.bubble).toBe(GAP_PX + TAIL_PX);
  });

  it("brings a bubble that would run off the top of the stage back down to be read", () => {
    const screen = { left: 0, right: 1000, top: 0 };
    const out = stack([{ id: "a", x: 300, y: 50, rank: 0, bubble: [200, 80], said: 1 }], screen);
    // Its top just inside the stage, though that puts it over its speaker's head.
    expect(50 - (out.get("a")?.bubble ?? 0) - 80).toBe(8);
    expect(out.get("a")?.bubble).toBeLessThan(GAP_PX);
  });

  it("moves a bubble across to stay clear of a panel over the side of the stage", () => {
    const screen = { left: 0, right: 600, top: 0 };
    const out = stack([{ id: "a", x: 560, y: 400, rank: 0, bubble: [200, 60], said: 1 }], screen);
    // Its right edge at the panel's, less a margin: 560 + 100 + across = 592.
    expect(out.get("a")?.across).toBe(-68);
    const left = stack([{ id: "b", x: 40, y: 400, rank: 0, bubble: [200, 60], said: 1 }], screen);
    expect(left.get("b")?.across).toBe(68);
  });

  it("leaves a bubble where it is when it is already on the stage", () => {
    const screen = { left: 0, right: 1000, top: 0 };
    const out = stack([{ id: "a", x: 500, y: 400, rank: 0, bubble: [200, 60], said: 1 }], screen);
    expect(out.get("a")).toEqual({ tag: GAP_PX, sign: GAP_PX, bubble: GAP_PX + TAIL_PX, across: 0 });
  });

  it("keeps a bubble out from under the controls over the stage", () => {
    // The buttons over the top left of the stage, down to 170 pixels.
    const screen = { left: 0, right: 1000, top: 45, covered: [{ left: 0, right: 520, top: 45, bottom: 170 }] };
    const under = stack([{ id: "a", x: 300, y: 200, rank: 0, bubble: [200, 60], said: 1 }], screen);
    expect(200 - (under.get("a")?.bubble ?? 0) - 60).toBe(178);
    // Clear of them, it stays where it was.
    const clear = stack([{ id: "b", x: 800, y: 200, rank: 0, bubble: [200, 60], said: 1 }], screen);
    expect(clear.get("b")?.bubble).toBe(GAP_PX + TAIL_PX);
  });

  it("brings a conversation down whole when it would run off the top, still reading in order", () => {
    const screen = { left: 0, right: 1000, top: 0 };
    const out = stack(
      [
        { id: "writer", x: 300, y: 120, rank: 0, bubble: [220, 70], said: 1 },
        { id: "editor", x: 360, y: 120, rank: 0, bubble: [220, 70], said: 2 },
      ],
      screen,
    );
    const top = (id: string) => 120 - (out.get(id)?.bubble ?? 0) - 70;
    // The earlier one at the top of the stage, the newer one under it, neither covering the other.
    expect(top("writer")).toBe(8);
    expect(top("editor")).toBeGreaterThanOrEqual(top("writer") + 70 + GAP_PX);
  });

  it("leaves an answer from further back above the question said nearer the camera, nowhere near an edge", () => {
    // The one who asked stands near the camera, low on the screen; the one answering further back, higher up.
    const cols = [
      { id: "front", x: 500, y: 600, rank: 0, bubble: [220, 60] as [number, number], said: 1 },
      { id: "back", x: 520, y: 300, rank: 0, bubble: [220, 60] as [number, number], said: 2 },
    ];
    const free = stack(cols);
    const out = stack(cols, { left: 0, right: 1280, top: 45 });
    // Each where the stacking put it, over its own speaker: the answer is not dragged down under the question.
    expect(out.get("back")?.bubble).toBe(free.get("back")?.bubble);
    expect(out.get("front")?.bubble).toBe(free.get("front")?.bubble);
    expect(out.get("back")?.bubble).toBeGreaterThan(0);
  });

  it("lifts a bubble out from under a phone's chat, so what is said there can be read", () => {
    // The chat covers the stage below 400 pixels; the speaker's head is under it.
    const out = stack([{ id: "a", x: 200, y: 450, rank: 0, bubble: [200, 60], said: 1 }], {
      left: 0,
      right: 390,
      top: 45,
      bottom: 400,
    });
    expect(450 - (out.get("a")?.bubble ?? 0)).toBe(392);
  });

  it("finishes laying out where rounding leaves a bubble a hair short of what it went up past", () => {
    // Positions as the screen gives them, to the last digit: lifting b2's bubble past b0's tag once landed it a
    // hair inside that tag again, and it went on lifting to the same place for ever.
    const cols: Column[] = [
      { id: "b0", x: 619.363083885686, y: 84.8854685690652, rank: 0.9194681294818726, tag: [129.3773722878552, 20] },
      { id: "b1", x: 563.5350530052256, y: 582.8531006550663, rank: 0.8581656608070087, tag: [123.18255935943805, 20] },
      { id: "b2", x: 727.4445563030637, y: 55.01087092562153, rank: 0.0769478176147434, tag: [136.4438736980985, 20] },
    ];
    const bubbles: [number, number][] = [
      [204.9868066073334, 91.97759483567327],
      [150.9171802508259, 47.51454268932088],
      [293.9508131397659, 97.3949320136546],
    ];
    for (const [i, c] of cols.entries()) Object.assign(c, { bubble: bubbles[i], said: i });
    const out = stack(cols);
    expect([...out.keys()].sort()).toEqual(["b0", "b1", "b2"]);
  });

  it("never lets one bubble cover another once they are brought on the screen, wherever the speakers stand", () => {
    // A seeded walk through many crowds, near the edges and under the controls as often as not.
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let n = 0; n < 300; n++) {
      const count = 2 + Math.floor(rand() * 3);
      const cols: Column[] = Array.from({ length: count }, (_, i) => ({
        id: `b${i}`,
        x: 40 + rand() * 720,
        y: 20 + rand() * 620,
        rank: rand(),
        ...(rand() < 0.7 ? { tag: [80 + rand() * 60, 20] as [number, number] } : {}),
        bubble: [120 + rand() * 200, 40 + rand() * 60] as [number, number],
        said: i + rand() * 0.5,
      }));
      const screen = {
        left: 0,
        right: 800,
        top: 40,
        bottom: 560 + rand() * 100,
        covered: [{ left: 0, right: 200 + rand() * 300, top: 40, bottom: 60 + rand() * 120 }],
      };
      const out = stack(cols, screen);
      const boxes = cols.map((c) => {
        const at = out.get(c.id) as { bubble: number; across: number };
        const [w, h] = c.bubble as [number, number];
        return {
          left: c.x - w / 2 + at.across,
          right: c.x + w / 2 + at.across,
          bottom: c.y - at.bubble,
          top: c.y - at.bubble - h,
        };
      });
      for (const [i, a] of boxes.entries())
        for (const b of boxes.slice(i + 1))
          expect(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).toBe(false);
    }
  });

  it("never moves a bubble so far across that its tail misses it", () => {
    // Wider than the room there is: it stays over its speaker as far as its tail allows.
    const screen = { left: 0, right: 300, top: 0 };
    const out = stack([{ id: "a", x: 290, y: 400, rank: 0, bubble: [600, 60], said: 1 }], screen);
    expect(Math.abs(out.get("a")?.across ?? 0)).toBeLessThanOrEqual(300 - 14);
  });
});
