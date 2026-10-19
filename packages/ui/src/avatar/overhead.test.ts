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

  it("never moves a bubble so far across that its tail misses it", () => {
    // Wider than the room there is: it stays over its speaker as far as its tail allows.
    const screen = { left: 0, right: 300, top: 0 };
    const out = stack([{ id: "a", x: 290, y: 400, rank: 0, bubble: [600, 60], said: 1 }], screen);
    expect(Math.abs(out.get("a")?.across ?? 0)).toBeLessThanOrEqual(300 - 14);
  });
});
