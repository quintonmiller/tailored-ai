/**
 * Rearranging a room yourself, the parts that need no GPU: where a thing you
 * drag lands (on a 10 cm grid, along a wall, or on top of something), what
 * the catalogue offers and how it is grouped, the colours to repaint with,
 * how a change reads in the room's recent changes, and the undo and redo of
 * your own changes. Whether a thing fits where you put it is the server's to
 * say, by the same checks the agents' `place` tool uses (`places-edit.ts` in
 * core), so a person can't make a room the tool would refuse. A person can
 * put in a door to any other place, and drag or take out a door anyone put
 * in. The stage drags and draws by what this says; the page saves.
 */
import { type MapPlace, placeTitle } from "../lib/wayfinding";
import type { Prop, Room, RoomChange, RoomDoor } from "./scene";

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
  /**
   * What goes with it (`groupOf`): the chairs at a table, what stands on a rug. Each keeps its place round it,
   * moved as far and turned as much about it. What stands on top of any of them goes too, as it always does.
   */
  with?: string[];
  elevation?: number;
  /** Dragged over nothing it could stand on: shown there, but it can't stay. */
  loose?: boolean;
}

/** A place to put a thing, as a key: the same place twice is asked about once. */
export const moveKey = (m: Move | undefined) =>
  m ? `${m.at[0]},${m.at[1]},${m.facing},${m.on ?? ""},${(m.with ?? []).join("+")}` : "";

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

/** Seats drawn up to a table or a desk to sit at it, which go where it goes. */
export const DRAWN_UP_KINDS = new Set(["chair", "stool", "bench", "cafe_chair"]);
/** What seats are drawn up to. */
export const TABLE_KINDS = new Set(["table", "round_table", "desk", "coffee_table", "cafe_table"]);
/** What things stand on, on the floor, and are carried along with it. */
export const RUG_KINDS = new Set(["rug", "round_rug"]);
/** How near a seat comes to a table, edge to edge, to be drawn up to it, in metres. */
export const DRAWN_UP = 0.35;

/** How far a point is outside a thing's footprint, in metres along the nearer of its sides; below 0 inside it. */
function outside(point: [number, number], thing: Prop, kinds: Kinds): number {
  const [w, d] = footprint(thing, kinds);
  const [lx, lz] = local(point, thing.at, kinds[thing.kind]?.round ? 0 : thing.facing);
  return Math.max(Math.abs(lx) - w / 2, Math.abs(lz) - d / 2);
}

/**
 * What goes with a thing when you move or turn it, by id: the seats drawn up
 * to a table or a desk (each to the nearest one it is drawn up to), and
 * everything standing on a rug, with the seats drawn up to any table on it.
 * Things on a wall, things standing on top of something (they go with what
 * they stand on anyway) and other rugs go only by themselves. Nothing goes
 * with a thing that isn't on the floor.
 */
export function groupOf(room: Pick<Room, "props">, kinds: Kinds, id: string): string[] {
  const prop = room.props.find((p) => p.id === id);
  const floor = (p: Prop) => !p.on && kinds[p.kind]?.mount === "floor";
  if (!prop || !floor(prop)) return [];
  const tables = room.props.filter((p) => floor(p) && TABLE_KINDS.has(p.kind));
  /** The seats drawn up to a table: near enough, and no nearer another. */
  const seatsAt = (table: Prop) =>
    room.props
      .filter((p) => floor(p) && DRAWN_UP_KINDS.has(p.kind))
      .filter((seat) => {
        const [w, d] = footprint(seat, kinds);
        const reach = DRAWN_UP + Math.max(w, d) / 2;
        const gap = outside(seat.at, table, kinds);
        return gap <= reach && tables.every((t) => t === table || outside(seat.at, t, kinds) >= gap);
      })
      .map((p) => p.id);
  const out = new Set<string>();
  if (TABLE_KINDS.has(prop.kind)) for (const seat of seatsAt(prop)) out.add(seat);
  if (RUG_KINDS.has(prop.kind))
    for (const p of room.props) {
      if (p === prop || !floor(p) || RUG_KINDS.has(p.kind) || outside(p.at, prop, kinds) > 0) continue;
      out.add(p.id);
      if (TABLE_KINDS.has(p.kind)) for (const seat of seatsAt(p)) out.add(seat);
    }
  out.delete(id);
  return [...out].sort();
}

/**
 * Where each thing in a group is once the one it goes with is put `to`,
 * turned to `facing`: each keeps its place round it, moved as far and
 * turned as much about its middle.
 */
export function carriedTo(
  room: Pick<Room, "props">,
  move: Pick<Move, "item" | "at" | "facing" | "with">,
): { id: string; at: [number, number]; facing: number }[] {
  const lead = room.props.find((p) => p.id === move.item);
  if (!lead) return [];
  const turn = move.facing - lead.facing;
  return (move.with ?? []).flatMap((id) => {
    const p = room.props.find((q) => q.id === id);
    if (!p) return [];
    const [lx, lz] = local(p.at, lead.at, lead.facing);
    const [x, z] = world([lx, lz], move.at, lead.facing + turn);
    return [{ id, at: [cm(x), cm(z)] as [number, number], facing: turned(p.facing, turn) }];
  });
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
  {
    id: "widgets",
    label: "Widgets",
    kinds: [
      "status_board",
      "needs_board",
      "feed",
      "chart",
      "agenda",
      "todo",
      "photo_wall",
      "ticker",
      "display",
      "monitor",
    ],
  },
];

/** One choice of what a widget shows, as the editor's bar offers it: what is saved, and what it says. */
export interface ShowsChoice {
  value: string;
  label: string;
}

/**
 * What a person can choose for a widget to show, by its kind: a chart's
 * measure, which widget a display stand or a desk monitor is, a ticker's room
 * from the rooms there are, or which of the Board's widgets a screen keeps
 * to. The first choice, saved as nothing, is what the kind shows by itself.
 * None for a kind that shows what it is.
 */
export function showsChoices(
  kind: string,
  have: { rooms?: string[]; widgets?: { id: string; title?: string }[] } = {},
): ShowsChoice[] | undefined {
  const measures = [
    { value: "tokens", label: "Tokens per day" },
    { value: "turns", label: "Turns per day" },
    { value: "tasks", label: "Tasks done per day" },
    { value: "time", label: "Time by activity" },
  ];
  switch (kind) {
    case "chart":
      return [{ value: "", label: "All four, in turn" }, ...measures];
    case "ticker":
      return [
        { value: "", label: "Its own room, or every room" },
        ...(have.rooms ?? []).map((r) => ({ value: r, label: `#${r}` })),
      ];
    case "screen":
      return [
        { value: "", label: "The Board's widgets, in turn" },
        ...(have.widgets ?? []).map((w) => ({ value: w.id, label: w.title ?? w.id })),
      ];
    case "display":
    case "monitor":
      return [
        { value: "", label: kind === "display" ? "Who's doing what" : "The clock and agenda" },
        ...(kind === "display"
          ? [{ value: "agenda", label: "The clock and agenda" }]
          : [{ value: "status", label: "Who's doing what" }]),
        { value: "feed", label: "Activity feed" },
        { value: "needs", label: "Needs you" },
        { value: "tasks", label: "Task board" },
        { value: "my tasks", label: "To-do list" },
        { value: "calendar", label: "Calendar" },
        { value: "photos", label: "Photos" },
        { value: "ticker", label: "Room ticker" },
        { value: "chart", label: "Chart: all four, in turn" },
        ...measures.map((m) => ({ value: `chart: ${m.value}`, label: `Chart: ${m.label.toLowerCase()}` })),
        { value: "dashboard", label: "The Board's widgets" },
      ];
    default:
      return undefined;
  }
}

/**
 * Kinds the catalogue leaves out: a kiosk does something only as one of the
 * lobby's, which the building gives what it is for, so one from the
 * catalogue would be a blank that does nothing. A model is offered by its
 * own name, under "Made by agents" (`madeByAgents`), never as a blank model.
 */
export const LEFT_OUT = new Set(["kiosk", "model", "wall_model", "small_model"]);

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

/** A model an agent made, as the server lists it for the catalogue. */
export interface MadeModel {
  /** Its record's id, `planner:bookcase`: what adding it sends. */
  id: string;
  name: string;
  owner: string;
  /** The kind of thing it is in a room, by where it goes. */
  kind: string;
  size: [number, number, number];
  /** How many faces it has: things to use on it, a list to tick or a card. */
  faces?: number;
  about?: string;
}

/** One model as the catalogue offers it: its name in words, whose it is, and where it goes when it isn't the floor. */
export interface OfferedModel {
  id: string;
  label: string;
  by: string;
  goes?: "on a wall" | "on something";
  about?: string;
}

/**
 * The catalogue's "Made by agents", newest first as the server lists them:
 * the models of whoever this place is for (`here`) first, and everyone
 * else's apart, folded away until asked for, so a deployment of forty agents
 * with a to-do board each doesn't bury the furniture.
 */
export function madeByAgents(
  models: MadeModel[],
  kinds: Kinds,
  here: string[] = [],
): { here: OfferedModel[]; others: OfferedModel[] } {
  const offered = models.map((m): OfferedModel => {
    const mount = kinds[m.kind]?.mount;
    const goes = mount === "wall" ? "on a wall" : mount === "on" ? "on something" : undefined;
    return {
      id: m.id,
      label: m.name.replace(/_/g, " "),
      by: m.owner,
      ...(goes ? { goes } : {}),
      ...(m.about ? { about: m.about } : {}),
    };
  });
  return { here: offered.filter((m) => here.includes(m.by)), others: offered.filter((m) => !here.includes(m.by)) };
}

/** Whom a place is for, in the catalogue: the agent whose home it is, and every agent whose model is in it already. */
export function madeHere(id: string, room: Pick<Room, "models">): string[] {
  const owners = new Set(Object.values(room.models ?? {}).map((m) => m.owner));
  if (id.startsWith("home:")) owners.add(id.slice("home:".length));
  return [...owners];
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
  | { op: "add"; kind: string; like?: string; model?: string; avoid?: [number, number][] }
  | { op: "remove"; item: string }
  | { op: "color"; item: string; color: string }
  /** What a widget shows (`Prop.shows`); null, what its kind shows by itself. */
  | { op: "shows"; item: string; shows: string | null }
  /** A door to another place, by its id, with its way back on the other side. */
  | { op: "door"; to: string };

/**
 * What a person sees a thing called: its name, but without the number the
 * room adds to tell copies apart ("the vase of flowers 2") when what is left
 * is its kind's own name, maybe with a colour: that number is for the tools,
 * and reads to a person as something left unfinished. A name someone chose
 * keeps its number ("the room 101 sign" stays as it is).
 */
export function shownName(item: { name: string }, noun: string | undefined): string {
  const copy = /^(.*\S)\s+\d+$/.exec(item.name);
  if (!copy || !noun) return item.name;
  return copy[1].toLowerCase().endsWith(noun.toLowerCase()) ? copy[1] : item.name;
}

/**
 * A thing as a change line names it, for the people who read a room's recent
 * changes: its name, unless that is a copy the room numbered to tell it from
 * others like it ("the plant 2"). Then it is "the other plant" when there are
 * two of them, and "a plant" when there are more, as the server words an
 * agent's changes.
 */
export function changeName(room: Pick<Room, "props">, name: string): string {
  const copy = /^the (.+?)\s+\d+$/i.exec(name);
  if (!copy) return name;
  const base = copy[1];
  const alike = new RegExp(`^the ${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s+\\d+)?$`, "i");
  const count = room.props.filter((p) => alike.test(p.name)).length;
  if (count < 2) return name;
  return count === 2 ? `the other ${base}` : `${/^[aeiou]/i.test(base) ? "an" : "a"} ${base}`;
}

/**
 * How a change reads after your name in the room's recent changes, the way
 * an agent's does: "moved the couch", "turned the desk", "added the lamp",
 * "made the couch sage". `before` is the room it was made to, and `after`
 * the room it made.
 */
export function changeWords(
  edit: Edit,
  before: Pick<Room, "props">,
  after: Pick<Room, "props">,
  /** What the place a door leads to is called: "the lounge", "planner's home". */
  named: (to: string) => string | undefined = () => undefined,
): string {
  const was = (id: string) => before.props.find((p) => p.id === id);
  const now = (id: string) => after.props.find((p) => p.id === id);
  if (edit.op === "door") return `put in a door to ${named(edit.to) ?? "another place"}`;
  const door = "item" in edit ? doorItemTo(edit.item) : undefined;
  if (door) return `${edit.op === "move" ? "moved" : "took out"} the door to ${named(door) ?? "another place"}`;
  if (edit.op === "add") {
    const like = edit.like ? was(edit.like) : undefined;
    if (like) return `copied ${changeName(before, like.name)}`;
    const fresh = after.props.find((p) => !was(p.id));
    // A copy's number says there is one already: "added another plant", not "added the plant 2".
    const copy = fresh ? /^the (.+)\s+\d+$/.exec(fresh.name) : null;
    if (copy && before.props.some((p) => p.name === `the ${copy[1]}`)) return `added another ${copy[1]}`;
    return `added ${fresh?.name ?? `a ${edit.kind.replace(/_/g, " ")}`}`;
  }
  const thing = was(edit.item);
  const name = thing ? changeName(before, thing.name) : "something";
  if (edit.op === "remove") {
    const went = before.props.filter((p) => p.id !== edit.item && !now(p.id)).map((p) => changeName(before, p.name));
    return `removed ${name}${went.length ? `, and ${went.join(" and ")} on it` : ""}`;
  }
  if (edit.op === "color") {
    const swatch = palette(before).find((s) => s.color === edit.color.toLowerCase());
    if (swatch?.word) return `made ${name} ${swatch.word}`;
    if (swatch?.from && swatch.from !== thing?.name)
      return `made ${name} the colour of ${changeName(before, swatch.from)}`;
    return `repainted ${name}`;
  }
  if (edit.op === "shows") return edit.shows ? `set ${name} to show ${edit.shows}` : `set ${name} back to its own`;
  const moved = thing && (Math.abs(thing.at[0] - edit.at[0]) > 0.005 || Math.abs(thing.at[1] - edit.at[1]) > 0.005);
  // What went with it: by name while there are a couple, then how many.
  const along = (edit.with ?? []).flatMap((id) => was(id)?.name ?? []);
  const also =
    along.length === 0
      ? ""
      : along.length <= 2
        ? ` with ${along.join(" and ")}`
        : `, and the ${along.length} things with it`;
  if (thing && !moved) return `turned ${name}${also}`;
  if (edit.on && edit.on !== thing?.on) {
    const base = after.props.find((p) => p.id === edit.on);
    if (base) return `moved ${name} onto ${changeName(after, base.name)}`;
  }
  return `moved ${name}${also}`;
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

// --------------------------------------------------------------------------
// Doors put in
// --------------------------------------------------------------------------

/** The id a door put in is picked by, as a thing is picked by its id. */
export const doorItem = (to: string) => `door:${to}`;
/** The place a door put in leads to, from the id it is picked by; undefined for a thing's id. */
export const doorItemTo = (id: string | undefined) => (id?.startsWith("door:") ? id.slice("door:".length) : undefined);

/** The doors put in a room, which a person may take out: those that say who put them in. */
export function madeDoors(room: Pick<Room, "doors">): RoomDoor[] {
  return (room.doors ?? []).filter((d) => !!d.by);
}

/** A place a door can lead to, for the catalogue: its id, what it is called, and what kind of place it is in a word. */
export interface Linkable {
  id: string;
  label: string;
  kind: string;
}

const KIND_WORDS: Record<string, string> = {
  home: "Home",
  shared: "Shared place",
  room: "Meeting room",
  lobby: "The town hall",
};

/**
 * The places a person can put a door in to from `here`: every home, shared
 * place and meeting room, and the town hall, but this place and those it has
 * a door to already; homes first, then by name. Filtered by `query` when
 * there is one, by what each is called.
 */
export function linkable(places: MapPlace[], here: string, room: Pick<Room, "doors">, query = ""): Linkable[] {
  const linked = new Set((room.doors ?? []).map((d) => d.to));
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const order = ["home", "shared", "room", "lobby"];
  return places
    .filter((p) => KIND_WORDS[p.kind] && p.id !== here && !linked.has(p.id))
    .map((p) => ({ id: p.id, label: placeTitle(p), kind: KIND_WORDS[p.kind] }))
    .filter((p) => !q || p.label.toLowerCase().replace(/^#/, "").includes(q))
    .sort(
      (a, b) =>
        order.indexOf(places.find((p) => p.id === a.id)?.kind ?? "") -
          order.indexOf(places.find((p) => p.id === b.id)?.kind ?? "") ||
        a.label.localeCompare(b.label, "en", { sensitivity: "base" }),
    );
}

/**
 * The doors a room shows, with those put in where its record now has them:
 * moved where one was dragged, gone where one was taken out. The town's own
 * doors and every plate are the server's to say: this only keeps a door from
 * showing where it was until the server sends the room's doors again.
 */
export function doorsAsSaved(doors: RoomDoor[] | undefined, record: unknown): RoomDoor[] | undefined {
  if (!doors) return doors;
  const links = (record as { links?: unknown } | undefined)?.links;
  const kept = Array.isArray(links) ? (links as { to?: unknown; wall?: unknown; along?: unknown }[]) : [];
  const sides: unknown[] = ["back", "left", "front", "right"];
  return doors.flatMap((d) => {
    if (!d.by) return [d];
    const l = kept.find((k) => k?.to === d.to);
    if (!l) return [];
    return typeof l.along === "number" && sides.includes(l.wall)
      ? [{ ...d, wall: l.wall as RoomDoor["wall"], along: l.along }]
      : [d];
  });
}

/** How far a door put in keeps from a corner, and the doorway it keeps clear: as core's `places-layout.ts` has them. */
const DOOR_END = 0.3;
const DOORWAY = { width: 1.6, depth: 1.0 };

/** A side of the room, and how far along it a door on it is. */
export interface DoorSlot {
  wall: RoomDoor["wall"];
  along: number;
}

/**
 * Where a door put in goes, dragged to a point on the floor: on the side of
 * the room the point is nearest, as far along it as a door can go short of
 * the corners, to the nearest 5 cm. As core's `doorSlotAt`, which the server
 * goes by to say whether it fits there.
 */
export function doorSlotAt(room: Pick<Room, "width" | "depth">, [x, z]: [number, number]): DoorSlot {
  const away: [DoorSlot["wall"], number][] = [
    ["back", z + room.depth / 2],
    ["left", x + room.width / 2],
    ["front", room.depth / 2 - z],
    ["right", room.width / 2 - x],
  ];
  const [wall] = away.reduce((a, b) => (b[1] < a[1] ? b : a));
  const across = wall === "back" || wall === "front";
  const most = (across ? room.width : room.depth) / 2 - DOOR_END - DOORWAY.width / 2;
  const along = Math.round((across ? x : z) / 0.05) * 0.05;
  return { wall, along: cm(Math.max(-most, Math.min(most, along))) };
}

/** The point on its side a door is at: where a drag of one says it was let go, which the server reads back as that slot. */
export function doorPoint(room: Pick<Room, "width" | "depth">, slot: DoorSlot): [number, number] {
  switch (slot.wall) {
    case "back":
      return [slot.along, -room.depth / 2];
    case "front":
      return [slot.along, room.depth / 2];
    case "left":
      return [-room.width / 2, slot.along];
    case "right":
      return [room.width / 2, slot.along];
  }
}

/**
 * The floor right in front of a door, which nothing may stand on: as wide as
 * its doorway and a metre into the room, turned square to its side. Drawn
 * while a door is dragged, coloured by whether it fits there.
 */
export function doorPatch(
  room: Pick<Room, "width" | "depth">,
  slot: DoorSlot,
): { at: [number, number]; width: number; depth: number; facing: number } {
  const [x, z] = doorPoint(room, slot);
  const into = DOORWAY.depth / 2;
  const at: [number, number] =
    slot.wall === "back"
      ? [x, z + into]
      : slot.wall === "front"
        ? [x, z - into]
        : slot.wall === "left"
          ? [x + into, z]
          : [x - into, z];
  return {
    at,
    width: DOORWAY.width,
    depth: DOORWAY.depth,
    facing: slot.wall === "back" || slot.wall === "front" ? 0 : 90,
  };
}
