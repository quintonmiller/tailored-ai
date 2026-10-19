/**
 * What floats over the bodies, on the screen: a body's tag, the sign above it
 * and a speech bubble, sized to read at any zoom and kept from covering each
 * other where bodies stand close. Each is drawn on a canvas, at the size it
 * was made for in the room, unless that comes out too small to read from a
 * camera far back, or too big up close; then it is drawn at the nearest size
 * that reads. Pure, so it is tested without a GPU: the stage works out where
 * each body's head is on the screen, and puts everything where this says.
 */

/** CSS pixels on screen for each pixel of a tag's canvas: its name between 14 and 22 pixels high. */
export const TAG_PX: [number, number] = [0.32, 0.5];
/** The same for a speech bubble: what was said between 14 and 21 pixels high, which is what is there to read. */
export const BUBBLE_PX: [number, number] = [0.36, 0.56];
/** The same for a sign over a head: between 26 and 46 pixels across. */
export const SIGN_PX: [number, number] = [0.2, 0.36];
/** Pixels between one thing over a head and the next, and between a tag and the head under it. */
export const GAP_PX = 4;
/** How long a bubble's tail is, at the least, in pixels: room between it and its speaker for the tail to point. */
export const TAIL_PX = 12;
/** How wide a bubble's tail is where it meets the bubble, in pixels. */
export const TAIL_WIDTH_PX = 14;

/** Metres a CSS pixel covers `depth` metres in front of a camera with a vertical field of view of `fov` degrees, on a stage `height` pixels high. */
export function metresPerPixel(depth: number, fov: number, height: number): number {
  return (2 * Math.max(0.05, depth) * Math.tan((fov * Math.PI) / 360)) / Math.max(1, height);
}

/**
 * How big to draw something, in metres for each pixel of its canvas: `made`
 * as it was made, unless at `perPixel` metres to a pixel of the screen that
 * comes out smaller or bigger than `limits` (screen pixels for each canvas
 * pixel) allow.
 */
export function drawnScale(made: number, perPixel: number, [lo, hi]: [number, number]): number {
  const shown = made / perPixel;
  return Math.min(hi, Math.max(lo, shown)) * perPixel;
}

/** A rectangle on the screen, in CSS pixels, down the page from the top. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box, gap: number) =>
  a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;

/**
 * How far to lift something `w` by `h` pixels, centred at `x` and standing on
 * `y` (its bottom edge, down the page), so it clears every box in `placed`:
 * straight up, just past whatever is in the way, as many times as it takes.
 */
function clearOf(x: number, y: number, w: number, h: number, placed: Box[], gap: number): number {
  let up = 0;
  for (;;) {
    const me = { left: x - w / 2, right: x + w / 2, top: y - up - h, bottom: y - up };
    const hit = placed.find((p) => overlaps(me, p, gap));
    if (!hit) return up;
    // Its bottom just above the top of what it hit, which is always further up than it is now.
    up = y - hit.top + gap;
  }
}

/** One body's things over its head, as the stage sees them this frame. */
export interface Column {
  id: string;
  /** Where on the screen the top of its head is, in CSS pixels across and down the page. */
  x: number;
  y: number;
  /** Its tag's size on the screen, when it has one. */
  tag?: [number, number];
  /** How high its sign is on the screen, while one shows over the tag. */
  sign?: number;
  /** Its bubble's size on the screen, while it is saying something. */
  bubble?: [number, number];
  /** Which tags keep their place when two meet: the higher stays put and the lower goes up out of its way. */
  rank: number;
  /** When it started saying what is in its bubble: the latest stays over the speaker, earlier ones go up above it. */
  said?: number;
}

/** What a body has over its head this frame, sized for the screen: the part of a column the body itself knows. */
export type Over = Pick<Column, "tag" | "sign" | "bubble" | "said">;

/** Where a body's things go: how far up from the top of its head the bottom of each is, in CSS pixels. */
export interface Stacked {
  tag: number;
  sign: number;
  bubble: number;
  /** How far across its bubble goes to stay on the screen, in CSS pixels, to the right; 0 over its head. */
  across: number;
}

/**
 * The part of the stage that can be seen, in CSS pixels, and the controls
 * laid over it: a bubble is kept inside it and out from under them, so it can
 * be read whole.
 */
export interface Screen {
  left: number;
  right: number;
  top: number;
  covered?: Box[];
}

/** Pixels a bubble keeps from the edges of what can be seen. */
const EDGE_PX = 8;

/**
 * Lay out every body's tag, sign and bubble so none covers another. Each
 * body's go in a column over its head: the tag, then the sign or the bubble
 * above it. Where two bodies stand close, the tags meet first: the higher
 * ranked keeps its place, and the other goes up just clear of it, still over
 * its own body, like the names on a crowded map. Then the bubbles, newest
 * first: the newest sits over its speaker, and each earlier one goes up
 * above whatever it would cover, so a conversation reads from the top down,
 * like a comic. A bubble never covers a tag either. Last, bubbles that would
 * run off what can be seen of the stage (`screen`), or under a control laid
 * over it, are brought back inside it: across rather than under a panel at
 * the side, and down rather than off the top, the newer ones below them
 * coming down too, so the conversation still reads in order, over its
 * speakers if it has to be.
 */
export function stack(columns: Column[], screen?: Screen, gap = GAP_PX): Map<string, Stacked> {
  const out = new Map<string, Stacked>();
  const tags: Box[] = [];
  const tagOf = new Map<string, Box>();
  // Ties go the same way every frame, so nothing swaps places for no reason.
  const byRank = [...columns].sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of byRank) {
    const [w, h] = c.tag ?? [0, 0];
    // A sign shows over a tag only while there is no bubble, and needs its room too.
    const sign = c.sign && !c.bubble ? c.sign + gap : 0;
    const base = c.y - gap;
    const up = c.tag || sign ? clearOf(c.x, base, w, h + sign, tags, gap) : 0;
    if (c.tag || sign) {
      const box = { left: c.x - w / 2, right: c.x + w / 2, top: base - up - h - sign, bottom: base - up };
      tags.push(box);
      tagOf.set(c.id, box);
    }
    const tagTop = gap + up + h;
    out.set(c.id, {
      tag: gap + up,
      sign: c.tag ? tagTop + gap : gap + up,
      bubble: (c.tag ? tagTop + gap : gap) + TAIL_PX,
      across: 0,
    });
  }
  const placed: Box[] = [];
  const bySaid = columns.filter((c) => c.bubble).sort((a, b) => (b.said ?? 0) - (a.said ?? 0));
  for (const c of bySaid) {
    const [w, h] = c.bubble as [number, number];
    const at = out.get(c.id) as Stacked;
    const base = c.y - at.bubble;
    const own = tagOf.get(c.id);
    const up = clearOf(c.x, base, w, h, [...tags.filter((t) => t !== own), ...placed], gap);
    placed.push({ left: c.x - w / 2, right: c.x + w / 2, top: base - up - h, bottom: base - up });
    at.bubble += up;
  }
  if (!screen) return out;
  // Oldest first, so each comes down only as far as it must, and the newer ones under it make way in turn.
  const kept: Box[] = [];
  for (const c of [...bySaid].reverse()) {
    const [w, h] = c.bubble as [number, number];
    const at = out.get(c.id) as Stacked;
    // Off a side: across, the left edge winning when it is wider than the room there is. Never so far that its
    // tail, which stays over the speaker, would miss it.
    const left = c.x - w / 2;
    const right = c.x + w / 2;
    if (right > screen.right - EDGE_PX) at.across = screen.right - EDGE_PX - right;
    if (left + at.across < screen.left + EDGE_PX) at.across = screen.left + EDGE_PX - left;
    const reach = Math.max(0, w / 2 - TAIL_WIDTH_PX);
    at.across = Math.max(-reach, Math.min(reach, at.across));
    const l = left + at.across;
    const r = right + at.across;
    // The highest its top may go: the top of the stage, the foot of any control over it, and below an earlier
    // bubble it would otherwise cover.
    let ceiling = screen.top + EDGE_PX;
    for (const k of screen.covered ?? [])
      if (k.left < r && l < k.right) ceiling = Math.max(ceiling, k.bottom + EDGE_PX);
    for (const k of kept) if (k.left < r + gap && l - gap < k.right) ceiling = Math.max(ceiling, k.bottom + gap);
    const top = c.y - at.bubble - h;
    if (top < ceiling) at.bubble -= ceiling - top;
    kept.push({ left: l, right: r, top: c.y - at.bubble - h, bottom: c.y - at.bubble });
  }
  return out;
}

/** How quickly something put somewhere new gets there, in seconds: quick, but never a jump. */
export const SETTLE_SECONDS = 0.15;
