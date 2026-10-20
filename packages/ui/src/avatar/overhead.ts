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
  // What it has gone up past. Rounding can leave it a hair short of clearing one, which must not count as
  // meeting it again, or it would lift to the same place for ever.
  const passed = new Set<Box>();
  for (;;) {
    const me = { left: x - w / 2, right: x + w / 2, top: y - up - h, bottom: y - up };
    const hit = placed.find((p) => !passed.has(p) && overlaps(me, p, gap));
    if (!hit) return up;
    passed.add(hit);
    // Its bottom just above the top of what it hit, which is always further up than it is now.
    up = Math.max(up, y - hit.top + gap);
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
  /**
   * Whether its tag is the one to read: under the pointer, of the one you
   * stand by, or of a body speaking. In a crowd, the tags that aren't are
   * drawn faint, so the one that is stands out.
   */
  focus?: boolean;
  /**
   * Its body on the screen, from the top of its head to its feet: a bubble
   * brought down beside its own speaker keeps off everyone else's, and a
   * tail is led round their heads rather than over them.
   */
  body?: Box;
}

/** What a body has over its head this frame, sized for the screen: the part of a column the body itself knows. */
export type Over = Pick<Column, "tag" | "sign" | "bubble" | "said">;

/** Where a bubble's tail leaves it, and what it points at. */
export interface Tail {
  /** From the middle of the bubble's foot, in CSS pixels to the right and up: on its foot, or a side when it is beside its speaker. */
  from: [number, number];
  /**
   * What it points at, in CSS pixels to the right of and up from the top of
   * the head: the edge of its speaker's tag, which it reaches with no gap;
   * the top of its head, while the tag is put away; or, from beside, the
   * side of its face.
   */
  to: [number, number];
  /** It points at its speaker's tag, and moves with it. */
  toTag: boolean;
}

/** Where a body's things go: how far up from the top of its head the bottom of each is, in CSS pixels. */
export interface Stacked {
  tag: number;
  /** How far across its tag went to make way for another, in CSS pixels to the right; 0 over its head. */
  tagAcross: number;
  sign: number;
  bubble: number;
  /** How far across its bubble goes to stay on the screen, in CSS pixels, to the right; 0 over its head. */
  across: number;
  /** Its tag is in a crowd and isn't the one to read (`Column.focus`): drawn faint. */
  faded: boolean;
  /**
   * Its tag is put away for now: a bubble brought back on to the screen had
   * to come down over it, or, faint in a crowd, it would have had to go up
   * past a couple of others to make way. Never a speaker's own, while its
   * bubble is drawn.
   */
  hidden: boolean;
  /**
   * Its bubble gives way for now, in a crowd: it went up over newer ones and there is no room left above them on
   * the screen. The newest lines are the ones to read; all of them are in the chat beside.
   */
  gone: boolean;
  /** Its bubble's tail, while it has a bubble with room for one between it and what it points at. */
  tail?: Tail;
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
  /** The foot of what can be seen, when something covers the stage's foot, like the chat on a phone. */
  bottom?: number;
  covered?: Box[];
}

/** Pixels a bubble keeps from the edges of what can be seen. */
const EDGE_PX = 8;
/** How many tags have to meet, each over its own head, before they are a crowd and the ones not to read go faint. */
export const CROWD = 3;
/** The furthest a tag goes across to make way, as a share of its width: any further, and it goes up instead. */
const STAGGER = 0.6;
/** A tag that went more than this far from over its head has a line down to it, so it is plain whose it is. */
export const LEADER_PX = 10;
/** The shortest tail drawn: closer than this, a bubble is on what it points at. */
const SHORTEST_TAIL = 6;
/** How far in from a bubble's corners its tail leaves it, so the tail's root is all on the bubble's edge. */
const TAIL_INSET = TAIL_WIDTH_PX;
/** Half the width of a head on the screen, for a column the stage gave no body. */
const HEAD_HALF_PX = 12;
/**
 * A faint tag in a crowd (`Stacked.faded`) that would have to go up more
 * than this many of its own heights to make way is put away instead: a
 * column of names over a table, a body high, says nothing about whose is
 * whose, and its line down would be lost among the others.
 */
const CROWD_LIFT = 2;
/** Where a face is, as a share of half a body's width on the screen: across from the middle of it, and down from the top of the head. */
const FACE: [number, number] = [0.4, 0.5];

const box = (x: number, bottom: number, w: number, h: number): Box => ({
  left: x - w / 2,
  right: x + w / 2,
  top: bottom - h,
  bottom,
});

/** How much of `a` covers `b`, in square pixels. */
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * Where a tag goes to clear the tags put down before it: straight up, just
 * past whatever is in the way; or, when that is less of a move, across just
 * clear of what it met, to either side, as long as it stays mostly over its
 * own head and on the screen. Up costs a pixel a pixel, across the same.
 */
function makeWay(
  x: number,
  base: number,
  w: number,
  h: number,
  placed: Box[],
  gap: number,
  screen?: Screen,
): { up: number; across: number } {
  const straight = clearOf(x, base, w, h, placed, gap);
  if (straight === 0) return { up: 0, across: 0 };
  let best = { up: straight, across: 0, cost: straight };
  const here = box(x, base, w, h);
  const hits = placed.filter((p) => overlaps(here, p, gap));
  const middle = hits.reduce((s, p) => s + (p.left + p.right) / 2, 0) / Math.max(1, hits.length);
  const right = Math.max(...hits.map((p) => p.right + gap - here.left));
  const left = -Math.max(...hits.map((p) => here.right - (p.left - gap)));
  // The side its head is on first, so two that meet part the way they stand.
  for (const across of x >= middle ? [right, left] : [left, right]) {
    if (Math.abs(across) > STAGGER * w) continue;
    if (screen && (x + across - w / 2 < screen.left || x + across + w / 2 > screen.right)) continue;
    const up = clearOf(x + across, base, w, h, placed, gap);
    const cost = up + Math.abs(across);
    if (cost < best.cost - 1e-6) best = { up, across, cost };
  }
  return { up: best.up, across: best.across };
}

/**
 * The tags that are in a crowd: each over its own head, where it would be if
 * nothing made way, it meets others, and they others, `CROWD` or more of them.
 */
function crowdsOf(columns: Column[], gap: number): Set<string> {
  const tagged = columns.filter((c) => c.tag);
  const boxes = tagged.map((c) => {
    const [w, h] = c.tag as [number, number];
    return box(c.x, c.y - gap, w, h + (c.sign && !c.bubble ? c.sign + gap : 0));
  });
  const group = tagged.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j], 0)) group[root(i)] = root(j);
  const sizes = new Map<number, number>();
  for (let i = 0; i < boxes.length; i++) sizes.set(root(i), (sizes.get(root(i)) ?? 0) + 1);
  return new Set(tagged.filter((_, i) => (sizes.get(root(i)) ?? 0) >= CROWD).map((c) => c.id));
}

/** The top of a body on the screen, where a tail going over it would look like it pointed at it. */
function headOf(c: Column): Box {
  const b = c.body ?? { left: c.x - HEAD_HALF_PX, right: c.x + HEAD_HALF_PX, top: c.y, bottom: c.y + 2 * HEAD_HALF_PX };
  const across = b.right - b.left;
  return { left: b.left, right: b.right, top: b.top, bottom: b.top + Math.min(b.bottom - b.top, across * 1.2) };
}

/** Half a body's width on the screen. */
const halfOf = (c: Column) => (c.body ? (c.body.right - c.body.left) / 2 : HEAD_HALF_PX);

/** The side of a face on the screen, to the right (`side` 1) or the left (-1): what a tail from a bubble beside it points at. */
const faceOf = (c: Column, side: number): [number, number] => [
  c.x + side * FACE[0] * halfOf(c),
  c.y + FACE[1] * halfOf(c),
];

/** Whether the line from `a` to `b` passes over a box, its edges shaved by `shave` pixels: clipped to it, any of it left. */
function crosses([ax, ay]: [number, number], [bx, by]: [number, number], k: Box, shave = 2): boolean {
  let lo = 0;
  let hi = 1;
  const clip = (from: number, by: number, min: number, max: number) => {
    if (Math.abs(by) < 1e-9) return from > min && from < max;
    const [t1, t2] = [(min - from) / by, (max - from) / by].sort((p, q) => p - q);
    lo = Math.max(lo, t1);
    hi = Math.min(hi, t2);
    return lo < hi;
  };
  return (
    clip(ax, bx - ax, k.left + shave, k.right - shave) && clip(ay, by - ay, k.top + shave, k.bottom - shave) && lo < hi
  );
}

/**
 * Where a bubble's tail leaves it, on the screen, to point at `to`: from its
 * foot when it is over what it points at, its top when under it, or the
 * nearer side when it is beside it; none when it is all but touching it,
 * where it plainly belongs already. Leaving the foot, the tail goes straight
 * down if it can; if that would take it over someone else's head or tag (a
 * body further back, standing in line), it leaves from further along the
 * foot, the nearest place it misses them all from.
 */
function tailFrom(b: Box, to: [number, number], others: Box[]): [number, number] | undefined {
  const lo = b.left + TAIL_INSET;
  const hi = Math.max(lo, b.right - TAIL_INSET);
  const along = Math.min(hi, Math.max(lo, to[0]));
  let from: [number, number];
  if (b.bottom <= to[1] || b.top >= to[1]) {
    const y = b.bottom <= to[1] ? b.bottom : b.top;
    from = [along, y];
    if (others.some((k) => crosses(from, to, k)))
      for (let d = 6; d <= hi - lo; d += 6) {
        const tried = [along - d, along + d].filter((x) => x >= lo && x <= hi);
        const clear = tried.find((x) => !others.some((k) => crosses([x, y], to, k)));
        if (clear !== undefined) {
          from = [clear, y];
          break;
        }
      }
  } else {
    const x = to[0] < (b.left + b.right) / 2 ? b.left : b.right;
    from = [x, Math.min(b.bottom - TAIL_INSET, Math.max(b.top + TAIL_INSET, to[1]))];
  }
  return Math.hypot(from[0] - to[0], from[1] - to[1]) >= SHORTEST_TAIL ? from : undefined;
}

/**
 * Lay out every body's tag, sign and bubble so none covers another. Each
 * body's go in a column over its head: the tag, then the sign or the bubble
 * above it. Where two bodies stand close, the tags meet first: a speaker's
 * keeps its place over its own head, so who is talking can be told, then the
 * higher ranked, and each other goes just clear of those put down before
 * it, up or across, whichever is less of a move, still mostly over its own
 * body, like the names on a crowded map. One that went further than
 * `LEADER_PX` has a line down to its head, drawn by the body. Where three or
 * more tags would meet, they are a crowd: the ones that aren't to read
 * (`Column.focus`, or a speaker's) are drawn faint, and a faint one that
 * would have to go a column high is put away instead (`CROWD_LIFT`).
 *
 * Then the bubbles, newest first: the newest sits over its speaker's tag, and
 * each earlier one goes up above whatever it would cover, so a conversation
 * reads from the top down, like a comic. A bubble never covers a tag either.
 * Then bubbles that would run off what can be seen of the stage (`screen`),
 * or under a control laid over it, are brought back inside it: across
 * rather than under a panel at the side or off an edge, however far, up
 * rather than under a phone's chat, and down rather than off the top, the
 * newer ones under them coming down too, so the conversation still reads in
 * order. A bubble that sat above another stays above it; one lower down the
 * screen, nearer the camera, is passed only when one would now cover the
 * other. One brought down so far that it would sit on its own speaker's tag,
 * or its head, or on another speaker's tag, goes beside its speaker instead
 * (`besideHead`). In a crowd, one that went up over newer ones and has no
 * room left above them gives way to them (`Stacked.gone`); so does an
 * earlier one in the way of a bubble with nowhere beside its speaker to go,
 * or, with none in its way, that bubble itself, unless it is the newest. A
 * speaker's own tag is never covered by a bubble; any other tag a bubble had
 * to come down over is put away until the bubble goes. Last, each bubble's
 * tail (`tailFrom`): to the edge of its speaker's tag, the top of its head
 * while the tag is put away, or from beside, the side of its face, whichever
 * of those no one else's tag is over; going round anyone else's head on the
 * way.
 */
export function stack(columns: Column[], screen?: Screen, gap = GAP_PX): Map<string, Stacked> {
  const out = new Map<string, Stacked>();
  const tags: Box[] = [];
  const tagOf = new Map<string, Box>();
  const crowd = crowdsOf(columns, gap);
  // A speaker's tag first, then by rank. Ties go the same way every frame, so nothing swaps places for no reason.
  const byRank = [...columns].sort(
    (a, b) => Number(!!b.bubble) - Number(!!a.bubble) || b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const c of byRank) {
    const [w, h] = c.tag ?? [0, 0];
    // A sign shows over a tag only while there is no bubble, and needs its room too.
    const sign = c.sign && !c.bubble ? c.sign + gap : 0;
    const base = c.y - gap;
    const way = c.tag || sign ? makeWay(c.x, base, w, h + sign, tags, gap, screen) : { up: 0, across: 0 };
    const faded = !!c.tag && !c.focus && !c.bubble && crowd.has(c.id);
    // Faint, with no sign to show, and going a column high to make way: put away, keeping no room from the others.
    const away = faded && !sign && way.up > CROWD_LIFT * (h + gap);
    if ((c.tag || sign) && !away) {
      const at = box(c.x + way.across, base - way.up, w, h + sign);
      tags.push(at);
      tagOf.set(c.id, at);
    }
    const tagTop = gap + way.up + h;
    out.set(c.id, {
      tag: gap + way.up,
      tagAcross: way.across,
      sign: c.tag ? tagTop + gap : gap + way.up,
      bubble: (c.tag ? tagTop + gap : gap) + TAIL_PX,
      across: 0,
      faded,
      hidden: away,
      gone: false,
    });
  }
  const placed: Box[] = [];
  // Where each bubble sat once they were stacked, before any was brought back on the screen.
  const sat = new Map<string, Box>();
  // Those that went up over a newer bubble, rather than only over tags.
  const overNewer = new Set<string>();
  const bySaid = columns.filter((c) => c.bubble).sort((a, b) => (b.said ?? 0) - (a.said ?? 0));
  for (const c of bySaid) {
    const [w, h] = c.bubble as [number, number];
    const at = out.get(c.id) as Stacked;
    const base = c.y - at.bubble;
    const others = tags.filter((t) => t !== tagOf.get(c.id));
    const up = clearOf(c.x, base, w, h, [...others, ...placed], gap);
    if (up > clearOf(c.x, base, w, h, others, gap) + 1e-6) overNewer.add(c.id);
    const b = box(c.x, base - up, w, h);
    placed.push(b);
    sat.set(c.id, b);
    at.bubble += up;
  }
  // Each bubble where it ends up, for the tails and the tags it came down over.
  let final = new Map<string, Box>(sat);
  if (screen) {
    // Brought on to the screen; and while that pushes a newer bubble off its speaker (beside its head, or over a
    // tag), the oldest one that went up over newer ones and has no room left above them gives way, and it is done
    // again without it. A conversation that fits reads whole.
    const stacked = new Map(bySaid.map((c) => [c.id, (out.get(c.id) as Stacked).bubble]));
    const yielding = [...bySaid]
      .reverse()
      .filter((c) => overNewer.has(c.id))
      .filter((c) => {
        const was = sat.get(c.id) as Box;
        return was.top < ceilingOver(screen, was.left, was.right);
      });
    // How recently each was said: 0 the newest.
    const order = new Map(bySaid.map((c, i) => [c.id, i]));
    const gone = new Set<string>();
    for (;;) {
      for (const c of bySaid) {
        const at = out.get(c.id) as Stacked;
        at.bubble = stacked.get(c.id) as number;
        at.across = 0;
        at.gone = gone.has(c.id);
      }
      const laid = onScreen(bySaid, gone, out, sat, tagOf, columns, screen, gap);
      final = laid.boxes;
      let next = laid.pushed ? yielding.find((c) => !gone.has(c.id))?.id : undefined;
      // One with nowhere beside its speaker to go: the earliest of the bubbles before it in its way gives way, or,
      // with none in its way, it does, unless it is the newest there is.
      const stuck = laid.stuck[0];
      if (next === undefined && stuck) {
        const before = (id: string) => (order.get(id) ?? 0) > (order.get(stuck.id) ?? 0);
        next =
          [...bySaid].reverse().find((c) => !gone.has(c.id) && before(c.id) && stuck.blockers.includes(c.id))?.id ??
          (bySaid.find((c) => !gone.has(c.id))?.id !== stuck.id ? stuck.id : undefined);
      }
      if (next === undefined) break;
      gone.add(next);
    }
    // A tag a bubble had to come down over is put away until the bubble goes.
    for (const [id, t] of tagOf)
      for (const b of final.values()) if (overlapArea(t, b) > 0) (out.get(id) as Stacked).hidden = true;
  }
  // The tails, last, from where the bubbles ended up.
  const heads = new Map(columns.map((c) => [c.id, headOf(c)]));
  const shownTags = (but: string) =>
    [...tagOf].filter(([id]) => id !== but && !(out.get(id) as Stacked).hidden).map(([, t]) => t);
  for (const c of bySaid) {
    const at = out.get(c.id) as Stacked;
    const b = final.get(c.id);
    if (!b) continue;
    const own = tagOf.get(c.id);
    // Its tag, while it shows and can be seen.
    const tag = own && !at.hidden && !(screen?.covered ?? []).some((k) => overlapArea(own, k) > 0) ? own : undefined;
    const others = shownTags(c.id);
    const theirHeads = columns.filter((o) => o.id !== c.id).map((o) => heads.get(o.id) as Box);
    // Somewhere no one else's tag is over, nor, where it can be helped, their head.
    const pick = (points: [number, number][]) =>
      points.find((p) => !others.some((k) => inside(p, k)) && !theirHeads.some((k) => inside(p, k))) ??
      points.find((p) => !others.some((k) => inside(p, k))) ??
      points[0];
    const mid = (b.left + b.right) / 2;
    const side = mid > c.x ? 1 : -1;
    const chest: [number, number] = [faceOf(c, side)[0], c.y + 3 * FACE[1] * halfOf(c)];
    // Over its tag, the top of it: the middle, or nearer an end where someone's head is behind the middle. Just under
    // it, the bubble is on it already, and needs no tail. Otherwise, over its head, the top of it, and from beside,
    // the side of its face, or the next of those, or its chest.
    let to: [number, number];
    let toTag = false;
    if (tag && b.bottom <= tag.top + 1) {
      const along = (f: number): [number, number] => [
        tag.left + TAIL_INSET + f * (tag.right - tag.left - 2 * TAIL_INSET),
        tag.top,
      ];
      const ends = [along(0.25), along(0.75)].sort((p, q) => Math.abs(p[0] - mid) - Math.abs(q[0] - mid));
      to = pick([[(tag.left + tag.right) / 2, tag.top], ...ends]);
      toTag = true;
    } else if (tag && b.top >= tag.bottom - 1 && b.top <= tag.bottom + gap + 1 && b.left <= c.x && c.x <= b.right) {
      to = [Math.min(b.right, Math.max(b.left, (tag.left + tag.right) / 2)), tag.bottom];
      toTag = true;
    } else to = pick(b.bottom <= c.y ? [[c.x, c.y], faceOf(c, side), chest] : [faceOf(c, side), chest, [c.x, c.y]]);
    // Over someone else's head or tag, a tail would look like it pointed at them.
    const around = columns
      .filter((o) => o.id !== c.id)
      .flatMap((o) => {
        const t = tagOf.get(o.id);
        return [heads.get(o.id) as Box, ...(t && !(out.get(o.id) as Stacked).hidden ? [t] : [])];
      });
    const from = tailFrom(b, to, around);
    if (from)
      at.tail = { from: [from[0] - (b.left + b.right) / 2, b.bottom - from[1]], to: [to[0] - c.x, c.y - to[1]], toTag };
  }
  return out;
}

/** Whether a point is inside a box, not just on its edge. */
const inside = ([x, y]: [number, number], k: Box) => x > k.left && x < k.right && y > k.top && y < k.bottom;

/** A box on the screen, and whose it is. */
type Placed = Box & { id: string };

/**
 * Bring the bubbles on to the screen (see `stack`), all but those that give
 * way (`gone`): oldest first, so each comes down only as far as it must, and
 * the newer ones under it make way in turn. Where each ended up; whether any
 * had to go off its speaker for it, beside its head or over a speaker's tag;
 * and those with nowhere beside their speaker to go either (`stuck`), oldest
 * first, with whose bubbles and tags were in the way.
 */
function onScreen(
  bySaid: Column[],
  gone: Set<string>,
  out: Map<string, Stacked>,
  sat: Map<string, Box>,
  tagOf: Map<string, Box>,
  columns: Column[],
  screen: Screen,
  gap: number,
): { boxes: Map<string, Box>; pushed: boolean; stuck: { id: string; blockers: string[] }[] } {
  const boxes = new Map<string, Box>();
  const kept: Placed[] = [];
  const stuck: { id: string; blockers: string[] }[] = [];
  let pushed = false;
  for (const c of [...bySaid].reverse()) {
    if (gone.has(c.id)) continue;
    const [w, h] = c.bubble as [number, number];
    const at = out.get(c.id) as Stacked;
    // Off a side: across, the left edge winning when it is wider than the room there is. As far as it takes, even
    // past its speaker, near an edge or off it: its tail leans over to point back at them.
    const left = c.x - w / 2;
    const right = c.x + w / 2;
    if (right > screen.right - EDGE_PX) at.across = screen.right - EDGE_PX - right;
    if (left + at.across < screen.left + EDGE_PX) at.across = screen.left + EDGE_PX - left;
    const l = left + at.across;
    const r = right + at.across;
    const beside = (k: Box) => k.left < r + gap && l - gap < k.right;
    // Under a phone's chat: up, so what is said there can be read above it.
    if (screen.bottom !== undefined && c.y - at.bubble > screen.bottom - EDGE_PX)
      at.bubble = c.y - (screen.bottom - EDGE_PX);
    // The highest its top may go: the top of the stage, the foot of any control over it, and below an earlier
    // bubble that sat above it, so the conversation still reads from the top down.
    const was = sat.get(c.id) as Box;
    let floor = ceilingOver(screen, l, r);
    for (const k of kept)
      if (beside(k) && (sat.get(k.id) as Box).top < was.top) floor = Math.max(floor, k.bottom + gap);
    let top = Math.max(c.y - at.bubble - h, floor);
    // An earlier one lower down, said nearer the camera, it would now cover: on down past it.
    for (let hit = kept.find((k) => beside(k) && k.top < top + h + gap && top < k.bottom + gap); hit; ) {
      top = hit.bottom + gap;
      hit = kept.find((k) => beside(k) && k.top < top + h + gap && top < k.bottom + gap);
    }
    let b: Box = { left: l, right: r, top, bottom: top + h };
    // Down on its own speaker's tag, which is there to be read, or its head, or on another speaker's tag: beside
    // its own speaker instead. A tag under a control is no help to read, and is passed over.
    const own = tagOf.get(c.id);
    const readable = own && !(screen.covered ?? []).some((k) => overlapArea(own, k) > 0);
    const speakers = bySaid
      .filter((o) => o.id !== c.id && !gone.has(o.id))
      .flatMap((o): Placed[] => {
        const t = tagOf.get(o.id);
        return t ? [{ id: o.id, ...t }] : [];
      });
    if (b.bottom > (readable ? own.top : c.y - TAIL_PX) || speakers.some((t) => overlapArea(b, t) > 0)) {
      pushed = true;
      const moved = besideHead(c, w, h, screen, [...kept, ...speakers], columns, tagOf, gap);
      if (moved.b) b = moved.b;
      else stuck.push({ id: c.id, blockers: moved.blockers });
    }
    at.across = (b.left + b.right) / 2 - c.x;
    at.bubble = c.y - b.bottom;
    kept.push({ id: c.id, ...b });
    boxes.set(c.id, b);
  }
  return { boxes, pushed, stuck };
}

/** The highest a bubble from `l` to `r` may reach on the screen: the top of the stage, or the foot of a control over it. */
function ceilingOver(screen: Screen, l: number, r: number): number {
  let ceiling = screen.top + EDGE_PX;
  for (const k of screen.covered ?? []) if (k.left < r && l < k.right) ceiling = Math.max(ceiling, k.bottom + EDGE_PX);
  return ceiling;
}

/**
 * Somewhere beside its speaker for a bubble brought down so far that it
 * would sit on its own speaker (see `stack`): level with its face, a tail
 * that can be seen out from it, and just under its tag; or out past its tag, level
 * with the top of its head; or, failing both, just under its own tag, over
 * its own body, where it plainly belongs with no tail at all. Each on the
 * screen and under the controls over it, never over its own tag, and clear
 * of the other bubbles and the speakers' tags (`keepOff`), going further out
 * past what it meets, by no more than its own width, to be. Of those, the
 * one that covers least of anyone else's head, body or tag, and is nearest
 * its speaker; the side toward the middle of the stage when two are as
 * good. None when nowhere is clear, with whose bubbles and tags were in the
 * way.
 */
function besideHead(
  c: Column,
  w: number,
  h: number,
  screen: Screen,
  keepOff: Placed[],
  columns: Column[],
  tagOf: Map<string, Box>,
  gap: number,
): { b?: Box; blockers: string[] } {
  const own = tagOf.get(c.id);
  const others = columns.filter((o) => o.id !== c.id);
  const lowest = (screen.bottom ?? Number.POSITIVE_INFINITY) - EDGE_PX - h;
  const blockers = new Set<string>();
  let best: { b: Box; cost: number } | undefined;
  // With its left edge at `from`, or further out to the `side` (0 for nowhere further), and its top at `top`, or as
  // near as the screen allows; `cost` for how far it is from its speaker already.
  const tryAt = (from: number, top: number, side: number, cost: number) => {
    let left = side ? from : Math.min(screen.right - EDGE_PX - w, Math.max(screen.left + EDGE_PX, from));
    for (;;) {
      const right = left + w;
      if (left < screen.left + EDGE_PX - 1e-6 || right > screen.right - EDGE_PX + 1e-6) return;
      const y = Math.min(lowest, Math.max(ceilingOver(screen, left, right), top));
      const b = { left, right, top: y, bottom: y + h };
      if (own && overlaps(b, own, gap - 1e-6)) return;
      const hit = keepOff.filter((k) => overlaps(b, k, gap));
      if (!hit.length) {
        let covers = cost + (Math.abs(left - from) * h) / 2;
        for (const o of others) {
          covers += overlapArea(b, headOf(o));
          if (o.body) covers += overlapArea(b, o.body);
          const t = tagOf.get(o.id);
          if (t) covers += overlapArea(b, t) / 2;
        }
        if (!side && c.body) covers += overlapArea(b, c.body);
        // A tail from beside across someone else's head or tag would look like it pointed at them.
        if (side) {
          const face = faceOf(c, side);
          const root: [number, number] = [
            side > 0 ? b.left : b.right,
            Math.min(b.bottom - TAIL_INSET, Math.max(b.top + TAIL_INSET, face[1])),
          ];
          const across = others.flatMap((o) => [headOf(o), ...(tagOf.has(o.id) ? [tagOf.get(o.id) as Box] : [])]);
          if (across.some((k) => crosses(root, face, k))) covers += (w * h) / 2;
        }
        if (!best || covers < best.cost - 1e-6) best = { b, cost: covers };
        return;
      }
      for (const k of hit) blockers.add(k.id);
      if (!side) return;
      // Further out, just past what it met.
      left =
        side > 0
          ? Math.max(...hit.map((k) => k.right + gap + 1e-6))
          : Math.min(...hit.map((k) => k.left - gap - 1e-6)) - w;
      if (Math.abs(left - from) > w) return;
    }
  };
  const middle = (screen.left + screen.right) / 2;
  for (const side of c.x > middle ? [-1, 1] : [1, -1]) {
    // Level with its face, just under its tag, far enough out for a tail that can be seen to point at it.
    const near = c.x + side * (FACE[0] * halfOf(c) + 2 * TAIL_PX);
    tryAt(
      side > 0 ? near : near - w,
      Math.max(c.y - h / 2, own ? own.bottom + gap : Number.NEGATIVE_INFINITY),
      side,
      0,
    );
    // Out past its tag, level with the top of its head.
    if (own) {
      const past = side > 0 ? own.right + TAIL_PX : own.left - TAIL_PX;
      tryAt(side > 0 ? past : past - w, c.y - h / 2, side, (Math.abs(past - near) * h) / 2);
    }
  }
  // Just under its tag, over its own body.
  if (own) tryAt((own.left + own.right) / 2 - w / 2, own.bottom + gap, 0, 0);
  const found = best as { b: Box } | undefined;
  return { ...(found ? { b: found.b } : {}), blockers: [...blockers] };
}

/** How a pointer is drawn: its length, the turn it is drawn at, and the point of it that stands on the top of the head. */
export interface Pointing {
  /** Its length on the screen, in CSS pixels. */
  length: number;
  /** How far it is turned anticlockwise from pointing straight down, in radians. */
  turn: number;
  /** Where the top of the head is on it, as a share of its width and length from its tip: a sprite's `center`. */
  center: [number, number];
}

/**
 * A pointer drawn from `from` toward `to`, stopping `gap` short of it, for a
 * sprite that stands on the top of a head and is `width` pixels wide: a
 * bubble's tail, from the bubble to its speaker's tag, or the line from a tag
 * that made way back down to its head. Both points are in CSS pixels from the
 * top of the head, to the right and up. Drawn upright, its tip is at its foot;
 * a sprite turns about the point it stands on, so that point is put where the
 * top of the head is, wherever the tip is. None when the two are too close for
 * anything to show.
 */
export function pointer(
  from: [number, number],
  to: [number, number],
  gap: number,
  width: number,
): Pointing | undefined {
  const dx = from[0] - to[0];
  const dy = from[1] - to[1];
  const far = Math.hypot(dx, dy);
  const length = far - gap;
  if (length < 1) return undefined;
  const [ux, uy] = [dx / far, dy / far];
  // Upright, it runs from its tip up; turned this far anticlockwise, it runs toward `from`.
  const turn = Math.atan2(-ux, uy) || 0;
  // The top of the head, from the tip, turned back into the pointer's own frame.
  const [ax, ay] = [-(to[0] + gap * ux), -(to[1] + gap * uy)];
  const [c, s] = [Math.cos(-turn), Math.sin(-turn)];
  const [lx, ly] = [c * ax - s * ay, s * ax + c * ay];
  return { length, turn, center: [0.5 + lx / Math.max(1e-6, width), ly / length] };
}

/** How quickly something put somewhere new gets there, in seconds: quick, but never a jump. */
export const SETTLE_SECONDS = 0.15;
