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
  /** The tail points at its speaker's tag, on its head; otherwise, with the tag put away, at the top of its head. */
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
  /** Its tag is put away for now: a bubble brought back on to the screen had to come down over it. */
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
 * above it. Where two bodies stand close, the tags meet first: the higher
 * ranked keeps its place, and the other goes just clear of it, up or across,
 * whichever is less of a move, still mostly over its own body, like the names
 * on a crowded map. One that went further than `LEADER_PX` has a line down
 * to its head, drawn by the body. Where three or more tags would meet, they
 * are a crowd: the ones that aren't to read (`Column.focus`) are drawn faint.
 * Then the bubbles, newest first: the newest sits over its speaker's tag, and
 * each earlier one goes up above whatever it would cover, so a conversation
 * reads from the top down, like a comic. A bubble never covers a tag either.
 * Then bubbles that would run off what can be seen of the stage (`screen`),
 * or under a control laid over it, are brought back inside it: across
 * rather than under a panel at the side or off an edge, however far, up rather than under a phone's
 * chat, and down rather than off the top, the newer ones under them coming
 * down too, so the conversation still reads in order. A bubble that sat
 * above another stays above it; one lower down the screen, nearer the camera,
 * is passed only when one would now cover the other. In a crowd, one that
 * went up over newer ones and has no room left above them gives way to them
 * (`Stacked.gone`). One brought down so far that it would sit on its own
 * speaker's tag, or its head, or on another speaker's tag, goes beside its
 * speaker's head instead, on whichever side covers least of anyone else's
 * body. A tag a bubble had to
 * come down over is put away until the bubble goes. Last, each bubble's tail
 * (`tailFrom`), pointing at its speaker's tag, or its head once its tag is put
 * away, and going round anyone else's head on the way.
 */
export function stack(columns: Column[], screen?: Screen, gap = GAP_PX): Map<string, Stacked> {
  const out = new Map<string, Stacked>();
  const tags: Box[] = [];
  const tagOf = new Map<string, Box>();
  const crowd = crowdsOf(columns, gap);
  // Ties go the same way every frame, so nothing swaps places for no reason.
  const byRank = [...columns].sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of byRank) {
    const [w, h] = c.tag ?? [0, 0];
    // A sign shows over a tag only while there is no bubble, and needs its room too.
    const sign = c.sign && !c.bubble ? c.sign + gap : 0;
    const base = c.y - gap;
    const way = c.tag || sign ? makeWay(c.x, base, w, h + sign, tags, gap, screen) : { up: 0, across: 0 };
    if (c.tag || sign) {
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
      faded: !!c.tag && !c.focus && crowd.has(c.id),
      hidden: false,
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
      const next = yielding.find((c) => !gone.has(c.id));
      if (!laid.pushed || !next) break;
      gone.add(next.id);
    }
    // A tag a bubble had to come down over is put away until the bubble goes.
    for (const [id, t] of tagOf)
      for (const b of final.values()) if (overlapArea(t, b) > 0) (out.get(id) as Stacked).hidden = true;
  }
  // The tails, last, from where the bubbles ended up.
  const heads = new Map(columns.map((c) => [c.id, headOf(c)]));
  for (const c of bySaid) {
    const at = out.get(c.id) as Stacked;
    const b = final.get(c.id);
    if (!b) continue;
    const own = tagOf.get(c.id);
    // At its speaker's tag while it shows and can be seen; otherwise at the top of its head.
    const toTag = !!c.tag && !!own && !at.hidden && !(screen?.covered ?? []).some((k) => overlapArea(own, k) > 0);
    const to: [number, number] = toTag && own ? [c.x + at.tagAcross, own.top] : [c.x, c.y];
    // Over someone else's head or tag, a tail would look like it pointed at them.
    const others = columns
      .filter((o) => o.id !== c.id)
      .flatMap((o) => {
        const t = tagOf.get(o.id);
        return [heads.get(o.id) as Box, ...(t && !(out.get(o.id) as Stacked).hidden ? [t] : [])];
      });
    const from = tailFrom(b, to, others);
    if (from) at.tail = { from: [from[0] - (b.left + b.right) / 2, b.bottom - from[1]], toTag };
  }
  return out;
}

/**
 * Bring the bubbles on to the screen (see `stack`), all but those that give
 * way (`gone`): oldest first, so each comes down only as far as it must, and
 * the newer ones under it make way in turn. Where each ended up, and whether
 * any had to go off its speaker for it: beside its head, or over a speaker's
 * tag.
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
): { boxes: Map<string, Box>; pushed: boolean } {
  const boxes = new Map<string, Box>();
  const kept: (Box & { id: string })[] = [];
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
    // its own speaker's head instead, if there is a side to go to. A tag under a control is no help to read, and is
    // passed over.
    const own = tagOf.get(c.id);
    const readable = own && !(screen.covered ?? []).some((k) => overlapArea(own, k) > 0);
    const speakers = bySaid.filter((o) => o.id !== c.id && !gone.has(o.id)).flatMap((o) => tagOf.get(o.id) ?? []);
    if (b.bottom > (readable ? own.top + 1 : c.y - TAIL_PX) || speakers.some((t) => overlapArea(b, t) > 0)) {
      pushed = true;
      const moved = besideHead(c, w, h, screen, [...kept, ...speakers], columns, tagOf, gap);
      if (moved) b = moved;
    }
    at.across = (b.left + b.right) / 2 - c.x;
    at.bubble = c.y - b.bottom;
    kept.push({ id: c.id, ...b });
    boxes.set(c.id, b);
  }
  return { boxes, pushed };
}

/** The highest a bubble from `l` to `r` may reach on the screen: the top of the stage, or the foot of a control over it. */
function ceilingOver(screen: Screen, l: number, r: number): number {
  let ceiling = screen.top + EDGE_PX;
  for (const k of screen.covered ?? []) if (k.left < r && l < k.right) ceiling = Math.max(ceiling, k.bottom + EDGE_PX);
  return ceiling;
}

/**
 * A bubble beside its speaker's head, for one that had to come down so far
 * that it would sit on its own speaker: level with the head, or as near as
 * the controls over the stage allow, on whichever side keeps on the screen,
 * clear of the other bubbles and the speakers' tags (`keepOff`), and covers
 * least of anyone else's body or tag,
 * the side toward the middle of the stage when both are as good. None when
 * neither side has room.
 */
function besideHead(
  c: Column,
  w: number,
  h: number,
  screen: Screen,
  keepOff: Box[],
  columns: Column[],
  tagOf: Map<string, Box>,
  gap: number,
): Box | undefined {
  // Clear of its own body, and of its own tag, which stays to be read.
  const own = tagOf.get(c.id);
  const half = Math.max(
    c.body ? Math.max(c.x - c.body.left, c.body.right - c.x) : HEAD_HALF_PX,
    own ? Math.max(c.x - own.left, own.right - c.x) - TAIL_PX + gap : 0,
  );
  const middle = (screen.left + screen.right) / 2;
  const others = columns.filter((o) => o.id !== c.id);
  let best: { b: Box; cost: number } | undefined;
  for (const side of c.x > middle ? [-1, 1] : [1, -1]) {
    const left = side > 0 ? c.x + half + TAIL_PX : c.x - half - TAIL_PX - w;
    const right = left + w;
    if (left < screen.left + EDGE_PX || right > screen.right - EDGE_PX) continue;
    const lowest = (screen.bottom ?? Number.POSITIVE_INFINITY) - EDGE_PX - h;
    const top = Math.min(lowest, Math.max(ceilingOver(screen, left, right), c.y - h / 2));
    const b = { left, right, top, bottom: top + h };
    if (keepOff.some((k) => overlaps(b, k, gap))) continue;
    let cost = 0;
    for (const o of others) {
      if (o.body) cost += overlapArea(b, o.body);
      const t = tagOf.get(o.id);
      if (t) cost += overlapArea(b, t) / 2;
    }
    if (!best || cost < best.cost - 1e-6) best = { b, cost };
  }
  return best?.b;
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
