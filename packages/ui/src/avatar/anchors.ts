/**
 * Panels in the world: an agent's card by its shoulder, a task's card pinned
 * beside the board it is on, the room's card on the plaque by its door, the
 * map held in front of you, a conversation beside whoever you talk to. Each
 * is real HTML laid over the stage, kept beside the thing it is about as the
 * camera and the thing move. Here is what can be worked out without a page,
 * so it is tested: what each panel is beside, where on the stage it goes so
 * it covers neither that thing nor any other panel and stays on the screen,
 * how it follows without jitter, where the plaque hangs, and when you have
 * walked away from what a panel is about. The stage works out where things
 * are on the screen each frame, and puts each panel where this says.
 */
import type { Box } from "./overhead";
import type { Room, RoomDoor } from "./scene";

/**
 * What a panel is beside: an agent's body (its card, what it waits on, your
 * talk with it), a thing in the room by id (a board, a kiosk, a screen), the
 * room's plaque by its door, your own body (a phone in your hand), or nothing
 * in particular: held in front of you (the map), or docked at the side of what
 * can be seen (the catalogue while you rearrange).
 */
export type Anchor =
  | { agent: string }
  | { thing: string }
  | { plaque: true }
  | { you: true }
  | { held: "front" | "dock" };

/** Which side of what it is about a panel went, or how it is held; on a narrow stage, a sheet at the foot, or put away. */
export type Side = "right" | "left" | "above" | "below" | "front" | "dock" | "sheet" | "away";

/** Where a panel goes on the stage, in CSS pixels from its top left, and where along its edge its tail points. */
export interface Placed {
  x: number;
  y: number;
  side: Side;
  /** Pixels along the edge facing what it is about (down a side, across the top or foot) its tail meets that edge. */
  tail: number;
}

/** Pixels between a panel and what it is beside: room for its tail. */
export const GAP = 16;
/** Pixels a panel keeps from the edges of what can be seen. */
export const EDGE = 12;
/** A stage narrower than this has no room beside anything: panels are sheets over its foot, one at a time. */
export const SHEET_BELOW = 600;
/**
 * Pixels the camera keeps clear on the right for a panel while one is open
 * on a wide stage: the scene is framed in what is left, so whatever a panel
 * is beside has room next to it.
 */
export const PANEL_ROOM = 360;
/** The nearest a tail comes to a panel's corner, in pixels: past its rounded edge. */
const TAIL_INSET = 20;
/** Pixels clear of the other panels a panel moved aside has to have before it goes back beside its thing. */
const HOLD_PX = 32;

/** A panel to place: how big it is, and what it is beside, as the stage sees it this frame. */
export interface PanelIn {
  id: string;
  /** Its size in CSS pixels. */
  size: [number, number];
  /**
   * What it is beside, on the stage: the whole of it (a body, head to foot),
   * and the part it must never cover (a face; the thing itself). None when it
   * is held, or what it is beside is off the screen.
   */
  target?: { box: Box; keep: Box };
  /** How it is held without anything to be beside. */
  held?: "front" | "dock";
  /** The side it goes when either has room: toward the side of the stage with more of it to spare, by default. */
  prefer?: "right" | "left";
  /** Placed before the rest, which keep out of its way; on a narrow stage, the one sheet shown. */
  rank: number;
  /** Rather docked at the side, or put away, than laid over another panel: your conversation, while a card is open. */
  optional?: boolean;
  /** How it went last frame, so one moved aside for another panel doesn't hop back and forth at the edge of it. */
  was?: Side;
}

/** How much of one box covers another, in square pixels. */
function overlap(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/** How much of a box is outside another, in square pixels. */
function outside(a: Box, view: Box): number {
  return (a.right - a.left) * (a.bottom - a.top) - overlap(a, view);
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, Math.max(lo, hi)));

/** A box `size` big with its top left at `x`, `y`. */
const boxAt = (x: number, y: number, [w, h]: [number, number]): Box => ({
  left: x,
  top: y,
  right: x + w,
  bottom: y + h,
});

/** Whether any of a box is in another. */
export function inView(box: Box, view: Box): boolean {
  return box.right > view.left && box.left < view.right && box.bottom > view.top && box.top < view.bottom;
}

/** The smallest box round some points on the screen. */
export function boxRound(points: [number, number][]): Box | undefined {
  if (!points.length) return undefined;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/**
 * The places beside a target a panel could go, in the order tried: the side
 * it prefers, the other, then above and below. Beside it, a panel's top sits
 * a little above the part it must not cover, so its tail points at a
 * shoulder, or the middle of a thing, and it reads down from there. Each side
 * is tried as it is, and pushed back onto the screen: off the edge or over
 * the thing it is beside, whichever is less bad, wins.
 */
function candidates(p: PanelIn, view: Box): { box: Box; side: Side }[] {
  const t = p.target as NonNullable<PanelIn["target"]>;
  const [w, h] = p.size;
  const room = {
    right: view.right - Math.max(t.box.right, t.keep.right),
    left: Math.min(t.box.left, t.keep.left) - view.left,
  };
  const first = p.prefer ?? (room.right >= room.left ? "right" : "left");
  const aim = Math.min(t.keep.bottom, (t.box.top + t.box.bottom) / 2);
  const top = clamp(aim - Math.min(56, h / 3), view.top, view.bottom - h);
  const middle = clamp((t.box.left + t.box.right) / 2 - w / 2, view.left, view.right - w);
  // Beside the whole of it: what it must not cover can be wider than it is, like a long name over a body.
  const right = Math.max(t.box.right, t.keep.right);
  const left = Math.min(t.box.left, t.keep.left);
  const at: Record<"right" | "left" | "above" | "below", [number, number]> = {
    right: [right + GAP, top],
    left: [left - GAP - w, top],
    above: [middle, Math.min(t.box.top, t.keep.top) - GAP - h],
    below: [middle, t.box.bottom + GAP],
  };
  const order: ("right" | "left" | "above" | "below")[] =
    first === "right" ? ["right", "left", "above", "below"] : ["left", "right", "above", "below"];
  return order.flatMap((side) => {
    const [x, y] = at[side];
    const kept = boxAt(clamp(x, view.left, view.right - w), clamp(y, view.top, view.bottom - h), p.size);
    return [
      { box: boxAt(x, y, p.size), side },
      { box: kept, side },
    ];
  });
}

/**
 * Weights for what a panel lands on, a square pixel at a time: never on a
 * face or the thing itself, the controls over the stage or your own head,
 * nor cut off by the edge of the stage; then not over another panel; then
 * not over the rest of a body, or the names and bubbles over heads, if it
 * can help it.
 */
const COST = { keep: 60, target: 3, outside: 40, panel: 8, avoid: 2 };

/** How bad a place is for a panel: what it covers, and how much of it is off the screen. */
function cost(box: Box, p: PanelIn, view: Box, panels: Box[], avoid: Box[], clear: Box[] = []): number {
  let c = outside(box, view) * COST.outside;
  if (p.target) c += overlap(box, p.target.keep) * COST.keep + overlap(box, p.target.box) * COST.target;
  for (const b of panels) c += overlap(box, b) * COST.panel;
  for (const b of avoid) c += overlap(box, b) * COST.avoid;
  // A button under a panel can't be pressed, and you lose yourself under one: these count as much as a face.
  for (const b of clear) c += overlap(box, b) * COST.keep;
  return c;
}

/** Where along a panel's edge its tail meets it, to point at the middle of what it is beside's part to keep. */
function tailFor(box: Box, side: Side, p: PanelIn): number {
  const t = p.target;
  if (!t) return 0;
  const vertical = side === "left" || side === "right";
  const aim = vertical ? Math.min(t.keep.bottom, (t.box.top + t.box.bottom) / 2) : (t.keep.left + t.keep.right) / 2;
  const along = vertical ? aim - box.top : aim - box.left;
  const length = vertical ? box.bottom - box.top : box.right - box.left;
  return Math.round(clamp(along, TAIL_INSET, length - TAIL_INSET));
}

/**
 * A held panel's place. Docked, in the right corner of the foot of what can
 * be seen, above anything open there already. In front of you, in the middle
 * and a little low, as a map is held; or, where that would cover someone's
 * face (`avoid`) or another panel, as near the middle as misses them: higher,
 * or to one side.
 */
function heldBox(p: PanelIn, view: Box, panels: Box[], avoid: Box[], clear: Box[] = []): Box {
  const [w, h] = p.size;
  if (p.held === "dock") {
    let y = view.bottom - h;
    // Docked under something open already: up above it, rather than over it.
    for (const b of [...panels].sort((a, c) => c.top - a.top))
      if (overlap(boxAt(view.right - w, y, p.size), b) > 0) y = b.top - GAP - h;
    return boxAt(view.right - w, clamp(y, view.top, view.bottom - h), p.size);
  }
  const at = (across: number, down: number) =>
    boxAt(
      clamp(view.left + (view.right - view.left - w) * across, view.left, view.right - w),
      clamp(view.top + (view.bottom - view.top - h) * down, view.top, view.bottom - h),
      p.size,
    );
  let best: { box: Box; cost: number } | undefined;
  for (const box of [at(0.5, 0.55), at(0.5, 0.15), at(0.5, 0.95), at(0.12, 0.5), at(0.88, 0.5)]) {
    const k = cost(box, p, view, panels, avoid, clear);
    if (!best || k < best.cost) best = { box, cost: k };
    if (k === 0) break;
  }
  return (best as { box: Box }).box;
}

/**
 * Where every panel goes this frame: each beside what it is about, on the
 * side with room, never over the face of an agent or the thing it is about,
 * kept on the screen (`view`), never over what must stay clear (`clear`: the
 * controls laid over the stage, your own head), and off the faces, names and
 * bubbles there (`avoid`) where it can be; and out of each other's way, the
 * higher ranked placed first. A
 * panel with nothing to be beside is held: in front of you, or docked at the
 * side. One that is optional and could only go over another panel is
 * docked at the side instead, or put away when that is taken too; it goes
 * back beside its thing only once that is clear by a margin, so it never
 * hops to and fro. On a stage narrower than `SHEET_BELOW`, the highest
 * ranked is a sheet over the stage's foot and the rest are put away.
 */
export function layoutPanels(
  panels: PanelIn[],
  view: Box,
  avoid: Box[] = [],
  stageWidth = Number.POSITIVE_INFINITY,
  clear: Box[] = [],
): Map<string, Placed> {
  const out = new Map<string, Placed>();
  // Ties go the same way every frame, so nothing swaps places for no reason.
  const order = [...panels].sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (stageWidth < SHEET_BELOW) {
    for (const [i, p] of order.entries()) out.set(p.id, { x: 0, y: 0, side: i === 0 ? "sheet" : "away", tail: 0 });
    return out;
  }
  const placed: Box[] = [];
  for (const p of order) {
    if (!p.target) {
      const box = heldBox(p, view, placed, avoid, clear);
      if (p.optional && placed.some((b) => overlap(box, b) > 0)) {
        out.set(p.id, { x: box.left, y: box.top, side: "away", tail: 0 });
        continue;
      }
      placed.push(box);
      out.set(p.id, { x: box.left, y: box.top, side: p.held === "dock" ? "dock" : "front", tail: 0 });
      continue;
    }
    let best: { box: Box; side: Side; cost: number } | undefined;
    for (const c of candidates(p, view)) {
      const k = cost(c.box, p, view, placed, avoid, clear);
      if (!best || k < best.cost) best = { ...c, cost: k };
      if (k === 0) break;
    }
    const b = best as { box: Box; side: Side; cost: number };
    const aside = p.was === "dock" || p.was === "away" ? HOLD_PX : 0;
    const grown = (x: Box): Box => ({
      left: x.left - aside,
      right: x.right + aside,
      top: x.top - aside,
      bottom: x.bottom + aside,
    });
    if (p.optional && placed.some((x) => overlap(b.box, grown(x)) > 0)) {
      // Docked at the side rather than over a card; put away only when the side is taken too.
      const dock = heldBox({ ...p, held: "dock" }, view, placed, avoid, clear);
      if (placed.some((x) => overlap(dock, x) > 0)) out.set(p.id, { x: dock.left, y: dock.top, side: "away", tail: 0 });
      else {
        placed.push(dock);
        out.set(p.id, { x: dock.left, y: dock.top, side: "dock", tail: 0 });
      }
      continue;
    }
    placed.push(b.box);
    out.set(p.id, {
      x: Math.round(b.box.left),
      y: Math.round(b.box.top),
      side: b.side,
      tail: tailFor(b.box, b.side, p),
    });
  }
  return out;
}

/** Seconds a panel takes to catch up with what it is beside as that moves: quick, but never a jump. */
export const FOLLOW_SECONDS = 0.12;
/** Further than this in pixels, a panel goes straight to its new place: it moved to another side, or the view did. */
export const JUMP_PX = 240;

/**
 * Where a panel is this frame, on its way from where it was (`was`) to where
 * it should be: there at once the first time, on another side, or far off;
 * otherwise eased there, so a body breathing or a camera settling never
 * makes it shake. A move of under half a pixel is none.
 */
export function follow(was: Placed | undefined, next: Placed, dt: number): Placed {
  if (!was || was.side !== next.side || Math.hypot(next.x - was.x, next.y - was.y) > JUMP_PX) return next;
  const k = 1 - Math.exp(-Math.max(0, dt) / FOLLOW_SECONDS);
  const step = (a: number, b: number) => (Math.abs(b - a) < 0.5 ? b : a + (b - a) * k);
  return { ...next, x: step(was.x, next.x), y: step(was.y, next.y), tail: Math.round(step(was.tail, next.tail)) };
}

/** Metres from what a panel is about you can always walk and keep it: about the far side of a room. */
export const AWAY_AT = 4.5;
/** Metres further than you stood when it opened you can go before walking off puts it away. */
export const AWAY_MORE = 2.5;
/** Metres you have to have walked yourself: an agent walking off from you takes its card along instead. */
export const AWAY_WALKED = 1;

/**
 * Whether you have walked away from what a panel is about: now `now` metres
 * off it, having stood `from` off as it opened, and having walked `walked`
 * metres from where you stood then. Only your own walking counts: an agent
 * going off to its desk takes its card with it, beside it all the way.
 */
export function walkedAway(from: number, now: number, walked: number): boolean {
  return walked >= AWAY_WALKED && now > Math.max(AWAY_AT, from + AWAY_MORE);
}

/** What can be open over the world, by kind, as the chat page's scene keeps it. */
export type PanelKind =
  | "map"
  | "tasks"
  | "task"
  | "agent"
  | "place"
  | "new-task"
  | "new-room"
  | "needs"
  | "need"
  | "dashboard"
  | "calendar"
  | "catalogue";

/** The place on screen, as which panel is beside what needs it. */
export interface Where {
  /** Who has a body here. */
  here: ReadonlySet<string>;
  /** The things here: their ids, their kinds, and what clicking one does. */
  things: { id: string; kind: string; action?: string }[];
  /** The room has a plaque by its door. */
  plaque: boolean;
}

/** The first thing here of a kind, or that does `action`. */
const first = (where: Where, kind: string, action?: string) =>
  where.things.find((t) => (action ? t.action === action : t.kind === kind))?.id;

/**
 * What a panel is beside, in the place on screen: the thing it was opened
 * from (`at`, a board's note, a kiosk's button, a screen's page) while it is
 * still here; an agent's card and what it waits on by its body, when its
 * body is here; a task, the task list or a new task by the board (a new task
 * by the kiosk that makes them first); a new room by its kiosk; the
 * dashboard and the calendar's list by the screen and the calendar; the
 * room's card on its plaque. Anything with nowhere here to be is held in
 * front of you, as the map and the "Needs you" list always are; the
 * catalogue you rearrange from is docked at the side, out of the room's way.
 */
export function anchorFor(panel: { kind: PanelKind; agent?: string; at?: string }, where: Where): Anchor {
  const front: Anchor = { held: "front" };
  const thing = (id: string | undefined): Anchor => (id ? { thing: id } : front);
  const from = panel.at && where.things.some((t) => t.id === panel.at) ? panel.at : undefined;
  switch (panel.kind) {
    case "agent":
    case "need":
      return panel.agent && where.here.has(panel.agent) ? { agent: panel.agent } : front;
    case "task":
    case "tasks":
      return thing(from ?? first(where, "board"));
    case "new-task":
      return thing(from ?? first(where, "kiosk", "new-task") ?? first(where, "board"));
    case "new-room":
      return thing(from ?? first(where, "kiosk", "new-room"));
    case "dashboard":
      return thing(from ?? first(where, "screen"));
    case "calendar":
      return thing(from ?? first(where, "calendar"));
    case "place":
      return where.plaque ? { plaque: true } : front;
    case "catalogue":
      return { held: "dock" };
    default:
      return front;
  }
}

/**
 * Where your conversation with an agent shows: beside its body when it is
 * here, face to face; in your own hand, as a phone, when you are visiting
 * somewhere it isn't; docked at the side otherwise.
 */
export function talkAnchor(agent: string, where: Pick<Where, "here">, visiting: boolean): Anchor {
  if (where.here.has(agent)) return { agent };
  return visiting ? { you: true } : { held: "dock" };
}

/** The same anchor: the same kind, at the same thing. */
export function sameAnchor(a: Anchor, b: Anchor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** How big the room's plaque is in metres, how high its middle hangs, and how far from the middle of its door. */
export const PLAQUE = { width: 0.42, height: 0.26, elevation: 1.45, beside: 1.02 };
/** How far along the wall from the plaque anything else has to be for it to hang there: a thing, or another door. */
const PLAQUE_CLEAR = { thing: 0.72, door: 1.0, wall: 0.7 };

/**
 * Where the room's plaque hangs: on the wall beside a door in a wall (the
 * back or the left), at eye height, on whichever side of it is clear of
 * anything else on or against that wall and of the room's corner. The door
 * it is beside, where on the floor plan it is, and which way it faces, in
 * degrees as a prop's `facing`. None when every door is at an open side, or
 * has no clear wall beside it.
 */
export function plaqueSpot(
  room: Pick<Room, "width" | "depth" | "props" | "doors">,
): { door: RoomDoor; at: [number, number]; facing: number } | undefined {
  for (const door of room.doors ?? []) {
    if (door.wall !== "back" && door.wall !== "left") continue;
    const back = door.wall === "back";
    const half = back ? room.width / 2 : room.depth / 2;
    for (const side of [1, -1]) {
      const along = door.along + side * PLAQUE.beside;
      if (Math.abs(along) > half - PLAQUE.width / 2 - 0.15) continue;
      const crowded =
        room.props.some((p) => {
          if (p.kind === "rug" || p.kind === "round_rug") return false;
          const [x, z] = p.at;
          const off = back ? z + room.depth / 2 : x + room.width / 2;
          const alongIt = back ? x : z;
          return off < PLAQUE_CLEAR.wall && Math.abs(alongIt - along) < PLAQUE_CLEAR.thing;
        }) ||
        (room.doors ?? []).some(
          (d) => d !== door && d.wall === door.wall && Math.abs(d.along - along) < PLAQUE_CLEAR.door,
        );
      if (crowded) continue;
      return back
        ? { door, at: [along, -room.depth / 2], facing: 0 }
        : { door, at: [-room.width / 2, along], facing: 90 };
    }
  }
  return undefined;
}
