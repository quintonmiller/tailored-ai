/**
 * Rearranging a room yourself, the parts that need no GPU: where a thing you
 * drag lands (on a 10 cm grid, along a wall, or on top of something), what
 * the catalogue offers and how it is grouped, the colours to repaint with,
 * how a change reads in the room's recent changes, and the undo and redo of
 * your own changes. Whether a thing fits where you put it is the server's to
 * say, by the same checks the agents' `place` tool uses (`places-edit.ts` in
 * core), so a person can't make a room the tool would refuse. The stage drags
 * and draws by what this says; the page saves.
 */
import type { Prop, Room, RoomChange } from "./scene";

/** How far apart the points a dragged thing snaps to are, in metres. Shift drags it freely. */
export const GRID = 0.1;
/** The steps a thing turns by: a quarter turn, or a little. */
export const TURNS = { big: 90, small: 15 };

/** What a kind of thing is like, as the server's `KINDS` says: how big, and where it goes. */
export interface KindInfo {
  noun: string;
  mount: "floor" | "wall" | "on";
  /** Width (x) and depth (z) at facing 0, before scaling. */
  footprint: [number, number];
  height: number;
  /** Height above the floor, for things on a wall. */
  elevation?: number;
  /** Things can be put on it, this high above its base. */
  surface?: number;
  /** Round, so turning it takes no more room. */
  round?: boolean;
  /** Sized by `size` instead of a fixed footprint: the basic shapes. */
  shaped?: boolean;
}

export type Kinds = Record<string, KindInfo>;

/** Where a thing is put: on the floor, along a wall, or on top of `on`; `elevation` only for drawing it there. */
export interface Move {
  item: string;
  at: [number, number];
  facing: number;
  on?: string;
  elevation?: number;
  /** Dragged over nothing it could stand on: shown there, but it can't stay. */
  loose?: boolean;
}

/** A place to put a thing, as a key: the same place twice is asked about once. */
export const moveKey = (m: Move | undefined) => (m ? `${m.at[0]},${m.at[1]},${m.facing},${m.on ?? ""}` : "");

const cm = (n: number) => Math.round(n * 100) / 100;

/** A length on the grid, or to the centimetre when dragged freely. */
export function snap(v: number, free = false): number {
  return free ? cm(v) : cm(Math.round(v / GRID) * GRID);
}

/** An angle turned by `by` degrees, in (-180, 180]. */
export function turned(facing: number, by: number): number {
  let a = (((facing + by) % 360) + 360) % 360;
  if (a > 180) a -= 360;
  return cm(a);
}

/** Width and depth of a thing as placed: a shape by its size, anything else its kind's footprint, scaled. */
export function footprint(prop: Pick<Prop, "kind" | "scale" | "size">, kinds: Kinds): [number, number] {
  const kind = kinds[prop.kind];
  if (kind?.shaped && prop.size) return [prop.size[0], prop.size[2]];
  const s = prop.scale ?? 1;
  const [w, d] = kind?.footprint ?? [0.5, 0.5];
  return [w * s, d * s];
}

/** How tall a thing is as placed. */
export function heightOf(prop: Pick<Prop, "kind" | "scale" | "size">, kinds: Kinds): number {
  const kind = kinds[prop.kind];
  if (kind?.shaped && prop.size) return prop.size[1];
  return (kind?.height ?? 0.5) * (prop.scale ?? 1);
}

/**
 * Where a thing goes on the floor for a point, snapped, and kept wholly in
 * the room: `size` is its width and depth, `facing` how it is turned, so it
 * can be dragged right up against a wall but never through one.
 */
export function onFloor(
  room: Pick<Room, "width" | "depth">,
  [x, z]: [number, number],
  free = false,
  size: [number, number] = [0, 0],
  facing = 0,
): [number, number] {
  const f = (facing * Math.PI) / 180;
  // Half its width and depth as turned, across the room and from back to front.
  const hx = Math.abs((size[0] / 2) * Math.cos(f)) + Math.abs((size[1] / 2) * Math.sin(f));
  const hz = Math.abs((size[0] / 2) * Math.sin(f)) + Math.abs((size[1] / 2) * Math.cos(f));
  const keep = (v: number, half: number) => cm(Math.max(-half, Math.min(half, v)));
  return [
    keep(snap(x, free), Math.max(0, room.width / 2 - hx - 0.02)),
    keep(snap(z, free), Math.max(0, room.depth / 2 - hz - 0.02)),
  ];
}

/**
 * Where along the walls a thing hung on one goes, for a point on the floor
 * plan: on whichever of the back and left walls is nearer, this far along it,
 * kept clear of its ends, facing into the room. The front and right are open.
 */
export function onWall(
  room: Pick<Room, "width" | "depth">,
  [x, z]: [number, number],
  width: number,
  free = false,
): { wall: "back" | "left"; along: number; at: [number, number]; facing: number } {
  const wall = z + room.depth / 2 <= x + room.width / 2 ? "back" : "left";
  const span = wall === "back" ? room.width : room.depth;
  const end = Math.max(0, span / 2 - width / 2 - 0.05);
  const along = Math.max(-end, Math.min(end, snap(wall === "back" ? x : z, free)));
  const at: [number, number] =
    wall === "back" ? [along, cm(-room.depth / 2 + 0.01)] : [cm(-room.width / 2 + 0.01), along];
  return { wall, along, at, facing: wall === "back" ? 0 : 90 };
}

/** How high a thing's top is, for one that can hold others; undefined for one that can't. */
export function topOf(prop: Prop, kinds: Kinds): number | undefined {
  const kind = kinds[prop.kind];
  if (kind?.surface === undefined) return undefined;
  const top = kind.shaped && prop.size ? prop.size[1] : kind.surface * (prop.scale ?? 1);
  return cm((prop.elevation ?? 0) + top);
}

/** A point in a thing's own frame: [to its right, in front of it]. */
function local([x, z]: [number, number], [cx, cz]: [number, number], facing: number): [number, number] {
  const f = (facing * Math.PI) / 180;
  const dx = x - cx;
  const dz = z - cz;
  return [dx * Math.cos(f) - dz * Math.sin(f), dx * Math.sin(f) + dz * Math.cos(f)];
}

/** A point in a thing's own frame back on the floor plan. */
function world([lx, lz]: [number, number], [cx, cz]: [number, number], facing: number): [number, number] {
  const f = (facing * Math.PI) / 180;
  return [cx + lx * Math.cos(f) + lz * Math.sin(f), cz - lx * Math.sin(f) + lz * Math.cos(f)];
}

/** Everything standing on a thing, and on those, and so on up: what moves with it. */
export function ridersOf(room: Pick<Room, "props">, id: string): string[] {
  const out = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of room.props)
      if (p.on && out.has(p.on) && !out.has(p.id)) {
        out.add(p.id);
        grew = true;
      }
  }
  out.delete(id);
  return [...out];
}

/**
 * The top a small thing being dragged would land on: of everything with a
 * top that the pointer is over, the highest, and where on it, kept on it and
 * snapped. `ray` says where the pointer's line of sight crosses a height, on
 * the floor plan. What is dragged, and what stands on it, is never its own
 * base.
 */
export function onTop(
  room: Pick<Room, "props">,
  kinds: Kinds,
  dragged: Pick<Prop, "id" | "kind" | "scale" | "size">,
  ray: (height: number) => [number, number] | undefined,
  free = false,
): { on: string; at: [number, number]; elevation: number } | undefined {
  const skip = new Set([dragged.id, ...ridersOf(room, dragged.id)]);
  const [w, d] = footprint(dragged, kinds);
  let best: { on: string; at: [number, number]; elevation: number } | undefined;
  for (const base of room.props) {
    const top = skip.has(base.id) ? undefined : topOf(base, kinds);
    if (top === undefined || (best && best.elevation >= top)) continue;
    const point = ray(top);
    if (!point) continue;
    const [bw, bd] = footprint(base, kinds);
    const [lx, lz] = local(point, base.at, base.facing);
    if (Math.abs(lx) > bw / 2 || Math.abs(lz) > bd / 2) continue;
    // Kept wholly on the top, so it never hangs off an edge it was only dragged near.
    const keep = (v: number, room: number) => Math.max(-room, Math.min(room, v));
    const kept = world(
      [keep(lx, Math.max(0, (bw - w) / 2)), keep(lz, Math.max(0, (bd - d) / 2))],
      base.at,
      base.facing,
    );
    best = { on: base.id, at: [snap(kept[0], free), snap(kept[1], free)], elevation: top };
  }
  return best;
}

// --------------------------------------------------------------------------
// The catalogue
// --------------------------------------------------------------------------

/** The catalogue's groups, in order, and the kinds each holds. A kind none names goes under wall or decor. */
export const GROUPS: { id: string; label: string; kinds: string[] }[] = [
  { id: "seating", label: "Seating", kinds: ["couch", "armchair", "beanbag", "chair", "stool", "bench", "bed"] },
  { id: "tables", label: "Tables", kinds: ["desk", "table", "round_table", "coffee_table", "side_table"] },
  { id: "storage", label: "Storage", kinds: ["bookshelf", "sideboard", "shelf"] },
  { id: "lights", label: "Lights", kinds: ["lamp", "table_lamp", "candle", "fireplace"] },
  { id: "plants", label: "Plants", kinds: ["plant", "tall_plant", "small_plant", "cactus", "palm", "vase"] },
  {
    id: "decor",
    label: "Decor",
    kinds: ["rug", "round_rug", "umbrella", "aquarium", "easel", "books", "mug", "block", "ball", "cylinder"],
  },
  {
    id: "wall",
    label: "On the walls",
    kinds: ["window", "picture", "painting", "poster", "pegboard", "clock", "sign"],
  },
  { id: "screens", label: "Boards and screens", kinds: ["board", "screen", "calendar", "tv", "laptop"] },
];

/**
 * Kinds the catalogue leaves out: a kiosk does something only as one of the
 * lobby's, which the building gives what it is for, so one from the
 * catalogue would be a blank that does nothing.
 */
export const LEFT_OUT = new Set(["kiosk"]);

/** One kind as the catalogue lists it: what it is called, and where it goes when it isn't the floor. */
export interface Offered {
  kind: string;
  noun: string;
  goes?: "on a wall" | "on something";
}

/** The kinds the server knows, in the catalogue's groups; a group with none of them is left out. */
export function catalogue(kinds: Kinds): { id: string; label: string; kinds: Offered[] }[] {
  const named = new Set(GROUPS.flatMap((g) => g.kinds));
  const offer = (kind: string): Offered => {
    const k = kinds[kind];
    const goes = k.mount === "wall" ? "on a wall" : k.mount === "on" ? "on something" : undefined;
    return { kind, noun: k.noun, ...(goes ? { goes } : {}) };
  };
  const strays = Object.keys(kinds).filter((k) => !named.has(k) && !LEFT_OUT.has(k));
  return GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    kinds: [
      ...g.kinds.filter((k) => kinds[k]),
      ...strays.filter((k) =>
        g.id === "wall" ? kinds[k].mount === "wall" : g.id === "decor" && kinds[k].mount !== "wall",
      ),
    ].map(offer),
  })).filter((g) => g.kinds.length);
}

// --------------------------------------------------------------------------
// Colours
// --------------------------------------------------------------------------

/** One colour to repaint with: its own name, or what in the room it matches. */
export interface Swatch {
  color: string;
  word?: string;
  /** What in the room has it already: "the walls", "the rug". */
  from?: string;
}

/** Colours that go with most rooms, after the room's own. */
export const COLOURS: Swatch[] = [
  { color: "#9caf88", word: "sage" },
  { color: "#2a8a8a", word: "teal" },
  { color: "#2b3a66", word: "navy" },
  { color: "#c99a2e", word: "mustard" },
  { color: "#ee7f6d", word: "coral" },
  { color: "#d77a8f", word: "rose" },
  { color: "#efe6d2", word: "cream" },
  { color: "#6b4a33", word: "walnut" },
  { color: "#3b3f45", word: "charcoal" },
];

/** The most swatches offered: enough to choose from, few enough to fit one row. */
export const SWATCHES = 12;

/** The room's own colours first, the walls', the floor's and its things', then a few that go with most, no repeats. */
export function palette(room: Pick<Room, "walls" | "floorColor" | "props">, more: Swatch[] = COLOURS): Swatch[] {
  const out: Swatch[] = [];
  const seen = new Set<string>();
  const add = (color: string | undefined, from?: string) => {
    const c = color?.toLowerCase();
    if (!c || !/^#[0-9a-f]{6}$/.test(c) || seen.has(c)) return;
    seen.add(c);
    const named = more.find((s) => s.color === c);
    out.push({ color: c, ...(named?.word ? { word: named.word } : {}), ...(from ? { from } : {}) });
  };
  add(room.walls, "the walls");
  add(room.floorColor, "the floor");
  for (const p of room.props) add(p.color, p.name);
  for (const s of more) add(s.color);
  return out.slice(0, SWATCHES);
}

// --------------------------------------------------------------------------
// What a change says
// --------------------------------------------------------------------------

/** A change you made, as the page tells the server. */
export type Edit =
  | ({ op: "move" } & Move)
  | { op: "add"; kind: string; like?: string }
  | { op: "remove"; item: string }
  | { op: "color"; item: string; color: string };

/**
 * How a change reads after your name in the room's recent changes, the way
 * an agent's does: "moved the couch", "turned the desk", "added the lamp",
 * "made the couch sage". `before` is the room it was made to, and `after`
 * the room it made.
 */
export function changeWords(edit: Edit, before: Pick<Room, "props">, after: Pick<Room, "props">): string {
  const was = (id: string) => before.props.find((p) => p.id === id);
  const now = (id: string) => after.props.find((p) => p.id === id);
  if (edit.op === "add") {
    const like = edit.like ? was(edit.like) : undefined;
    if (like) return `copied ${like.name}`;
    const fresh = after.props.find((p) => !was(p.id));
    return `added ${fresh?.name ?? `a ${edit.kind.replace(/_/g, " ")}`}`;
  }
  const thing = was(edit.item);
  const name = thing?.name ?? "something";
  if (edit.op === "remove") {
    const went = before.props.filter((p) => p.id !== edit.item && !now(p.id)).map((p) => p.name);
    return `removed ${name}${went.length ? `, and ${went.join(" and ")} on it` : ""}`;
  }
  if (edit.op === "color") {
    const swatch = palette(before).find((s) => s.color === edit.color.toLowerCase());
    if (swatch?.word) return `made ${name} ${swatch.word}`;
    if (swatch?.from && swatch.from !== name) return `made ${name} the colour of ${swatch.from}`;
    return `repainted ${name}`;
  }
  const moved = thing && (Math.abs(thing.at[0] - edit.at[0]) > 0.005 || Math.abs(thing.at[1] - edit.at[1]) > 0.005);
  if (thing && !moved) return `turned ${name}`;
  if (edit.on && edit.on !== thing?.on) {
    const base = after.props.find((p) => p.id === edit.on);
    if (base) return `moved ${name} onto ${base.name}`;
  }
  return `moved ${name}`;
}

/** How long the same change again counts as carrying on with it, rather than a new one, in milliseconds. */
export const SAME_CHANGE_MS = 2 * 60_000;
/** Changes a place remembers, and the most one says: as the server keeps them (`CHANGES_KEPT`, `CHANGE_LENGTH`). */
export const CHANGES_KEPT = 8;
export const CHANGE_LENGTH = 160;

/**
 * The room with your change at the top of its recent changes. Moving the
 * couch three times in a minute is one change, the latest, rather than three:
 * the list is a glance at who has been at the room, and a person nudging a
 * thing into place would push everyone else off it.
 */
export function withYourChange<T extends Pick<Room, "changes">>(room: T, change: RoomChange): T {
  const what = change.what.length > CHANGE_LENGTH ? `${change.what.slice(0, CHANGE_LENGTH - 1)}…` : change.what;
  const mine = { ...change, what, person: true };
  const [last, ...rest] = room.changes ?? [];
  const again =
    last?.person &&
    last.who === change.who &&
    last.what === what &&
    Date.parse(change.at) - Date.parse(last.at) < SAME_CHANGE_MS;
  const changes = again ? [mine, ...rest] : [mine, ...(room.changes ?? [])];
  return { ...room, changes: changes.slice(0, CHANGES_KEPT) };
}

// --------------------------------------------------------------------------
// Undo and redo
// --------------------------------------------------------------------------

/** One change you made: the room before it and after it, as saved, and the version before it (0: drawn, unsaved). */
export interface Step<P> {
  before: P;
  after: P;
  /** The record's version before the change: 0 when the place was drawn fresh, so undoing it is going back to that. */
  from: number;
  what: string;
}

/** Your changes in this visit, to undo, and those undone, to redo. */
export interface Steps<P> {
  done: Step<P>[];
  undone: Step<P>[];
}

/** The most changes kept to undo. */
export const STEPS_KEPT = 50;

export function noSteps<P>(): Steps<P> {
  return { done: [], undone: [] };
}

/** A new change: on top of what can be undone, and nothing left to redo. */
export function stepped<P>(steps: Steps<P>, step: Step<P>): Steps<P> {
  return { done: [...steps.done, step].slice(-STEPS_KEPT), undone: [] };
}

/** The change to take back, and the steps once it is; undefined when there is none. */
export function undoing<P>(steps: Steps<P>): { step: Step<P>; steps: Steps<P> } | undefined {
  const step = steps.done.at(-1);
  if (!step) return undefined;
  return { step, steps: { done: steps.done.slice(0, -1), undone: [...steps.undone, step] } };
}

/** The change to make again, and the steps once it is; undefined when there is none. */
export function redoing<P>(steps: Steps<P>): { step: Step<P>; steps: Steps<P> } | undefined {
  const step = steps.undone.at(-1);
  if (!step) return undefined;
  return { step, steps: { done: [...steps.done, step], undone: steps.undone.slice(0, -1) } };
}
