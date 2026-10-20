/**
 * What floats over the bodies out in the town, seen from afar. Near the
 * camera, every body's tag and sign are as they always are. Further off they
 * shrink and fade, and once a body is far, only the ones worth a glance keep
 * a tag: waiting on you or stuck, at work, talking to someone, the one under
 * the pointer, the one the chat is with, and you. The rest go quiet, and
 * bodies keeping each other company far off share one small chat mark
 * between them, rather than one each. Pointing at a body always brings its
 * name back, as it is near.
 *
 * How far off a body is is how big it is drawn: the metres a screen pixel
 * covers at its head, as the tag's own size is worked out (`overhead.ts`).
 * Zoomed out over the town, everything is far; zoomed in on the square, the
 * people round you are near again. Indoors, nothing here applies: a room is
 * never big enough for anyone in it to be far. Pure, so it is tested without
 * a GPU.
 */
import type { AgentActivity } from "./doing";
import type { Box } from "./overhead";

/** About how tall a body stands, in metres: how big one comes out on the screen. */
export const BODY_M = 1.6;
/** A body drawn at least this many pixels tall is near: what is over its head is as it always is. */
export const NEAR_PX = 40;
/** One drawn this many pixels tall or less is far: only a body worth a glance keeps its tag. */
export const FAR_PX = 22;
/** How big a far tag is drawn, against the smallest a near one is: smaller, still big enough to read. */
export const FAR_SHRINK = 0.82;
/** How strongly a far tag worth a glance is drawn: a little faint, so the near ones stand out. */
export const FAR_STRENGTH = 0.85;
/** A tag fainter than this is put away: nothing is drawn, and nothing makes way for it. */
export const AWAY = 0.04;
/** How far off a body has to be for its chat to join a shared mark. */
export const GROUP_FROM = 0.5;
/** Bodies keeping company within this many metres of each other on the ground share one chat mark. */
export const GROUP_M = 4;
/** So do two whose marks would be closer than this on the screen, in CSS pixels: one mark sat on another says nothing. */
export const GROUP_PX = 28;
/** CSS pixels on screen for each pixel of a shared chat mark's canvas: small, between 17 and 23 pixels across. */
export const MARK_PX: [number, number] = [0.13, 0.18];
/** The least a far body is to point at, in CSS pixels across and down: a body a few pixels tall is hard to find. */
export const POINT_PX = 22;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How far off a body looks, from 0 (near) to 1 (far), by `perPixel`, the
 * metres a screen pixel covers at its head: eased in between, so a tag fades
 * as the camera draws back rather than all at once.
 */
export function farness(perPixel: number): number {
  const tall = BODY_M / Math.max(1e-6, perPixel);
  const u = clamp((NEAR_PX - tall) / (NEAR_PX - FAR_PX), 0, 1);
  return u * u * (3 - 2 * u);
}

/** What makes a body worth a glance from afar. */
export interface Glance {
  /** What its agent is doing. */
  doing?: AgentActivity["doing"];
  /** It is saying something, in a bubble over its head. */
  speaking?: boolean;
  /** It is under the pointer, or the one you stand by. */
  pointed?: boolean;
  /** Its agent is the one the chat is with. */
  partner?: boolean;
  /** It is your own body. */
  you?: boolean;
}

/** Doings worth a glance from across the town: it needs you, or it is busy. Idle and asleep aren't. */
const WORTH: ReadonlySet<AgentActivity["doing"]> = new Set(["waiting", "stuck", "working", "thinking", "talking"]);

/** Whether a body far off keeps its tag: it needs you, it is busy or talking, you point at it or talk to it, or it is you. */
export function worthAGlance(g: Glance): boolean {
  return !!(g.you || g.pointed || g.partner || g.speaking || (g.doing && WORTH.has(g.doing)));
}

/** How what is over a head is drawn, seen from where the camera is. */
export interface Afar {
  /** How strongly its tag is drawn: 1 as always, down to 0, put away. */
  tag: number;
  /** How big its tag and sign are drawn, against how they are near: 1 as always. */
  size: number;
  /** How strongly its sign is drawn: 0 while it shares a chat mark with those it keeps company with. */
  sign: number;
}

/** What is over a head near the camera, and indoors: everything as it always is. */
export const NEAR: Afar = { tag: 1, size: 1, sign: 1 };

/**
 * How a body's tag and sign are drawn `far` off (`farness`): near, as
 * always; further, smaller and fainter, and a body not worth a glance
 * (`worthAGlance`) fades out altogether, its sign with it. Pointed at, it
 * is drawn as it is near, whatever the distance.
 */
export function afar(far: number, g: Glance): Afar {
  if (g.pointed || far <= 0) return NEAR;
  const k = clamp(far, 0, 1);
  const size = 1 - k * (1 - FAR_SHRINK);
  if (worthAGlance(g)) return { tag: 1 - k * (1 - FAR_STRENGTH), size, sign: 1 };
  const fade = 1 - k;
  return { tag: fade < AWAY ? 0 : fade, size, sign: fade < AWAY ? 0 : fade };
}

/** A far body keeping someone company: where it stands on the ground, and where its head is on the screen. */
export interface Chatter {
  id: string;
  /** On the ground, x and z, in metres. */
  at: [number, number];
  /** Its head on the screen, in CSS pixels across and down. */
  screen: [number, number];
}

/**
 * Far bodies keeping each other company, in the groups that share one chat
 * mark: any two within `metres` of each other on the ground (one café table,
 * a bench and the next) or `pixels` of each other on the screen are in the
 * same group, and so is anyone near either. Each group's ids in order, the
 * groups in the order of their first: the same every frame for the same
 * bodies, so a mark doesn't swap from one to another.
 */
export function chatGroups(chatters: Chatter[], metres = GROUP_M, pixels = GROUP_PX): string[][] {
  const list = [...chatters].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const group = list.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      const ground = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
      const screen = Math.hypot(a.screen[0] - b.screen[0], a.screen[1] - b.screen[1]);
      if (ground <= metres || screen <= pixels) group[Math.max(root(i), root(j))] = Math.min(root(i), root(j));
    }
  const out = new Map<number, string[]>();
  for (let i = 0; i < list.length; i++) {
    const r = root(i);
    out.set(r, [...(out.get(r) ?? []), list[i].id]);
  }
  return [...out.values()];
}

/**
 * Where a group's shared chat mark stands in the room: over the middle of
 * them on the ground, on the top of the tallest head among them, so it sits
 * over the group and under nobody's chin.
 */
export function markAt(crowns: [number, number, number][]): [number, number, number] {
  const n = Math.max(1, crowns.length);
  return [
    crowns.reduce((s, c) => s + c[0], 0) / n,
    crowns.reduce((top, c) => Math.max(top, c[1]), Number.NEGATIVE_INFINITY),
    crowns.reduce((s, c) => s + c[2], 0) / n,
  ];
}

/**
 * The far body the pointer is on, when the pointer missed every body itself:
 * each counts as at least `least` pixels across and tall round its middle,
 * so one drawn a few pixels high can still be pointed at, and the nearest
 * middle wins where two overlap. Only bodies drawn small are given in: a
 * near one is only where it is drawn.
 */
export function pointedAt(
  at: [number, number],
  bodies: { id: string; box: Box }[],
  least = POINT_PX,
): string | undefined {
  let best: string | undefined;
  let nearest = Number.POSITIVE_INFINITY;
  for (const { id, box } of bodies) {
    const middle = [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
    const half = [Math.max(least, box.right - box.left) / 2, Math.max(least, box.bottom - box.top) / 2];
    if (Math.abs(at[0] - middle[0]) > half[0] || Math.abs(at[1] - middle[1]) > half[1]) continue;
    const d = Math.hypot(at[0] - middle[0], at[1] - middle[1]);
    if (d < nearest) {
      nearest = d;
      best = id;
    }
  }
  return best;
}
