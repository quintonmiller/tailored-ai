/**
 * Tags, signs and speech bubbles on the screen: big enough to read at any
 * zoom, never too big up close, and kept off each other where bodies stand
 * close, with the newest bubble over its speaker.
 */
import { describe, expect, it } from "vitest";
import {
  type Box,
  BUBBLE_PX,
  type Column,
  CROWD,
  drawnScale,
  GAP_PX,
  metresPerPixel,
  pointer,
  type Stacked,
  stack,
  TAG_PX,
  TAIL_PX,
  TAIL_WIDTH_PX,
} from "./overhead";

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

const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Where a column's tag and bubble are drawn on the screen, as `stack` laid them out, and where its tail ends. */
function drawn(c: Column, at: Stacked): { tag?: Box; bubble?: Box; end?: [number, number] } {
  const out: { tag?: Box; bubble?: Box; end?: [number, number] } = {};
  if (c.tag && !at.hidden) {
    const [w, h] = c.tag;
    const x = c.x + at.tagAcross;
    out.tag = { left: x - w / 2, right: x + w / 2, top: c.y - at.tag - h, bottom: c.y - at.tag };
  }
  if (c.bubble && !at.gone) {
    const [w, h] = c.bubble;
    const x = c.x + at.across;
    out.bubble = { left: x - w / 2, right: x + w / 2, top: c.y - at.bubble - h, bottom: c.y - at.bubble };
  }
  if (at.tail && out.bubble) out.end = [c.x + at.tail.to[0], c.y - at.tail.to[1]];
  return out;
}

/**
 * Whether a column's bubble's tail, if it has one, ends on its own speaker:
 * on the edge of its tag, or on its head; and not under anyone else's tag
 * still shown.
 */
function endsOnOwn(c: Column, at: Stacked, cols: Column[], out: Map<string, Stacked>): boolean {
  const { tag, end } = drawn(c, at);
  if (!end) return true;
  const near = (k: Box, by: number) =>
    end[0] >= k.left - by && end[0] <= k.right + by && end[1] >= k.top - by && end[1] <= k.bottom + by;
  const half = c.body ? (c.body.right - c.body.left) / 2 : 12;
  const head = { left: c.x - half, right: c.x + half, top: c.y, bottom: c.y + 2.4 * half };
  if (!(at.tail?.toTag ? !!tag && near(tag, 0.5) : near(head, 0.5))) return false;
  return cols.every((o) => {
    if (o.id === c.id) return true;
    const t = drawn(o, out.get(o.id) as Stacked).tag;
    return !t || !(end[0] > t.left && end[0] < t.right && end[1] > t.top && end[1] < t.bottom);
  });
}

describe("stack", () => {
  it("puts a tag just over its head, and a bubble over its tag with room for its tail", () => {
    const out = stack([body("a", 300, 400, { bubble: [200, 60], said: 1 })]);
    expect(out.get("a")).toEqual({
      tag: GAP_PX,
      tagAcross: 0,
      sign: GAP_PX + 20 + GAP_PX,
      bubble: GAP_PX + 20 + GAP_PX + TAIL_PX,
      across: 0,
      faded: false,
      hidden: false,
      gone: false,
      // Straight down from the middle of its foot to the top of its own tag.
      tail: { from: [0, 0], to: [0, GAP_PX + 20], toTag: true },
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
    expect(out.get("a")).toEqual({
      tag: GAP_PX,
      tagAcross: 0,
      sign: GAP_PX,
      bubble: GAP_PX + TAIL_PX,
      across: 0,
      faded: false,
      hidden: false,
      gone: false,
    });
  });

  it("puts a speaker's bubble straight over its head when it shows no tag while it speaks", () => {
    const out = stack([{ id: "a", x: 300, y: 400, rank: 0, bubble: [200, 60], said: 1 }]);
    expect(out.get("a")?.bubble).toBe(GAP_PX + TAIL_PX);
  });

  it("brings a bubble that would run off the top of the stage back down to be read, beside its speaker's head", () => {
    const screen = { left: 0, right: 1000, top: 0 };
    const out = stack([{ id: "a", x: 300, y: 50, rank: 0, bubble: [200, 80], said: 1 }], screen);
    const a = out.get("a") as Stacked;
    // Down on its speaker's head there'd be no room for a tail: it goes beside the head, level with it, on the side
    // toward the middle of the stage, its tail from its near side.
    expect(50 - a.bubble - 80).toBe(10);
    expect(300 + a.across - 100).toBeGreaterThan(300);
    expect(a.tail?.from[0]).toBeCloseTo(-100);
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
    expect(out.get("a")).toMatchObject({ tag: GAP_PX, sign: GAP_PX, bubble: GAP_PX + TAIL_PX, across: 0 });
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
        { id: "writer", x: 300, y: 165, rank: 0, bubble: [220, 70], said: 1 },
        { id: "editor", x: 360, y: 165, rank: 0, bubble: [220, 70], said: 2 },
      ],
      screen,
    );
    const top = (id: string) => 165 - (out.get(id)?.bubble ?? 0) - 70;
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
      // What is drawn: a bubble that gave way to newer ones isn't.
      const boxes = cols
        .filter((c) => !(out.get(c.id) as Stacked).gone)
        .map((c) => {
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

  it("brings the bubble of someone at the edge of the stage, or past it, all the way on, its tail leaning back", () => {
    const screen = { left: 0, right: 600, top: 0 };
    // Their head just off the left of the stage: the bubble comes wholly on, and its tail leaves from its foot's
    // left end, pointing back out at them.
    const out = stack([{ id: "a", x: -30, y: 300, rank: 0, bubble: [200, 60], said: 1 }], screen);
    const a = out.get("a") as Stacked;
    expect(-30 + a.across - 100).toBe(8);
    expect(a.tail?.from[0]).toBe(-100 + 14);
    // Wider than the stage: the left edge wins.
    const wide = stack([{ id: "b", x: 290, y: 400, rank: 0, bubble: [700, 60], said: 1 }], screen);
    expect(290 + (wide.get("b")?.across ?? 0) - 350).toBe(8);
  });

  it("moves a tag across rather than up when that is less of a move, staying mostly over its own head", () => {
    // Heads 85 pixels apart, tags 100 wide: 19 pixels across clears the other, where going up would take 24.
    const out = stack([body("a", 300, 400, { rank: 5 }), body("b", 385, 400)]);
    expect(out.get("a")).toMatchObject({ tag: GAP_PX, tagAcross: 0 });
    expect(out.get("b")).toMatchObject({ tag: GAP_PX, tagAcross: 19 });
    // Closer together, across would take it off its own head: it goes up instead.
    const close = stack([body("a", 300, 400, { rank: 5 }), body("b", 330, 400)]);
    expect(close.get("b")?.tagAcross).toBe(0);
    expect(close.get("b")?.tag).toBeGreaterThan(GAP_PX);
  });

  it("draws the tags in a crowd faint, all but the ones to read", () => {
    // Four round a table, close enough on the screen that every tag would meet another.
    const table = [
      body("host", 300, 300),
      body("left", 250, 315),
      body("right", 350, 312),
      body("near", 305, 328, { focus: true }),
    ];
    const out = stack(table);
    expect(out.get("near")?.faded).toBe(false);
    for (const id of ["host", "left", "right"]) expect(out.get(id)?.faded).toBe(true);
    // Two standing together are a pair, not a crowd: neither goes faint.
    expect(CROWD).toBeGreaterThan(2);
    const pair = stack([body("a", 300, 400), body("b", 330, 400)]);
    expect([pair.get("a")?.faded, pair.get("b")?.faded]).toEqual([false, false]);
  });

  it("keeps a speaker's own tag, and points its bubble's tail at the top of it", () => {
    const out = stack([body("a", 300, 400, { bubble: [200, 60], said: 1, focus: true })]);
    const a = out.get("a") as Stacked;
    expect(a.hidden).toBe(false);
    expect(a.tail).toEqual({ from: [0, 0], to: [0, GAP_PX + 20], toTag: true });
    // The bubble's foot is a tail's length over the top of the tag.
    expect(a.bubble - (a.tag + 20)).toBe(GAP_PX + TAIL_PX);
  });

  it("leads a tail round the head of someone standing between the bubble and its speaker", () => {
    // The speaker near the camera, low on the screen; someone further back stands in line, their head just over
    // the speaker's tag, so a tail straight down would run into it.
    const speaker = body("speaker", 400, 400, {
      rank: 1000,
      bubble: [220, 60],
      said: 1,
      focus: true,
      body: { left: 385, right: 415, top: 400, bottom: 470 },
    });
    const behind = { id: "behind", x: 402, y: 340, rank: 0, body: { left: 388, right: 416, top: 340, bottom: 400 } };
    const out = stack([speaker, behind]);
    const s = out.get("speaker") as Stacked;
    expect(s.tail?.toTag).toBe(true);
    // Where the tail leaves the bubble and where it points, on the screen.
    const foot: [number, number] = [400 + s.across + (s.tail?.from[0] ?? 0), 400 - s.bubble - (s.tail?.from[1] ?? 0)];
    const to: [number, number] = [400 + s.tagAcross, 400 - s.tag - 20];
    expect(foot[0]).not.toBe(400);
    // Nowhere along it is it over the head further back.
    const head = { left: 388, right: 416, top: 340, bottom: 374 };
    for (let t = 0; t <= 1; t += 0.02) {
      const x = foot[0] + (to[0] - foot[0]) * t;
      const y = foot[1] + (to[1] - foot[1]) * t;
      expect(x > head.left + 2 && x < head.right - 2 && y > head.top + 2 && y < head.bottom - 2).toBe(false);
    }
  });

  it("puts a bubble brought down below the controls beside its speaker, off the body in front", () => {
    // Zoomed in: the speaker stands far back, its head under the buttons along the top; you stand in front of it,
    // your body filling the middle of the stage below.
    const screen = { left: 0, right: 610, top: 0, covered: [{ left: 0, right: 560, top: 0, bottom: 120 }] };
    const out = stack(
      [
        {
          id: "concierge",
          x: 300,
          y: 100,
          rank: 0,
          tag: [90, 20],
          bubble: [100, 50],
          said: 1,
          body: { left: 285, right: 315, top: 100, bottom: 140 },
        },
        {
          id: "you",
          x: 305,
          y: 230,
          rank: 2000,
          tag: [50, 26],
          body: { left: 230, right: 380, top: 230, bottom: 460 },
        },
      ],
      screen,
    );
    const c = out.get("concierge") as Stacked;
    const b: Box = {
      left: 300 + c.across - 50,
      right: 300 + c.across + 50,
      top: 100 - c.bubble - 50,
      bottom: 100 - c.bubble,
    };
    // Under the buttons, to the side of the speaker's head rather than on it.
    expect(b.top).toBeGreaterThanOrEqual(128);
    expect(b.left >= 315 || b.right <= 285).toBe(true);
    // Its tail leaves its top, at the end nearer the speaker, and points up at its head: the tag is under the buttons.
    expect(c.tail?.toTag).toBe(false);
    expect(c.tail?.from[1]).toBe(50);
    expect(Math.sign(c.tail?.from[0] ?? 0)).toBe(-Math.sign(c.across));
    // And it is nowhere over you.
    const you = { left: 230, right: 380, top: 230 - 30, bottom: 460 };
    expect(b.left < you.right && you.left < b.right && b.top < you.bottom && you.top < b.bottom).toBe(false);
  });

  it("has an earlier bubble give way when there's no room above the newer one, which stays on its speaker's tag", () => {
    // The earlier one went up over the newer and off the top: brought down, it would push the newer one down over
    // its own speaker's tag. So it gives way, and the newer one sits where it would with nobody else talking.
    const screen = { left: 0, right: 1000, top: 0 };
    const cols = [
      body("first", 420, 140, { bubble: [240, 90], said: 1 }),
      body("next", 400, 150, { bubble: [200, 50], said: 2, rank: 1000, focus: true }),
    ];
    const out = stack(cols, screen);
    const next = out.get("next") as Stacked;
    expect(out.get("first")?.gone).toBe(true);
    expect(next).toMatchObject({ gone: false, hidden: false, across: 0, tail: { toTag: true } });
    const quiet = stack([body("first", 420, 140), cols[1]], screen).get("next") as Stacked;
    expect(next.bubble).toBe(quiet.bubble);
    // With room above it, nothing gives way.
    const roomy = stack(
      cols.map((c) => ({ ...c, y: c.y + 200 })),
      screen,
    );
    expect([roomy.get("first")?.gone, roomy.get("next")?.gone]).toEqual([false, false]);
  });

  it("keeps a speaker's tag over its own head, ahead of the one you stand by, so its tail reaches it there", () => {
    // You stand by "near", whose tag would keep its place any other time; "speaker", right beside it, is talking.
    const out = stack([
      body("near", 300, 300, { rank: 2000, focus: true }),
      body("speaker", 320, 302, { rank: 1000, focus: true, bubble: [200, 60], said: 1 }),
    ]);
    expect(out.get("speaker")).toMatchObject({ tag: GAP_PX, tagAcross: 0, hidden: false, tail: { toTag: true } });
    const near = out.get("near") as Stacked;
    expect(near.tag > GAP_PX || near.tagAcross !== 0).toBe(true);
  });

  it("ends a tail on its speaker's tag nearer an end when someone's head is behind the middle of it", () => {
    // Someone further back stands just behind the speaker, their head over the middle of the top of its tag.
    const speaker = body("speaker", 400, 400, { bubble: [200, 60], said: 1, focus: true });
    const behind = { id: "behind", x: 400, y: 360, rank: 0, body: { left: 390, right: 410, top: 360, bottom: 420 } };
    const s = stack([speaker, behind]).get("speaker") as Stacked;
    const end = drawn(speaker, s).end as [number, number];
    expect(s.tail?.toTag).toBe(true);
    expect(end[1]).toBe(400 - GAP_PX - 20);
    expect(end[0] < 390 || end[0] > 410).toBe(true);
  });

  it("brings a bubble with no room over its speaker's tag beside its face, its tag still shown", () => {
    // Its head just under the buttons: no room over the tag for the bubble.
    const screen = { left: 0, right: 800, top: 0, covered: [{ left: 0, right: 800, top: 0, bottom: 150 }] };
    const speaker = body("speaker", 400, 200, {
      bubble: [200, 60],
      said: 1,
      focus: true,
      body: { left: 380, right: 420, top: 200, bottom: 300 },
    });
    const s = stack([speaker], screen).get("speaker") as Stacked;
    const { tag, bubble, end } = drawn(speaker, s);
    expect(s.hidden).toBe(false);
    expect(meets(tag as Box, bubble as Box)).toBe(false);
    // Beside it, level with its face, its tail to the side of its face.
    expect((bubble as Box).left >= 420 || (bubble as Box).right <= 380).toBe(true);
    expect(s.tail?.toTag).toBe(false);
    expect(end?.[1]).toBeGreaterThan(200);
    expect(Math.abs((end?.[0] ?? 0) - 400)).toBeLessThan(20);
  });

  it("puts a bubble beside its speaker on the side its tail can reach without crossing anyone's head", () => {
    // A small body stands just to the speaker's right, between its face and the bubble's place on that side: there,
    // the tail would run over that head. On the left it reaches the speaker clear of everyone.
    const screen = { left: 0, right: 800, top: 0, covered: [{ left: 0, right: 800, top: 0, bottom: 150 }] };
    const speaker = body("speaker", 300, 200, {
      bubble: [200, 60],
      said: 1,
      focus: true,
      body: { left: 280, right: 320, top: 200, bottom: 300 },
    });
    const small = { id: "small", x: 318, y: 200, rank: 0, body: { left: 312, right: 324, top: 200, bottom: 260 } };
    const s = stack([speaker, small], screen).get("speaker") as Stacked;
    const { bubble } = drawn(speaker, s);
    expect((bubble as Box).right).toBeLessThanOrEqual(300);
    expect(s.tail?.toTag).toBe(false);
  });

  it("keeps both tags of two talking side by side under the controls, each tail on its own speaker", () => {
    // Two at the edge of a busy table, heads a little under the buttons and the trail, the newer bubble pushed down
    // by the earlier one. Neither tag is put away, and whatever is drawn points at its own speaker.
    const screen = {
      left: 0,
      right: 610,
      top: 0,
      covered: [
        { left: 16, right: 554, top: 96, bottom: 122 },
        { left: 16, right: 255, top: 134, bottom: 160 },
      ],
    };
    const cols = [
      body("two", 125, 259, {
        tag: [102, 23],
        bubble: [204, 68],
        said: 1,
        rank: 1000,
        focus: true,
        body: { left: 107, right: 143, top: 259, bottom: 300 },
      }),
      body("three", 90, 262, {
        tag: [115, 23],
        bubble: [192, 68],
        said: 2,
        rank: 1000,
        focus: true,
        body: { left: 72, right: 108, top: 262, bottom: 305 },
      }),
    ];
    const out = stack(cols, screen);
    expect(out.get("three")?.gone).toBe(false);
    for (const c of cols) {
      const at = out.get(c.id) as Stacked;
      if (at.gone) continue;
      expect(at.hidden).toBe(false);
      expect(endsOnOwn(c, at, cols, out)).toBe(true);
    }
  });

  it("puts away a faint tag in a crowd rather than stack it a column high", () => {
    // Six heads in a huddle: the tags would stack five high over it.
    const huddle = Array.from({ length: 6 }, (_, i) => body(`b${i}`, 300 + i * 6, 300 + i, { rank: -i }));
    const out = stack(huddle);
    const shown = huddle.filter((c) => !(out.get(c.id) as Stacked).hidden);
    expect(shown.length).toBeLessThan(huddle.length);
    for (const c of shown) expect((out.get(c.id) as Stacked).tag).toBeLessThanOrEqual(GAP_PX + 2 * (20 + GAP_PX) + 1);
    // One you point at, or that speaks, always shows, however high it has to go.
    const pointed = stack(huddle.map((c) => (c.id === "b5" ? { ...c, focus: true } : c)));
    expect(pointed.get("b5")?.hidden).toBe(false);
  });

  it("never covers a speaker's tag, and ends every tail on its own speaker, in any crowd", () => {
    let seed = 23;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let n = 0; n < 400; n++) {
      const count = 2 + Math.floor(rand() * 5);
      const cols: Column[] = Array.from({ length: count }, (_, i) => {
        const x = 40 + rand() * 560;
        const y = 60 + rand() * 360;
        const half = 10 + rand() * 20;
        return {
          id: `b${i}`,
          x,
          y,
          rank: rand() * 3000,
          focus: rand() < 0.3,
          tag: [60 + rand() * 70, 20 + rand() * 6] as [number, number],
          ...(rand() < 0.8 ? { body: { left: x - half, right: x + half, top: y, bottom: y + half * 4 } } : {}),
          ...(rand() < 0.55 ? { bubble: [120 + rand() * 110, 40 + rand() * 40] as [number, number], said: i } : {}),
        };
      });
      // Half the time, a phone's chat over the foot of the stage too.
      const foot = rand() < 0.5 ? { bottom: 330 + rand() * 160 } : {};
      const screen = {
        left: 0,
        right: 640,
        top: 40,
        ...foot,
        covered: [{ left: 0, right: 200 + rand() * 400, top: 40, bottom: 60 + rand() * 140 }],
      };
      const out = stack(cols, screen);
      for (const c of cols) {
        const at = out.get(c.id) as Stacked;
        if (!c.bubble || at.gone) continue;
        expect(at.hidden).toBe(false);
        expect(endsOnOwn(c, at, cols, out)).toBe(true);
      }
    }
  });

  it("puts away a tag a bubble brought back on the screen had to come down over", () => {
    // b's tag was lifted clear of a's; a's bubble, brought down from off the top, now covers it.
    const screen = { left: 0, right: 1000, top: 0 };
    const out = stack([body("a", 300, 95, { bubble: [220, 60], said: 1, rank: 1 }), body("b", 330, 95)], screen);
    expect(out.get("b")?.hidden).toBe(true);
    expect(out.get("a")?.hidden).toBe(false);
  });

  it("never lets two tags meet, or a bubble cover a tag still shown, in any crowd", () => {
    let seed = 11;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (let n = 0; n < 300; n++) {
      const count = 2 + Math.floor(rand() * 5);
      const cols: Column[] = Array.from({ length: count }, (_, i) => ({
        id: `b${i}`,
        x: 60 + rand() * 500,
        y: 80 + rand() * 300,
        rank: rand(),
        tag: [70 + rand() * 60, 20] as [number, number],
        ...(rand() < 0.5 ? { bubble: [120 + rand() * 120, 40 + rand() * 40] as [number, number], said: i } : {}),
      }));
      const screen = {
        left: 0,
        right: 640,
        top: 40,
        covered: [{ left: 0, right: 200 + rand() * 300, top: 40, bottom: 60 + rand() * 120 }],
      };
      const out = stack(cols, screen);
      const tags = cols
        .filter((c) => !(out.get(c.id) as Stacked).hidden)
        .map((c) => {
          const at = out.get(c.id) as Stacked;
          const [w, h] = c.tag as [number, number];
          const x = c.x + at.tagAcross;
          return { left: x - w / 2, right: x + w / 2, top: c.y - at.tag - h, bottom: c.y - at.tag };
        });
      const bubbles = cols
        .filter((c) => c.bubble && !(out.get(c.id) as Stacked).gone)
        .map((c) => {
          const at = out.get(c.id) as Stacked;
          const [w, h] = c.bubble as [number, number];
          const x = c.x + at.across;
          return { left: x - w / 2, right: x + w / 2, top: c.y - at.bubble - h, bottom: c.y - at.bubble };
        });
      for (const [i, a] of tags.entries()) {
        for (const b of tags.slice(i + 1)) expect(meets(a, b)).toBe(false);
        for (const b of bubbles) expect(meets(a, b)).toBe(false);
      }
    }
  });
});

describe("pointer", () => {
  /** Where a point of a sprite drawn as `p` ends up, from the top of the head: `u` across it, `v` up it from its tip. */
  const at = (p: NonNullable<ReturnType<typeof pointer>>, width: number, u: number, v: number): [number, number] => {
    const x = (u - p.center[0]) * width;
    const y = (v - p.center[1]) * p.length;
    return [Math.cos(p.turn) * x - Math.sin(p.turn) * y, Math.sin(p.turn) * x + Math.cos(p.turn) * y];
  };

  it("stands straight up from just over the top of the head to a bubble right above it", () => {
    const p = pointer([0, 40], [0, 0], GAP_PX, TAIL_WIDTH_PX);
    expect(p).toEqual({ length: 40 - GAP_PX, turn: 0, center: [0.5, -GAP_PX / (40 - GAP_PX)] });
  });

  it("reaches from where the tail leaves its bubble to just short of what it points at, whichever way", () => {
    for (const [from, to] of [
      [
        [60, 50],
        [0, 24],
      ],
      [
        [-80, 10],
        [0, 0],
      ],
      [
        [45, -20],
        [-5, 30],
      ],
    ] as [number, number][][]) {
      const p = pointer(from, to, GAP_PX, TAIL_WIDTH_PX);
      if (!p) throw new Error("no pointer");
      const far = Math.hypot(from[0] - to[0], from[1] - to[1]);
      const tip = at(p, TAIL_WIDTH_PX, 0.5, 0);
      const root = at(p, TAIL_WIDTH_PX, 0.5, 1);
      expect(root[0]).toBeCloseTo(from[0], 6);
      expect(root[1]).toBeCloseTo(from[1], 6);
      expect(tip[0]).toBeCloseTo(to[0] + ((from[0] - to[0]) / far) * GAP_PX, 6);
      expect(tip[1]).toBeCloseTo(to[1] + ((from[1] - to[1]) / far) * GAP_PX, 6);
    }
  });

  it("draws nothing between two points closer than the gap it keeps", () => {
    expect(pointer([0, 3], [0, 0], GAP_PX, TAIL_WIDTH_PX)).toBeUndefined();
  });
});
