/**
 * Places: the 3D rooms agents' bodies live in, as data an agent can change.
 *
 * A place is a world-state record of type `place`. The web UI draws it from
 * simple shapes and the avatar walks between its spots; the `place` tool
 * lets the agent add, move, restyle and remove things, or resize and repaint
 * the room. Everything in this file is pure: where a new thing fits, what
 * spot it brings with it, and how the room reads in words. `places.ts` wires
 * it to the store, the tool and HTTP.
 *
 * Units are metres. +X is to the viewer's right and +Z toward the viewer.
 * The back wall is at -depth/2 and the left wall at -width/2; the front and
 * right sides are open, so the camera can see in. A `facing` of 0° looks
 * toward the viewer, 90° toward +X.
 */

export type Activity = "sit" | "type" | "look" | "browse";
export type Floor = "wood" | "carpet" | "tile" | "concrete";
export const FLOORS: Floor[] = ["wood", "carpet", "tile", "concrete"];

export interface PlaceItem {
  id: string;
  /** What the agent and the person call it: "the couch". */
  name: string;
  kind: string;
  /** Floor position, [x, z]. */
  at: [number, number];
  facing: number;
  /** Height above the floor, for things on a wall or on top of something. */
  elevation?: number;
  /** The spot to walk to when someone clicks it. */
  spot?: string;
  /** The item it stands on: it moves with it. */
  on?: string;
  /** "#rrggbb" for its main part. */
  color?: string;
  /** Size relative to normal. */
  scale?: number;
  /** For the basic shapes: width, height, depth. */
  size?: [number, number, number];
  /** Words it shows: a kiosk's screen, a board's heading. */
  label?: string;
  /** What clicking it does on the page, for things made to be used: a kiosk, a task board. */
  action?: PlaceAction;
}

/** What a thing in a place does when someone clicks it on the page. */
export type PlaceAction = "new-agent" | "new-task" | "new-room" | "tasks";
export const PLACE_ACTIONS: PlaceAction[] = ["new-agent", "new-task", "new-room", "tasks"];

export interface PlaceSpot {
  id: string;
  name: string;
  /** Where it is, as you would say it after "go to": "the couch". */
  place: string;
  at: [number, number];
  facing: number;
  activity?: Activity;
  seat?: { at: [number, number]; height: number };
  /** The item this spot belongs to: it is worked out from it, and moves with it. */
  item?: string;
}

export interface Place {
  name: string;
  width: number;
  depth: number;
  height: number;
  /** "#rrggbb". */
  walls?: string;
  floor?: Floor;
  floorColor?: string;
  props: PlaceItem[];
  spots: PlaceSpot[];
  /** Where the avatar stands when the page opens, and the hub its walks go through. */
  start: string;
  /** Photos taken here, newest first: the pictures on the walls show them, in order. */
  photos?: PlacePhoto[];
  /**
   * The area it belongs to, in words ("the summer house"): places in one area
   * are joined by doors, and areas by the map. None is the main building.
   */
  area?: string;
  /** The look it was dressed in, by id (`THEMES` in `places-rooms.ts`), or "none" for plain. Chosen beats guessed. */
  theme?: string;
  /** What it is for, in a line: shown on the map and to whoever looks round it. */
  purpose?: string;
  /** What was done to it lately with the `place` tool, newest first: who, what, when. */
  changes?: PlaceChange[];
}

/** One change to a place, as the room's recent changes list it: "planner added the bookshelf". */
export interface PlaceChange {
  /** The agent that made it, or the person, by what agents call them in rooms (`rooms.ownerLabel`). */
  who: string;
  /** What it did, in a few words that follow its name: "added the bookshelf by the window". */
  what: string;
  at: string;
  /** Made by the person on the page, not by an agent: the page says "you". */
  person?: boolean;
}

/** Changes a place remembers: enough for a glance at who has been at it lately. */
export const CHANGES_KEPT = 8;
/** The most a recorded change says, in characters: it is a glance, and the agent's own words can run long. */
export const CHANGE_LENGTH = 160;

/** A photo taken in a place, kept in the media store. */
export interface PlacePhoto {
  /** Its id in the media store. */
  media: string;
  /** What it is of: "a selfie", "the lounge". */
  what: string;
  at: string;
}

/** Photos a place keeps: the newest, enough for a few pictures on the walls. */
export const PHOTOS_KEPT = 6;

/** What a photo hangs in, in this order: pictures first, then paintings. The page draws them there (`stage.ts`). */
export const PHOTO_FRAMES = ["picture", "painting"];

/** What a kind of thing is like: how big, where it goes, and what you can do at it. */
export interface Kind {
  noun: string;
  mount: "floor" | "wall" | "on";
  /** Width (x) and depth (z) at facing 0, before scaling. */
  footprint: [number, number];
  height: number;
  /** Things can be put on it, this high above its base. */
  surface?: number;
  /** Others can stand on it, and it under them: a rug. */
  walkable?: boolean;
  /** Goes against a wall unless told otherwise. */
  wallward?: boolean;
  /** Seats put near it turn to face it. */
  focus?: boolean;
  /** Height above the floor, for things on a wall. */
  elevation?: number;
  /** The spot it brings: what the avatar does there, and how far in front of it to stand. */
  use?: { activity: Activity; offset: number; seat?: { offset: number; height: number } };
  /** Sized by `size` instead of a fixed footprint: the basic shapes. */
  shaped?: boolean;
  /** Round, so turning it takes no more room: pots, lamps, balls. */
  round?: boolean;
}

const sit = (offset: number, seatOffset: number, height: number) => ({
  activity: "sit" as const,
  offset,
  seat: { offset: seatOffset, height },
});

export const KINDS: Record<string, Kind> = {
  rug: { noun: "rug", mount: "floor", footprint: [2.0, 1.4], height: 0.03, walkable: true },
  couch: {
    noun: "couch",
    mount: "floor",
    footprint: [1.6, 0.8],
    height: 0.8,
    wallward: true,
    use: sit(0.66, 0.13, 0.47),
  },
  armchair: { noun: "armchair", mount: "floor", footprint: [0.85, 0.8], height: 0.85, use: sit(0.6, 0.08, 0.45) },
  beanbag: {
    round: true,
    noun: "beanbag",
    mount: "floor",
    footprint: [0.75, 0.75],
    height: 0.45,
    use: sit(0.5, 0.02, 0.3),
  },
  bed: { noun: "bed", mount: "floor", footprint: [1.4, 2.0], height: 0.55, wallward: true, use: sit(1.35, 0.82, 0.5) },
  chair: { noun: "chair", mount: "floor", footprint: [0.5, 0.5], height: 1.05 },
  desk: {
    noun: "desk",
    mount: "floor",
    footprint: [1.2, 0.6],
    height: 0.76,
    surface: 0.76,
    wallward: true,
    use: { activity: "type", offset: 0.49 },
  },
  table: { noun: "table", mount: "floor", footprint: [1.2, 0.8], height: 0.75, surface: 0.75 },
  coffee_table: { noun: "coffee table", mount: "floor", footprint: [1.0, 0.55], height: 0.42, surface: 0.42 },
  side_table: { noun: "side table", mount: "floor", footprint: [0.45, 0.45], height: 0.55, surface: 0.55 },
  bookshelf: {
    noun: "bookshelf",
    mount: "floor",
    footprint: [0.9, 0.32],
    height: 1.8,
    wallward: true,
    use: { activity: "browse", offset: 0.5 },
  },
  tv: {
    noun: "TV",
    mount: "floor",
    footprint: [1.2, 0.4],
    height: 1.15,
    surface: 0.5,
    wallward: true,
    focus: true,
    use: { activity: "look", offset: 1.4 },
  },
  fireplace: {
    noun: "fireplace",
    mount: "floor",
    footprint: [1.3, 0.45],
    height: 1.15,
    surface: 1.15,
    wallward: true,
    focus: true,
    use: { activity: "look", offset: 0.85 },
  },
  lamp: { round: true, noun: "lamp", mount: "floor", footprint: [0.36, 0.36], height: 1.67 },
  plant: { round: true, noun: "plant", mount: "floor", footprint: [0.34, 0.34], height: 1.0 },
  window: {
    noun: "window",
    mount: "wall",
    footprint: [1.2, 0.08],
    height: 1.0,
    elevation: 1.0,
    use: { activity: "look", offset: 0.54 },
  },
  picture: { noun: "picture", mount: "wall", footprint: [0.9, 0.04], height: 0.6, elevation: 1.55 },
  /** A board on the wall the page fills with tasks. */
  board: { noun: "task board", mount: "wall", footprint: [1.4, 0.05], height: 0.9, elevation: 1.05 },
  /** A stand with a screen that does something when clicked. */
  kiosk: { noun: "kiosk", mount: "floor", footprint: [0.6, 0.5], height: 1.25 },
  palm: { round: true, noun: "palm", mount: "floor", footprint: [0.5, 0.5], height: 1.9 },
  // Its canopy is overhead: things go under it, and so do people.
  umbrella: { round: true, noun: "beach umbrella", mount: "floor", footprint: [1.4, 1.4], height: 2.0, walkable: true },
  clock: { noun: "clock", mount: "wall", footprint: [0.36, 0.05], height: 0.36, elevation: 1.8 },
  shelf: { noun: "shelf", mount: "wall", footprint: [0.9, 0.22], height: 0.05, elevation: 1.25, surface: 0.05 },
  laptop: { noun: "laptop", mount: "on", footprint: [0.34, 0.24], height: 0.25 },
  books: { noun: "books", mount: "on", footprint: [0.24, 0.17], height: 0.14 },
  vase: { round: true, noun: "vase of flowers", mount: "on", footprint: [0.14, 0.14], height: 0.42 },
  small_plant: { round: true, noun: "small plant", mount: "on", footprint: [0.2, 0.2], height: 0.32 },
  mug: { round: true, noun: "mug", mount: "on", footprint: [0.09, 0.09], height: 0.1 },
  candle: { round: true, noun: "candle", mount: "on", footprint: [0.08, 0.08], height: 0.15 },
  aquarium: { noun: "aquarium", mount: "on", footprint: [0.6, 0.3], height: 0.42 },
  block: { noun: "block", mount: "floor", footprint: [0.5, 0.5], height: 0.5, shaped: true, surface: 0.5 },
  ball: { round: true, noun: "ball", mount: "floor", footprint: [0.5, 0.5], height: 0.5, shaped: true },
  cylinder: {
    round: true,
    noun: "cylinder",
    mount: "floor",
    footprint: [0.5, 0.5],
    height: 0.5,
    shaped: true,
    surface: 0.5,
  },
  round_rug: { round: true, noun: "round rug", mount: "floor", footprint: [1.8, 1.8], height: 0.03, walkable: true },
  sideboard: {
    noun: "sideboard",
    mount: "floor",
    footprint: [1.6, 0.45],
    height: 0.8,
    surface: 0.8,
    wallward: true,
  },
  // Drawn 1.2 m across; kept to the square inside the circle, so seats round it can come as close as they would to a real one.
  round_table: {
    round: true,
    noun: "round table",
    mount: "floor",
    footprint: [1.0, 1.0],
    height: 0.75,
    surface: 0.75,
  },
  stool: { round: true, noun: "stool", mount: "floor", footprint: [0.4, 0.4], height: 0.5, use: sit(0.38, 0, 0.5) },
  easel: { noun: "easel", mount: "floor", footprint: [0.7, 0.6], height: 1.7, use: { activity: "look", offset: 0.75 } },
  tall_plant: { round: true, noun: "tall plant", mount: "floor", footprint: [0.5, 0.5], height: 1.7 },
  cactus: { round: true, noun: "cactus", mount: "floor", footprint: [0.32, 0.32], height: 0.9 },
  painting: { noun: "painting", mount: "wall", footprint: [1.2, 0.04], height: 0.8, elevation: 1.4 },
  poster: { noun: "poster", mount: "wall", footprint: [0.6, 0.02], height: 0.85, elevation: 1.3 },
  pegboard: { noun: "pegboard", mount: "wall", footprint: [1.2, 0.06], height: 0.75, elevation: 1.2 },
  table_lamp: { round: true, noun: "table lamp", mount: "on", footprint: [0.22, 0.22], height: 0.45 },
  bench: { noun: "bench", mount: "floor", footprint: [1.3, 0.42], height: 0.46, use: sit(0.45, 0.02, 0.44) },
  /** A plate on the wall that shows its words: a hall's name. */
  sign: { noun: "sign", mount: "wall", footprint: [1.4, 0.04], height: 0.36, elevation: 1.6 },
  /** A flat screen on the wall: the page shows the dashboard on it, and in a home what its owner is up to. */
  screen: { noun: "screen", mount: "wall", footprint: [1.6, 0.06], height: 0.92, elevation: 1.25 },
  /** A calendar on the wall: the page fills it with its owner's day, and in the lobby everyone's next wakes. */
  calendar: { noun: "calendar", mount: "wall", footprint: [1.0, 0.03], height: 1.0, elevation: 1.1 },
  // Things for the work an agent does: a traveller's globe and map, a producer's microphone, a coder's servers,
  // a bookkeeper's ledgers, a game master's board.
  globe: {
    round: true,
    noun: "globe",
    mount: "floor",
    footprint: [0.5, 0.5],
    height: 1.05,
    use: { activity: "look", offset: 0.55 },
  },
  map: { noun: "map", mount: "wall", footprint: [1.3, 0.03], height: 0.85, elevation: 1.45 },
  mic_stand: { round: true, noun: "microphone stand", mount: "floor", footprint: [0.4, 0.4], height: 1.55 },
  server_rack: {
    noun: "server rack",
    mount: "floor",
    footprint: [0.6, 0.62],
    height: 1.9,
    wallward: true,
    use: { activity: "look", offset: 0.6 },
  },
  ledger: { noun: "ledger", mount: "on", footprint: [0.34, 0.25], height: 0.05 },
  chessboard: { noun: "chessboard", mount: "on", footprint: [0.4, 0.4], height: 0.09 },
};

export const LIMITS = {
  // Room enough for a lobby, the biggest room there is, and a meeting room for sixteen.
  width: [2.5, 16] as const,
  depth: [2.5, 12] as const,
  height: [2.2, 4] as const,
  scale: [0.5, 2] as const,
  /** Each side of a basic shape. */
  side: [0.05, 2.5] as const,
  // A home starts with thirty or so, and its owner should have as many again to add.
  items: 100,
};

/**
 * The room every home started as, before homes were drawn from a seed (see
 * `places-rooms.ts`): small, and the same for everyone. Kept so a home nobody
 * has changed since can be recognised and given a room of its own, and as a
 * small fixed room to test placement in.
 */
export function firstHome(name = "your room"): Place {
  return withSpots({
    name,
    width: 4.2,
    depth: 3.6,
    height: 2.5,
    walls: "#e9dfd0",
    floor: "wood",
    props: [
      { id: "rug", name: "the rug", kind: "rug", at: [0.1, 0.25], facing: 0, spot: "middle" },
      { id: "couch", name: "the couch", kind: "couch", at: [-0.85, -1.38], facing: 0 },
      { id: "picture", name: "the picture", kind: "picture", at: [-0.85, -1.79], facing: 0, elevation: 1.55 },
      { id: "lamp", name: "the floor lamp", kind: "lamp", at: [0.25, -1.5], facing: 0 },
      { id: "desk", name: "the desk", kind: "desk", at: [1.35, -1.47], facing: 0 },
      {
        id: "laptop",
        name: "the laptop",
        kind: "laptop",
        at: [1.35, -1.5],
        facing: 0,
        elevation: 0.76,
        on: "desk",
        spot: "desk",
      },
      { id: "chair", name: "the desk chair", kind: "chair", at: [0.72, -0.9], facing: 200, spot: "desk" },
      { id: "window", name: "the window", kind: "window", at: [-2.09, -0.45], facing: 90, elevation: 1.0 },
      { id: "bookshelf", name: "the bookshelf", kind: "bookshelf", at: [-1.9, 0.95], facing: 90 },
      { id: "plant", name: "the plant", kind: "plant", at: [-1.86, -1.5], facing: 0 },
    ],
    spots: [
      { id: "middle", name: "the middle of the room", place: "the middle of the room", at: [0.15, 0.35], facing: 20 },
    ],
    start: "middle",
  });
}

// --------------------------------------------------------------------------
// Geometry
// --------------------------------------------------------------------------

const round = (n: number) => Math.round(n * 100) / 100;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** An angle in (-180, 180]. */
export function normalizeFacing(degrees: number): number {
  let a = ((degrees % 360) + 360) % 360;
  if (a > 180) a -= 360;
  return round(a);
}

/** A point `lx` to the thing's right and `lz` in front of it, in the room, exactly. */
function exact([x, z]: [number, number], facing: number, lx: number, lz: number): [number, number] {
  const f = rad(facing);
  return [x + lx * Math.cos(f) + lz * Math.sin(f), z - lx * Math.sin(f) + lz * Math.cos(f)];
}

/** The same, to the centimetre: for positions that are kept. */
function offset(at: [number, number], facing: number, lx: number, lz: number): [number, number] {
  const [x, z] = exact(at, facing, lx, lz);
  return [round(x), round(z)];
}

/** A room point in a thing's own frame: [right, in front]. */
function local([x, z]: [number, number], [cx, cz]: [number, number], facing: number): [number, number] {
  const f = rad(facing);
  const dx = x - cx;
  const dz = z - cz;
  return [dx * Math.cos(f) - dz * Math.sin(f), dx * Math.sin(f) + dz * Math.cos(f)];
}

interface Rect {
  at: [number, number];
  /** Half width and half depth. */
  hw: number;
  hd: number;
  facing: number;
}

function corners(r: Rect): [number, number][] {
  return [
    [-r.hw, -r.hd],
    [r.hw, -r.hd],
    [r.hw, r.hd],
    [-r.hw, r.hd],
  ].map(([lx, lz]) => exact(r.at, r.facing, lx, lz));
}

/** Whether two rectangles overlap, with `gap` of space required between them. */
function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  const grown = { ...a, hw: a.hw + gap, hd: a.hd + gap };
  for (const r of [grown, b]) {
    const f = rad(r.facing);
    for (const [ax, az] of [
      [Math.cos(f), -Math.sin(f)],
      [Math.sin(f), Math.cos(f)],
    ]) {
      const project = (pts: [number, number][]) => pts.map(([x, z]) => x * ax + z * az);
      const pa = project(corners(grown));
      const pb = project(corners(b));
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}

function contains(r: Rect, point: [number, number], margin = 0): boolean {
  const [lx, lz] = local(point, r.at, r.facing);
  return Math.abs(lx) <= r.hw + margin && Math.abs(lz) <= r.hd + margin;
}

/** Width and depth of a thing, as placed. */
export function footprintOf(item: Pick<PlaceItem, "kind" | "scale" | "size">): [number, number] {
  const kind = KINDS[item.kind];
  if (kind?.shaped && item.size) return [item.size[0], item.size[2]];
  const s = item.scale ?? 1;
  const [w, d] = kind?.footprint ?? [0.5, 0.5];
  return [w * s, d * s];
}

export function heightOf(item: Pick<PlaceItem, "kind" | "scale" | "size">): number {
  const kind = KINDS[item.kind];
  if (kind?.shaped && item.size) return item.size[1];
  return (kind?.height ?? 0.5) * (item.scale ?? 1);
}

/** How high up its top surface is, for things that can hold others. */
function surfaceOf(item: PlaceItem): number | undefined {
  const kind = KINDS[item.kind];
  if (kind?.surface === undefined) return undefined;
  const top = kind.shaped && item.size ? item.size[1] : kind.surface * (item.scale ?? 1);
  return round((item.elevation ?? 0) + top);
}

function rectOf(item: Pick<PlaceItem, "kind" | "scale" | "size" | "at" | "facing">): Rect {
  const [w, d] = footprintOf(item);
  return { at: item.at, hw: w / 2, hd: d / 2, facing: KINDS[item.kind]?.round ? 0 : item.facing };
}

const isFloor = (item: PlaceItem) => !item.on && KINDS[item.kind]?.mount !== "wall";
const blocks = (item: PlaceItem) => isFloor(item) && !KINDS[item.kind]?.walkable;

/** A chair may tuck under a desk or table, as long as it isn't swallowed by it. */
function tucks(
  a: { kind: string; at: [number, number] },
  ra: Rect,
  b: { kind: string; at: [number, number] },
  rb: Rect,
) {
  const under = (chair: typeof a, table: typeof b, rt: Rect) =>
    (chair.kind === "chair" || chair.kind === "stool") &&
    (table.kind === "desk" || table.kind === "table" || table.kind === "round_table") &&
    !contains(rt, chair.at);
  return under(a, b, rb) || under(b, a, ra);
}

// --------------------------------------------------------------------------
// Spots
// --------------------------------------------------------------------------

function spotWords(item: PlaceItem, activity: Activity): string {
  if (activity === "sit") return `on ${item.name}`;
  if (activity === "browse" || item.kind === "fireplace") return `by ${item.name}`;
  return `at ${item.name}`;
}

/** The spot a thing brings with it, if you can do something there. */
export function spotOf(item: PlaceItem): PlaceSpot | undefined {
  const use = KINDS[item.kind]?.use;
  if (!use || item.on) return undefined;
  const s = item.scale ?? 1;
  const spot: PlaceSpot = {
    id: item.id,
    name: spotWords(item, use.activity),
    place: item.name,
    at: offset(item.at, item.facing, 0, use.offset * s),
    facing: normalizeFacing(use.activity === "sit" ? item.facing : item.facing + 180),
    activity: use.activity,
    item: item.id,
  };
  if (use.seat)
    spot.seat = { at: offset(item.at, item.facing, 0, use.seat.offset * s), height: round(use.seat.height * s) };
  return spot;
}

/**
 * The place with every item's spot worked out again: free spots (the middle
 * of the room) are kept, each item that brings one gets it, and a click that
 * led to a spot that is gone leads nowhere.
 */
export function withSpots(place: Place): Place {
  const derived = place.props.flatMap((p) => {
    const spot = spotOf(p);
    return spot ? [spot] : [];
  });
  const owned = new Set(derived.map((s) => s.id));
  const free = place.spots.filter((s) => !s.item && !owned.has(s.id));
  const spots = [...free, ...derived];
  const ids = new Set(spots.map((s) => s.id));
  const props = place.props.map((p) => {
    const next = { ...p };
    if (owned.has(p.id)) next.spot = p.id;
    else if (next.spot && !ids.has(next.spot)) delete next.spot;
    return next;
  });
  return { ...place, props, spots };
}

// --------------------------------------------------------------------------
// Finding things by what they're called
// --------------------------------------------------------------------------

const bare = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/^(the|a|an|your|my)\s+/, "")
    .trim();

/** The item words refer to: its id, its name, or its kind. */
export function findItem(place: Place, words: string): PlaceItem | undefined {
  const t = bare(words);
  if (!t) return undefined;
  return (
    place.props.find((p) => p.id === words.trim()) ??
    place.props.find((p) => bare(p.name) === t) ??
    place.props.find((p) => bare(KINDS[p.kind]?.noun ?? p.kind) === t || bare(p.kind) === t) ??
    place.props.find((p) => bare(p.name).includes(t) || t.includes(bare(p.name)))
  );
}

/**
 * The spot words refer to: its place ("the couch"), its name ("on the couch")
 * or its id. What a spot is called wins over an id, so "the beanbag 2" is the
 * one called that even when another's id is "beanbag-2".
 */
export function findSpot(place: Place, words: string): PlaceSpot | undefined {
  const t = bare(words);
  return (
    place.spots.find((s) => [s.place, s.name].some((n) => bare(n) === t)) ?? place.spots.find((s) => bare(s.id) === t)
  );
}

// --------------------------------------------------------------------------
// Where a thing fits
// --------------------------------------------------------------------------

export type Side = "left" | "right" | "front" | "behind";
export type Wall = "back" | "left" | "right" | "front";

/** Where to put something, in the words the tool takes. */
export interface Where {
  near?: string;
  side?: Side;
  wall?: Wall;
  corner?: string;
  on?: string;
  middle?: boolean;
  x?: number;
  z?: number;
  facing?: string | number;
}

export interface Placement {
  at: [number, number];
  facing: number;
  elevation?: number;
  on?: string;
}

/** What is being placed: a kind with its size, and the id it has if it is already in the room. */
export interface Placing {
  kind: string;
  scale?: number;
  size?: [number, number, number];
  id?: string;
}

const WALL_FACING: Record<Wall, number> = { back: 0, left: 90, right: -90, front: 180 };
const SIDE_DIR: Record<Side, [number, number]> = { left: [-1, 0], right: [1, 0], front: [0, 1], behind: [0, -1] };

/** Things that move along with this one: what stands on it, and so on up. */
function carried(place: Place, id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of place.props)
      if (p.on && out.has(p.on) && !out.has(p.id)) {
        out.add(p.id);
        grew = true;
      }
  }
  return out;
}

/** Whether a thing is a door's hold (see `withDoorwayHeld`): what is in its way is the way through the door. */
const isHold = (item: PlaceItem) => item.id.startsWith(DOOR_HOLD);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Why a floor thing doesn't fit here, as a sentence; undefined when it does:
 * inside, clear of the rest, not standing where anyone stands to use
 * something, not hiding what hangs on the wall behind it, and with room in
 * front of it to use it.
 */
function floorTrouble(place: Place, placing: Placing, rect: Rect): string | undefined {
  const kind = KINDS[placing.kind];
  const ignore = placing.id ? carried(place, placing.id) : new Set<string>();
  const margin = 0.01;
  for (const [x, z] of corners(rect))
    if (Math.abs(x) > place.width / 2 - margin || Math.abs(z) > place.depth / 2 - margin)
      return "It would stick out of the room.";
  if (kind?.walkable) return undefined;
  for (const other of place.props) {
    if (ignore.has(other.id) || !blocks(other)) continue;
    const ro = rectOf(other);
    if (overlaps(rect, ro, 0.03) && !tucks({ kind: placing.kind, at: rect.at }, rect, other, ro))
      return isHold(other) ? "It would block the way through the door." : `It would bump into ${other.name}.`;
  }
  for (const spot of place.spots) {
    if (spot.item && ignore.has(spot.item)) continue;
    if (contains(rect, spot.at, 0.18))
      return spot.item
        ? `It would be where someone stands to use ${spot.place}.`
        : `It would be where someone stands: ${spot.place}.`;
  }
  // A tall thing against a wall must not cover a window or picture there.
  const tall = heightOf(placing);
  for (const other of place.props) {
    if (ignore.has(other.id) || KINDS[other.kind]?.mount !== "wall") continue;
    const w = rectOf(other);
    if (tall > (other.elevation ?? 0) && overlaps({ ...rect }, { ...w, hd: w.hd + 0.25 }))
      return `It would hide ${other.name}.`;
  }
  return useTrouble(place, placing, rect, ignore);
}

/** Whether a floor thing fits here: inside, clear of the rest, and not standing on anyone's spot. */
function floorFits(place: Place, placing: Placing, rect: Rect): boolean {
  return !floorTrouble(place, placing, rect);
}

/** Why there's nowhere to stand to use the thing, when the spot it brings is outside the room or in something. */
function useTrouble(place: Place, placing: Placing, rect: Rect, ignore: Set<string>): string | undefined {
  const use = KINDS[placing.kind]?.use;
  if (!use) return undefined;
  const [sx, sz] = offset(rect.at, rect.facing, 0, use.offset * (placing.scale ?? 1));
  const m = 0.15;
  if (Math.abs(sx) > place.width / 2 - m || Math.abs(sz) > place.depth / 2 - m)
    return "There'd be nowhere in the room to stand to use it.";
  for (const other of place.props) {
    if (ignore.has(other.id) || !blocks(other)) continue;
    if (contains(rectOf(other), [sx, sz], 0.15))
      return isHold(other)
        ? "You'd have to stand in the doorway to use it."
        : `${capital(other.name)} is where you'd stand to use it.`;
  }
  return undefined;
}

/** Whether a floor thing fits at exactly this point, turned this way: what a room drawn from a seed checks each piece with. */
export function fitsOnFloor(place: Place, placing: Placing, at: [number, number], facing: number): boolean {
  return !whyNotOnFloor(place, placing, at, facing);
}

/** Why a floor thing doesn't fit at exactly this point, turned this way, as a sentence; undefined when it does. */
export function whyNotOnFloor(
  place: Place,
  placing: Placing,
  at: [number, number],
  facing: number,
): string | undefined {
  const [w, d] = footprintOf(placing);
  return floorTrouble(place, placing, { at, hw: w / 2, hd: d / 2, facing: KINDS[placing.kind]?.round ? 0 : facing });
}

/** Whether a wall thing fits on this wall, this far along it (its middle) and this high up. */
export function fitsOnWall(
  place: Place,
  placing: Placing,
  wall: "back" | "left",
  along: number,
  elevation: number,
): boolean {
  return !wallTrouble(place, placing, wall, along, elevation);
}

/** Why a wall thing doesn't fit on this wall, this far along it and this high up, as a sentence; undefined when it does. */
export function whyNotOnWall(
  place: Place,
  placing: Placing,
  wall: "back" | "left",
  along: number,
  elevation: number,
): string | undefined {
  return wallTrouble(place, placing, wall, along, elevation);
}

/** Points around `[x, z]`, nearest first, out to `reach` metres. */
function* around([x, z]: [number, number], reach = 3.2, step = 0.08): Generator<[number, number]> {
  yield [round(x), round(z)];
  for (let r = step; r <= reach; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      yield [round(x + r * Math.cos(a)), round(z + r * Math.sin(a))];
    }
  }
}

function towards(from: [number, number], to: [number, number]): number {
  return normalizeFacing((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI);
}

/** A facing the tool was given: degrees, "the room", or a thing to face. */
function facingFrom(place: Place, value: string | number | undefined, at: [number, number]): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n)) return normalizeFacing(n);
  const t = bare(String(value));
  if (["room", "middle", "middle of the room", "centre", "center", "inward", "in"].includes(t))
    return towards(at, [0, 0]);
  if (["viewer", "you", "camera", "front", "forward"].includes(t)) return 0;
  const thing = findItem(place, String(value)) ?? findSpot(place, String(value));
  return thing ? towards(at, thing.at) : undefined;
}

function wallItemFits(place: Place, placing: Placing, wall: Wall, along: number, elevation: number): boolean {
  return !wallTrouble(place, placing, wall, along, elevation);
}

function wallTrouble(place: Place, placing: Placing, wall: Wall, along: number, elevation: number): string | undefined {
  const [w] = footprintOf(placing);
  const h = heightOf(placing);
  const span = wall === "back" ? place.width : place.depth;
  if (Math.abs(along) > span / 2 - w / 2 - 0.05) return "It would run off the end of the wall.";
  if (elevation < 0.05 || elevation + h > place.height - 0.05)
    return "It wouldn't fit between the floor and the ceiling.";
  const ignore = placing.id ? carried(place, placing.id) : new Set<string>();
  for (const other of place.props) {
    if (ignore.has(other.id)) continue;
    const kind = KINDS[other.kind];
    const [ow] = footprintOf(other);
    if (kind?.mount === "wall") {
      if (wallOf(place, other) !== wall) continue;
      const otherAlong = wall === "back" ? other.at[0] : other.at[1];
      const oe = other.elevation ?? 0;
      const vertical = elevation < oe + heightOf(other) + 0.05 && oe < elevation + h + 0.05;
      if (vertical && Math.abs(otherAlong - along) < (w + ow) / 2 + 0.05) return `It would overlap ${other.name}.`;
    } else if (blocks(other) && heightOf(other) > elevation) {
      // A tall bookcase against the wall would hide it.
      const r = rectOf(other);
      const probe: Rect =
        wall === "back"
          ? { at: [along, -place.depth / 2 + 0.2], hw: w / 2, hd: 0.2, facing: 0 }
          : { at: [-place.width / 2 + 0.2, along], hw: 0.2, hd: w / 2, facing: 0 };
      if (overlaps(probe, r))
        return isHold(other) ? "It would hang over the door." : `${capital(other.name)} would hide it.`;
    }
  }
  const at = wallPoint(place, wall, along);
  return useTrouble(place, placing, { at, hw: w / 2, hd: 0.04, facing: WALL_FACING[wall] }, ignore);
}

/** Where on the floor plan a wall thing hangs: this far along the back or left wall. */
export function wallPoint(place: Place, wall: Wall, along: number): [number, number] {
  return wall === "back"
    ? [round(along), round(-place.depth / 2 + 0.01)]
    : [round(-place.width / 2 + 0.01), round(along)];
}

/** The wall a wall-mounted thing hangs on. */
function wallOf(place: Place, item: PlaceItem): Wall {
  return Math.abs(item.at[1] + place.depth / 2) < Math.abs(item.at[0] + place.width / 2) ? "back" : "left";
}

function placeOnWall(place: Place, placing: Placing, where: Where): Placement | string {
  const kind = KINDS[placing.kind];
  if (where.wall === "front" || where.wall === "right")
    return `The ${where.wall} side of the room is open, so there is no wall there to hang it on. Use the back or left wall.`;
  const near = where.near ? (findItem(place, where.near) ?? findSpot(place, where.near)) : undefined;
  if (where.near && !near) return `There's nothing called "${where.near}" in the room.`;
  const walls: Wall[] = where.wall
    ? [where.wall]
    : near
      ? Math.abs(near.at[1] + place.depth / 2) < Math.abs(near.at[0] + place.width / 2)
        ? ["back", "left"]
        : ["left", "back"]
      : ["back", "left"];
  const elevation = round((kind?.elevation ?? 1.2) - (heightOf(placing) - (kind?.height ?? 0)) / 2);
  for (const wall of walls) {
    const span = wall === "back" ? place.width : place.depth;
    const target = near ? (wall === "back" ? near.at[0] : near.at[1]) : 0;
    for (let d = 0; d <= span; d += 0.05) {
      for (const along of d === 0 ? [target] : [target + d, target - d]) {
        if (wallItemFits(place, placing, wall, round(along), elevation))
          return { at: wallPoint(place, wall, along), facing: WALL_FACING[wall], elevation };
      }
    }
  }
  return `There's no free stretch of ${where.wall ? `the ${where.wall} wall` : "wall"} wide enough for it.`;
}

function placeOn(place: Place, placing: Placing, baseWords: string | undefined, where: Where): Placement | string {
  const base = baseWords ? findItem(place, baseWords) : undefined;
  if (baseWords && !base) return `There's nothing called "${baseWords}" in the room.`;
  if (!base) {
    // Something that has to stand on something: the nearest surface to where it was asked for.
    const near = where.near ? (findItem(place, where.near) ?? findSpot(place, where.near)) : undefined;
    const from = near?.at ?? [0, 0];
    const surfaces = place.props
      .filter((p) => surfaceOf(p) !== undefined && p.id !== placing.id)
      .sort(
        (a, b) => Math.hypot(a.at[0] - from[0], a.at[1] - from[1]) - Math.hypot(b.at[0] - from[0], b.at[1] - from[1]),
      );
    for (const s of surfaces) {
      const got = placeOn(place, placing, s.id, where);
      if (typeof got !== "string") return got;
    }
    return "It needs something to stand on, like a desk, a table or a shelf, and there's no room on any of them.";
  }
  const top = surfaceOf(base);
  if (top === undefined) return `You can't put things on ${base.name}.`;
  if (placing.id && carried(place, placing.id).has(base.id)) return "It can't go on top of itself.";
  const [bw, bd] = footprintOf(base);
  const [w, d] = footprintOf(placing);
  if (w > bw + 0.001 || d > bd + 0.001) return `It's too big to fit on ${base.name}.`;
  const others = place.props.filter((p) => p.on === base.id && p.id !== placing.id);
  for (const [lx, lz] of around([0, 0], Math.max(bw, bd), 0.04)) {
    if (Math.abs(lx) > bw / 2 - w / 2 + 0.001 || Math.abs(lz) > bd / 2 - d / 2 + 0.001) continue;
    const at = offset(base.at, base.facing, lx, lz);
    const rect: Rect = { at, hw: w / 2, hd: d / 2, facing: base.facing };
    if (others.some((o) => overlaps(rect, rectOf(o), 0.01))) continue;
    const facing = facingFrom(place, where.facing, at) ?? base.facing;
    return { at, facing, elevation: top, on: base.id };
  }
  return `There's no room left on ${base.name}.`;
}

/**
 * Why a thing can't stand on top of another at exactly this point, as a
 * sentence; undefined when it can: the base has a top, the thing isn't
 * itself or under it, and it fits on the top, clear of what else is there.
 */
export function whyNotOnTop(place: Place, placing: Placing, baseId: string, at: [number, number]): string | undefined {
  const base = place.props.find((p) => p.id === baseId);
  if (!base) return "There's nothing there to put it on.";
  if (surfaceOf(base) === undefined) return `You can't put things on ${base.name}.`;
  if (placing.id && carried(place, placing.id).has(base.id)) return "It can't go on top of itself.";
  const [bw, bd] = footprintOf(base);
  const [w, d] = footprintOf(placing);
  if (w > bw + 0.001 || d > bd + 0.001) return `It's too big to fit on ${base.name}.`;
  const [lx, lz] = local(at, base.at, base.facing);
  if (Math.abs(lx) > bw / 2 - w / 2 + 0.001 || Math.abs(lz) > bd / 2 - d / 2 + 0.001)
    return `It would hang off the edge of ${base.name}.`;
  const rect: Rect = { at, hw: w / 2, hd: d / 2, facing: base.facing };
  const other = place.props.find((o) => o.on === base.id && o.id !== placing.id && overlaps(rect, rectOf(o), 0.01));
  return other ? `It would bump into ${other.name}.` : undefined;
}

/** How high up a thing's top is, for things that can hold others; undefined for one that can't, or isn't there. */
export function topOf(place: Place, id: string): number | undefined {
  const item = place.props.find((p) => p.id === id);
  return item ? surfaceOf(item) : undefined;
}

function placeOnFloor(place: Place, placing: Placing, where: Where): Placement | string {
  const kind = KINDS[placing.kind];
  const [w, d] = footprintOf(placing);
  const tryAt = (points: Iterable<[number, number]>, facingAt: (at: [number, number]) => number) => {
    for (const at of points) {
      const facing = facingAt(at);
      const turn = kind?.round ? 0 : facing;
      if (floorFits(place, placing, { at, hw: w / 2, hd: d / 2, facing: turn })) return { at, facing };
    }
    return undefined;
  };
  const explicit = (at: [number, number]) => facingFrom(place, where.facing, at);

  if (where.x !== undefined || where.z !== undefined) {
    const anchor: [number, number] = [where.x ?? 0, where.z ?? 0];
    const got = tryAt(around(anchor, 1.2), (at) => explicit(at) ?? 0);
    return got ?? `There's no room for it near (${anchor[0]}, ${anchor[1]}).`;
  }

  const alongWall = (wall: Wall, target?: number, within?: number) => {
    const facing = facingFrom(place, where.facing, [0, 0]) ?? WALL_FACING[wall];
    const span = wall === "back" || wall === "front" ? place.width : place.depth;
    // Its back to the wall, so its depth is what stands out from it, whichever wall.
    const inset = d / 2 + 0.02;
    const points: [number, number][] = [];
    const centre = target ?? 0;
    for (let s = 0; s <= Math.min(span, within ?? span); s += 0.05) {
      for (const a of s === 0 ? [centre] : [centre + s, centre - s]) {
        const p: [number, number] =
          wall === "back"
            ? [a, -place.depth / 2 + inset]
            : wall === "front"
              ? [a, place.depth / 2 - inset]
              : wall === "left"
                ? [-place.width / 2 + inset, a]
                : [place.width / 2 - inset, a];
        points.push([round(p[0]), round(p[1])]);
      }
    }
    return tryAt(points, () => facing);
  };

  const near = where.near ? (findItem(place, where.near) ?? findSpot(place, where.near)) : undefined;
  if (where.near && !near) return `There's nothing called "${where.near}" in the room.`;

  if (where.wall) {
    const target = near ? (where.wall === "back" || where.wall === "front" ? near.at[0] : near.at[1]) : undefined;
    return alongWall(where.wall, target) ?? `There's no room for it along the ${where.wall} wall.`;
  }

  if (where.corner) {
    const c = bare(where.corner);
    const sx = c.includes("right") ? 1 : -1;
    const sz = c.includes("front") ? 1 : -1;
    const anchor: [number, number] = [sx * (place.width / 2 - w / 2 - 0.05), sz * (place.depth / 2 - d / 2 - 0.05)];
    const got = tryAt(
      around(anchor, 1.5),
      (at) => explicit(at) ?? (kind?.wallward ? WALL_FACING[sz < 0 ? "back" : "front"] : towards(at, [0, 0])),
    );
    return got ?? `There's no room for it in the ${where.corner} corner.`;
  }

  if (near) {
    const item = "kind" in near ? (near as PlaceItem) : undefined;
    // Near the door is beside it: back to its wall if there is room, else either side of the way in, and only
    // then past the far end of it. The way in itself is held clear (`withDoorwayHeld`).
    const doorWall = item?.id === DOOR_HOLD && !where.side ? heldWall(place, item) : undefined;
    if (doorWall) {
      const along = doorWall === "back" || doorWall === "front" ? near.at[0] : near.at[1];
      const got = alongWall(doorWall, along, BESIDE_DOOR);
      if (got) return got;
    }
    const nearFacing = near.facing;
    const seatToFocus = !!kind?.use && kind.use.activity === "sit" && !!item && !!KINDS[item.kind]?.focus;
    const all: Side[] = ["left", "right", "front", "behind"];
    const tiers: Side[][] = where.side
      ? [[where.side]]
      : doorWall
        ? [doorWall === "back" || doorWall === "front" ? ["left", "right"] : ["front", "behind"], all]
        : [all];
    const facingAt = (at: [number, number]) =>
      explicit(at) ?? (seatToFocus ? towards(at, near.at) : doorWall ? WALL_FACING[doorWall] : nearFacing);
    let best: { at: [number, number]; facing: number; dist: number } | undefined;
    // The nearest place in the first tier of sides that has room at all.
    for (const sides of tiers) {
      for (const side of sides) {
        const [dx, dz] = SIDE_DIR[side];
        const [nw, nd] = item ? footprintOf(item) : [0.3, 0.3];
        const gap = dx !== 0 ? nw / 2 + w / 2 + 0.06 : nd / 2 + d / 2 + 0.06;
        const points: [number, number][] = [];
        for (let out = 0; out <= 1.6; out += 0.05) {
          for (let lateral = 0; lateral <= 0.8; lateral += 0.05) {
            for (const l of lateral === 0 ? [0] : [lateral, -lateral]) {
              const lx = dx !== 0 ? dx * (gap + out) : l;
              const lz = dz !== 0 ? dz * (gap + out) : l;
              points.push(offset(near.at, nearFacing, lx, lz));
            }
          }
          if (points.length > 2000) break;
        }
        const got = tryAt(points, facingAt);
        if (got) {
          const dist = Math.hypot(got.at[0] - near.at[0], got.at[1] - near.at[1]);
          if (!best || dist < best.dist) best = { ...got, dist };
        }
      }
      if (best) break;
    }
    if (best) return { at: best.at, facing: best.facing };
    return `There's no room for it ${where.side ? `on the ${where.side} of` : "near"} ${"name" in near ? near.name : "there"}.`;
  }

  if (where.middle) {
    const got = tryAt(around([0, 0.2], 2.5), (at) => explicit(at) ?? 0);
    return got ?? "There's no room for it in the middle of the room.";
  }

  if (kind?.wallward) {
    for (const wall of ["back", "left", "right"] as Wall[]) {
      const got = alongWall(wall);
      if (got) return got;
    }
  }
  // Anywhere in the room, out to its corners, nearest the middle first.
  const got = tryAt(
    around([0, 0], Math.max(3.5, Math.hypot(place.width, place.depth) / 2)),
    (at) => explicit(at) ?? (kind?.use?.activity === "sit" ? towards(at, [0, 0.6]) : 0),
  );
  return got ?? "The room is too full for it. Remove something, or make the room bigger.";
}

/** Where something can go, from the tool's words; a sentence saying why not when it can't. */
export function findPlacement(place: Place, placing: Placing, where: Where): Placement | string {
  const kind = KINDS[placing.kind];
  if (!kind) return `There's no kind of thing called "${placing.kind}".`;
  if (kind.mount === "wall") {
    if (where.on) return `A ${kind.noun} goes on a wall, not on top of something.`;
    return placeOnWall(place, placing, where);
  }
  if (where.on || kind.mount === "on") return placeOn(place, placing, where.on, where);
  return placeOnFloor(place, placing, where);
}

// --------------------------------------------------------------------------
// Changing the room
// --------------------------------------------------------------------------

/** Move an item, carrying what stands on it. */
export function moveItem(place: Place, id: string, to: Placement): Place {
  const item = place.props.find((p) => p.id === id);
  if (!item) return place;
  const byId = new Map(place.props.map((p) => [p.id, p]));
  const next: PlaceItem = { ...item, at: to.at, facing: normalizeFacing(to.facing) };
  if (to.elevation !== undefined) next.elevation = to.elevation;
  else delete next.elevation;
  if (to.on) next.on = to.on;
  else delete next.on;
  const moved = new Map<string, PlaceItem>([[id, next]]);
  // Riders keep their place on whatever they stand on, bases first.
  const pending = [...carried(place, id)].filter((r) => r !== id);
  for (let progress = true; pending.length && progress; ) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const rider = byId.get(pending[i]) as PlaceItem;
      const base = byId.get(rider.on as string) as PlaceItem;
      const after = moved.get(base.id);
      if (!after) continue;
      const [lx, lz] = local(rider.at, base.at, base.facing);
      moved.set(rider.id, {
        ...rider,
        at: offset(after.at, after.facing, lx, lz),
        facing: normalizeFacing(rider.facing + (after.facing - base.facing)),
        elevation: round((rider.elevation ?? 0) + (after.elevation ?? 0) - (base.elevation ?? 0)),
      });
      pending.splice(i, 1);
      progress = true;
    }
  }
  return withSpots({ ...place, props: place.props.map((p) => moved.get(p.id) ?? p) });
}

/** Remove an item and everything standing on it; returns the names of what went with it. */
export function removeItem(place: Place, id: string): { place: Place; removed: string[] } {
  const gone = carried(place, id);
  const removed = place.props.filter((p) => gone.has(p.id) && p.id !== id).map((p) => p.name);
  return { place: withSpots({ ...place, props: place.props.filter((p) => !gone.has(p.id)) }), removed };
}

/** A fresh id for a new thing of this kind. */
export function newId(place: Place, kind: string): string {
  const base = kind.replace(/[^a-z0-9]+/g, "-");
  if (!place.props.some((p) => p.id === base) && !place.spots.some((s) => s.id === base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!place.props.some((p) => p.id === id) && !place.spots.some((s) => s.id === id)) return id;
  }
}

/** A name nobody else in the room has: what was asked for, else "the green armchair", else "the armchair 2". */
export function newName(place: Place, kind: string, colorWord?: string, asked?: string): string {
  const taken = (n: string) => place.props.some((p) => bare(p.name) === bare(n));
  const pick = (base: string) => {
    if (!taken(base)) return base;
    for (let n = 2; ; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
  };
  if (asked?.trim()) return pick(/^(the|a|an|my|your)\s/i.test(asked.trim()) ? asked.trim() : `the ${asked.trim()}`);
  const noun = KINDS[kind]?.noun ?? kind;
  return pick(colorWord ? `the ${colorWord} ${noun}` : `the ${noun}`);
}

/**
 * The room at a new size, its contents moved with it: what stood against a
 * wall stays against it, the rest keeps its place in proportion. Undefined
 * with a reason when something would end up outside or on top of another.
 */
export function resize(place: Place, size: { width?: number; depth?: number; height?: number }): Place | string {
  const width = size.width ?? place.width;
  const depth = size.depth ?? place.depth;
  const height = size.height ?? place.height;
  const shiftX = (x: number, hw: number) => {
    if (x - hw - -place.width / 2 < 0.45) return x - (width - place.width) / 2;
    if (place.width / 2 - (x + hw) < 0.45) return x + (width - place.width) / 2;
    return (x * width) / place.width;
  };
  const shiftZ = (z: number, hd: number) => {
    if (z - hd - -place.depth / 2 < 0.45) return z - (depth - place.depth) / 2;
    if (place.depth / 2 - (z + hd) < 0.45) return z + (depth - place.depth) / 2;
    return (z * depth) / place.depth;
  };
  const byId = new Map(place.props.map((p) => [p.id, p]));
  const rootOf = (p: PlaceItem): PlaceItem => (p.on && byId.get(p.on) ? rootOf(byId.get(p.on) as PlaceItem) : p);
  const moves = new Map<string, [number, number]>();
  for (const p of place.props) {
    if (p.on) continue;
    const r = rectOf(p);
    const xs = corners(r).map(([x]) => x);
    const zs = corners(r).map(([, z]) => z);
    const hw = (Math.max(...xs) - Math.min(...xs)) / 2;
    const hd = (Math.max(...zs) - Math.min(...zs)) / 2;
    moves.set(p.id, [round(shiftX(p.at[0], hw) - p.at[0]), round(shiftZ(p.at[1], hd) - p.at[1])]);
  }
  const props = place.props.map((p) => {
    const [dx, dz] = moves.get(rootOf(p).id) ?? [0, 0];
    return { ...p, at: [round(p.at[0] + dx), round(p.at[1] + dz)] as [number, number] };
  });
  const spots = place.spots.map((s) =>
    s.item
      ? s
      : {
          ...s,
          at: [round((s.at[0] * width) / place.width), round((s.at[1] * depth) / place.depth)] as [number, number],
        },
  );
  const next = withSpots({ ...place, width, depth, height, props, spots });
  const problems = placeProblems(next);
  return problems.length ? `That size doesn't work: ${problems[0]}` : next;
}

/** Problems with a place's layout, as sentences; empty when it is sound. */
export function placeProblems(place: Place): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of place.props) {
    if (seen.has(item.id)) problems.push(`"${item.id}" is used twice.`);
    seen.add(item.id);
    if (!KINDS[item.kind]) problems.push(`${item.name} is a kind of thing the room can't draw ("${item.kind}").`);
    if (KINDS[item.kind]?.mount === "wall") {
      if (Math.abs(item.at[0]) > place.width / 2 || Math.abs(item.at[1]) > place.depth / 2)
        problems.push(`${item.name} would be off the wall.`);
      if ((item.elevation ?? 0) + heightOf(item) > place.height)
        problems.push(`${item.name} would go through the ceiling.`);
      continue;
    }
    if (item.on) continue;
    for (const [x, z] of corners(rectOf(item)))
      if (Math.abs(x) > place.width / 2 + 0.02 || Math.abs(z) > place.depth / 2 + 0.02) {
        problems.push(`${item.name} would be outside the room.`);
        break;
      }
    if (heightOf(item) > place.height) problems.push(`${item.name} is taller than the ceiling.`);
  }
  const floor = place.props.filter(blocks);
  for (let i = 0; i < floor.length; i++)
    for (let j = i + 1; j < floor.length; j++)
      if (
        overlaps(rectOf(floor[i]), rectOf(floor[j]), -0.02) &&
        !tucks(floor[i], rectOf(floor[i]), floor[j], rectOf(floor[j]))
      )
        problems.push(`${floor[i].name} and ${floor[j].name} would overlap.`);
  if (!place.spots.some((s) => s.id === place.start))
    problems.push(`The starting spot "${place.start}" doesn't exist.`);
  return problems;
}

// --------------------------------------------------------------------------
// Getting about
// --------------------------------------------------------------------------

/** Half a body's width: how far from furniture a walk keeps. */
const BODY = 0.2;

/**
 * The spots nobody can walk to from where everyone starts. The floor is a
 * grid, each piece of furniture grown by half a body's width, as the page
 * finds its way; the piece a spot belongs to keeps its true size, since a
 * spot can be close to it. A spot boxed in by furniture is one an agent is
 * sent to and never reaches. `only` checks just the spots with these ids.
 */
export function unreachable(place: Place, only?: string[]): PlaceSpot[] {
  const start = place.spots.find((s) => s.id === place.start);
  if (!start) return [];
  const cell = 0.1;
  const cols = Math.max(1, Math.ceil(place.width / cell));
  const rows = Math.max(1, Math.ceil(place.depth / cell));
  // Each piece as it stands, turned: a chair set at an angle leaves the floor in front of it free.
  const boxes = place.props.filter(blocks).map(rectOf);
  const inside = (r: Rect, point: [number, number], grow: number) => contains(r, point, grow - 1e-9);
  const centre = (i: number, j: number): [number, number] => [
    -place.width / 2 + (i + 0.5) * cell,
    -place.depth / 2 + (j + 0.5) * cell,
  ];
  const cellOf = ([x, z]: [number, number]) => [
    Math.min(cols - 1, Math.max(0, Math.floor((x + place.width / 2) / cell))),
    Math.min(rows - 1, Math.max(0, Math.floor((z + place.depth / 2) / cell))),
  ];
  // How many pieces, grown, cover each cell.
  const covered = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const c = centre(i, j);
      for (const b of boxes) if (inside(b, c, BODY)) covered[j * cols + i]++;
    }
  const stuck: PlaceSpot[] = [];
  for (const spot of place.spots) {
    if (spot.id === start.id || (only && !only.includes(spot.id))) continue;
    // Furniture the walk starts or ends beside keeps its own size.
    const near = boxes.filter((b) => inside(b, spot.at, BODY) || inside(b, start.at, BODY));
    const open = (i: number, j: number) => {
      const c = centre(i, j);
      let n = covered[j * cols + i];
      for (const b of near) {
        if (inside(b, c, 0)) return false;
        if (inside(b, c, BODY)) n--;
      }
      return n === 0;
    };
    const [si, sj] = cellOf(start.at);
    const [gi, gj] = cellOf(spot.at);
    const seen = new Uint8Array(cols * rows);
    seen[sj * cols + si] = 1;
    const queue: number[] = [sj * cols + si];
    let found = false;
    while (queue.length && !found) {
      const n = queue.pop() as number;
      const i = n % cols;
      const j = (n - i) / cols;
      for (const [ni, nj] of [
        [i + 1, j],
        [i - 1, j],
        [i, j + 1],
        [i, j - 1],
      ]) {
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows || seen[nj * cols + ni]) continue;
        if (ni === gi && nj === gj) {
          found = true;
          break;
        }
        if (!open(ni, nj)) continue;
        seen[nj * cols + ni] = 1;
        queue.push(nj * cols + ni);
      }
    }
    if (!found && !(si === gi && sj === gj)) stuck.push(spot);
  }
  return stuck;
}

// --------------------------------------------------------------------------
// Doorways
// --------------------------------------------------------------------------

/**
 * What a doorway needs: this much wall with nothing on it, and this much
 * floor in front of it with nothing standing there. The rooms the world
 * starts with each keep at least one such stretch clear (see
 * `places-rooms.ts`), so a door can go in later without moving anything.
 */
export const DOORWAY = { width: 1.6, depth: 1.0 };

/** A clear stretch of a solid wall: which wall, where its middle is along it (x on the back wall, z on the left), and how long it is. */
export interface Doorway {
  wall: "back" | "left";
  along: number;
  width: number;
}

/** Kept back from the corners, so a door never meets the other wall or the open side. */
const DOOR_END = 0.3;

/** How far a point on the floor is from one side of the room. */
function fromSide(place: Place, side: Wall, [x, z]: [number, number]): number {
  if (side === "back") return z + place.depth / 2;
  if (side === "front") return place.depth / 2 - z;
  if (side === "left") return x + place.width / 2;
  return place.width / 2 - x;
}

/** How long a side of the room is: the back and front run across it, the left and right from back to front. */
const sideSpan = (place: Place, side: Wall) => (side === "back" || side === "front" ? place.width : place.depth);

/**
 * The stretches of one side of the room wide enough for a doorway, as
 * [from, to] along it: nothing hangs there, and nothing stands on the floor in
 * front of it. Rugs don't count, since they can be walked over. Nothing hangs
 * on the open front and right, so there only the floor counts.
 */
function clearStretches(place: Place, side: Wall): [number, number][] {
  const span = sideSpan(place, side);
  const taken: [number, number][] = [];
  for (const item of place.props) {
    if (item.on) continue;
    if (KINDS[item.kind]?.mount === "wall") {
      if ((side !== "back" && side !== "left") || wallOf(place, item) !== side) continue;
      const along = side === "back" ? item.at[0] : item.at[1];
      const [w] = footprintOf(item);
      taken.push([along - w / 2, along + w / 2]);
      continue;
    }
    if (!blocks(item)) continue;
    const points = corners(rectOf(item));
    const out = Math.min(...points.map((p) => fromSide(place, side, p)));
    if (out >= DOORWAY.depth) continue;
    const alongs = points.map(([x, z]) => (side === "back" || side === "front" ? x : z));
    taken.push([Math.min(...alongs), Math.max(...alongs)]);
  }
  taken.sort((a, b) => a[0] - b[0]);
  let from = -span / 2 + DOOR_END;
  const free: [number, number][] = [];
  for (const [a, b] of taken) {
    if (a > from) free.push([from, a]);
    from = Math.max(from, b);
  }
  if (span / 2 - DOOR_END > from) free.push([from, span / 2 - DOOR_END]);
  return free.filter(([a, b]) => b - a >= DOORWAY.width - 1e-6);
}

/**
 * Every stretch of the back and left walls wide enough for a doorway, widest
 * first: nothing hangs there, and nothing stands on the floor in front of it.
 * Rugs don't count, since they can be walked over. A room an agent has
 * filled may have none.
 */
export function doorways(place: Place): Doorway[] {
  const found: Doorway[] = [];
  for (const wall of ["back", "left"] as const)
    for (const [a, b] of clearStretches(place, wall))
      found.push({ wall, along: round((a + b) / 2), width: round(b - a) });
  return found.sort((a, b) => b.width - a.width);
}

/** Where a door is: which side of the room, and its middle along it (x on the back and front, z on the left and right). */
export interface DoorSlot {
  wall: Wall;
  along: number;
}

/**
 * Where a room's door goes: in a clear stretch of the back or left wall, at
 * its end nearest the open side, which is where the rooms the world starts
 * with keep their doorway (see `places-rooms.ts`). A room whose walls are full
 * has its door at the open front or right edge instead, standing on its own;
 * one with no clear floor anywhere along its sides has none. The door depends
 * only on what is in the room, so the same room always has it in the same
 * place, and the `place` tool keeps furniture out of it (`withDoorwayHeld`).
 */
export function doorOf(place: Place): DoorSlot | undefined {
  const best = (sides: Wall[]): DoorSlot | undefined => {
    let found: (DoorSlot & { short: number }) | undefined;
    for (const side of sides)
      for (const [, b] of clearStretches(place, side)) {
        // How far short of the open side the stretch stops: nearest wins, the back wall on a tie.
        const short = sideSpan(place, side) / 2 - b;
        if (!found || short < found.short - 1e-6) found = { wall: side, along: round(b - DOORWAY.width / 2), short };
      }
    return found && { wall: found.wall, along: found.along };
  };
  return best(["back", "left"]) ?? best(["front", "right"]);
}

/**
 * How far into the room the `place` tool keeps the floor in front of a door
 * clear of anything new: room to come in and stand clear of the doorway, and
 * to walk up to the door square on. Deeper at the open front and right, where
 * you come in further so the gate's plate doesn't hide you. The page puts you
 * inside these (see `ARRIVE_IN` in the UI's `doors.ts`). Never more than half
 * the room, so a small one still has floor to furnish. The rooms the world
 * starts with only keep `DOORWAY.depth`, so they need no reflowing.
 */
export const DOOR_APPROACH = { wall: 1.6, open: 2.2 };

/** The id of the block that holds a doorway while something is placed, and its name, so "near the door" finds it. */
export const DOOR_HOLD = "doorway-hold";
/** How far along its wall from a door "near the door" looks before trying anywhere round it. */
const BESIDE_DOOR = 2.5;

/** The side of the room a door's hold stands against: the door's side. */
function heldWall(place: Place, hold: PlaceItem): Wall | undefined {
  const [w, d] = footprintOf(hold);
  const at = (a: number, b: number) => Math.abs(a - b) < 0.02;
  if (at(hold.at[1] - d / 2, -place.depth / 2)) return "back";
  if (at(hold.at[0] - w / 2, -place.width / 2)) return "left";
  if (at(hold.at[1] + d / 2, place.depth / 2)) return "front";
  if (at(hold.at[0] + w / 2, place.width / 2)) return "right";
  return undefined;
}

/** The floor in front of a door: as wide as the doorway with a little to spare, and `depth` deep. */
export function doorwayFloor(
  place: Place,
  door: DoorSlot,
  depth: number = DOORWAY.depth,
): { at: [number, number]; size: [number, number] } {
  const span = DOORWAY.width + 0.2;
  const d = depth;
  switch (door.wall) {
    case "back":
      return { at: [door.along, round(-place.depth / 2 + d / 2)], size: [span, d] };
    case "front":
      return { at: [door.along, round(place.depth / 2 - d / 2)], size: [span, d] };
    case "left":
      return { at: [round(-place.width / 2 + d / 2), door.along], size: [d, span] };
    case "right":
      return { at: [round(place.width / 2 - d / 2), door.along], size: [d, span] };
  }
}

/**
 * The room with its doorway held, for finding where something goes: a block
 * as tall as the room stands on the floor in front of the door, out as far as
 * its approach (`DOOR_APPROACH`), so nothing is put in the way, over it, or
 * where someone comes in or walks up to it. It is called "the door", so "near
 * the door" finds it and puts things beside it. What is found is put in the
 * room as it is, without the block.
 */
export function withDoorwayHeld(place: Place, door: DoorSlot | undefined = doorOf(place)): Place {
  return withDoorsHeld(place, door ? [door] : []);
}

/**
 * The room with each of these doorways held, as {@link withDoorwayHeld} holds
 * one: the lobby has several. The first is called "the door" with the id
 * `DOOR_HOLD`, the rest the same with a number after it.
 */
export function withDoorsHeld(place: Place, doors: DoorSlot[]): Place {
  if (!doors.length) return place;
  const holds = doors.map((door, i): PlaceItem => {
    const open = door.wall === "front" || door.wall === "right";
    const across = door.wall === "back" || door.wall === "front" ? place.depth : place.width;
    const { at, size } = doorwayFloor(
      place,
      door,
      Math.min(open ? DOOR_APPROACH.open : DOOR_APPROACH.wall, round(across / 2)),
    );
    // A shape with no top, so nothing is ever put on it.
    return {
      id: i ? `${DOOR_HOLD}-${i + 1}` : DOOR_HOLD,
      name: "the door",
      kind: "ball",
      at,
      facing: 0,
      size: [size[0], 9, size[1]],
    };
  });
  return { ...place, props: [...place.props.filter((p) => !isHold(p)), ...holds] };
}

/**
 * Problems with a room's doors, as sentences: a door off the end of its side,
 * two doors in each other's way, something standing in front of a door, or
 * hanging where it is. Empty when every door can be walked through.
 */
export function doorProblems(place: Place, doors: DoorSlot[]): string[] {
  const problems: string[] = [];
  const floorOf = (door: DoorSlot): Rect => {
    const { at, size } = doorwayFloor(place, door);
    // The door itself, without the spare the tool keeps either side of it.
    const along = door.wall === "back" || door.wall === "front";
    return { at, hw: along ? DOORWAY.width / 2 : size[0] / 2, hd: along ? size[1] / 2 : DOORWAY.width / 2, facing: 0 };
  };
  for (const [i, door] of doors.entries()) {
    const name = `The door ${doorWords(place, door)}`;
    if (Math.abs(door.along) > sideSpan(place, door.wall) / 2 - DOORWAY.width / 2 + 1e-6)
      problems.push(`${name} runs off the end of its side.`);
    for (const other of doors.slice(i + 1))
      if (overlaps(floorOf(door), floorOf(other), -0.01))
        problems.push(`${name} and the door ${doorWords(place, other)} are in each other's way.`);
    for (const item of place.props) {
      if (item.on) continue;
      if (KINDS[item.kind]?.mount === "wall") {
        if (door.wall !== wallOf(place, item) || (door.wall !== "back" && door.wall !== "left")) continue;
        const along = door.wall === "back" ? item.at[0] : item.at[1];
        if (Math.abs(along - door.along) < (footprintOf(item)[0] + DOORWAY.width) / 2 - 1e-6)
          problems.push(`${item.name} hangs where ${name.toLowerCase()} is.`);
      } else if (blocks(item) && overlaps(floorOf(door), rectOf(item), -0.01)) {
        problems.push(`${item.name} stands in front of ${name.toLowerCase()}.`);
      }
    }
  }
  return problems;
}

/** Where a door is, in words: "on the back wall, toward the right". */
export function doorWords(place: Place, door: DoorSlot): string {
  const span = sideSpan(place, door.wall);
  const part = door.along > span / 6 ? 1 : door.along < -span / 6 ? -1 : 0;
  const toward =
    door.wall === "back" || door.wall === "front"
      ? ["toward the left", "in the middle", "toward the right"][part + 1]
      : ["toward the back", "in the middle", "toward the front"][part + 1];
  const side =
    door.wall === "back" || door.wall === "left" ? `on the ${door.wall} wall` : `at the open ${door.wall} side`;
  return `${side}, ${toward}`;
}

// --------------------------------------------------------------------------
// Colours
// --------------------------------------------------------------------------

const COLORS: Record<string, string> = {
  red: "#c0392b",
  crimson: "#a8233a",
  maroon: "#7a2631",
  burgundy: "#7d2238",
  orange: "#e07b39",
  amber: "#e6a23c",
  gold: "#d4a72c",
  yellow: "#f2c14e",
  mustard: "#c99a2e",
  olive: "#7a7d3a",
  lime: "#9bc53d",
  green: "#4c8c4a",
  "forest green": "#2f5d3a",
  sage: "#9caf88",
  mint: "#a8dcc0",
  teal: "#2a8a8a",
  turquoise: "#3cb6b0",
  cyan: "#4bacc6",
  "sky blue": "#8cc4e8",
  blue: "#4f81bd",
  navy: "#2b3a66",
  indigo: "#4b3f8f",
  purple: "#8064a2",
  lavender: "#b9a7d6",
  violet: "#8a5cc2",
  magenta: "#b5408f",
  pink: "#e89ab0",
  rose: "#d77a8f",
  coral: "#ee7f6d",
  salmon: "#f19a83",
  peach: "#f6c3a0",
  beige: "#d9c7a0",
  cream: "#efe6d2",
  ivory: "#f6f1e3",
  tan: "#c8a27a",
  brown: "#8a5a3b",
  chocolate: "#5e3a26",
  walnut: "#6b4a33",
  oak: "#b5835a",
  white: "#f5f3ef",
  black: "#2a2a2e",
  charcoal: "#3b3f45",
  gray: "#8a8f96",
  grey: "#8a8f96",
  silver: "#c0c4ca",
  slate: "#5f6f7f",
};

function shade(hex: string, by: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number) => Math.round(by > 0 ? c + (255 - c) * by : c * (1 + by));
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** A colour from a name ("dark green") or hex; undefined when it isn't one. */
export function parseColor(input: string): string | undefined {
  const t = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${[...t.slice(1)].map((c) => c + c).join("")}`;
  const m = /^(light|pale|dark|deep)\s+(.+)$/.exec(t);
  const base = COLORS[m ? m[2] : t];
  if (!base) return undefined;
  if (!m) return base;
  return shade(base, m[1] === "light" || m[1] === "pale" ? 0.35 : -0.35);
}

/** The words a colour was given in, when it was a name: for naming the thing. */
export function colorWord(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const t = input.trim().toLowerCase();
  return t.startsWith("#") ? undefined : t;
}

// --------------------------------------------------------------------------
// Words
// --------------------------------------------------------------------------

function facingWords(degrees: number): string {
  const a = normalizeFacing(degrees);
  if (Math.abs(a) <= 30) return "facing the front";
  if (Math.abs(a) >= 150) return "facing the back wall";
  return a > 0 ? "facing right" : "facing left";
}

/** Where a thing is, in words: "against the back wall, back left". */
export function whereWords(place: Place, item: PlaceItem): string {
  if (item.on) {
    const base = place.props.find((p) => p.id === item.on);
    return base ? `on ${base.name}` : "on something";
  }
  if (KINDS[item.kind]?.mount === "wall") return `on the ${wallOf(place, item)} wall`;
  const [x, z] = item.at;
  const across = x < -place.width / 6 ? "left" : x > place.width / 6 ? "right" : "";
  const deep = z < -place.depth / 6 ? "back" : z > place.depth / 6 ? "front" : "";
  const region = deep || across ? `${deep}${deep && across ? " " : ""}${across}` : "the middle";
  const xs = corners(rectOf(item)).map(([cx]) => cx);
  const zs = corners(rectOf(item)).map(([, cz]) => cz);
  const against: string[] = [];
  if (Math.min(...zs) + place.depth / 2 < 0.12) against.push("back");
  if (Math.min(...xs) + place.width / 2 < 0.12) against.push("left");
  const wall = against.length ? `against the ${against.join(" and ")} wall${against.length > 1 ? "s" : ""}, ` : "";
  return `${wall}${region}, ${facingWords(item.facing)}`;
}

function sizeWords(item: PlaceItem): string {
  if (KINDS[item.kind]?.shaped && item.size) return `, ${item.size.join(" × ")} m`;
  return item.scale && item.scale !== 1 ? `, ${item.scale}× size` : "";
}

/** The room in words, for the agent: what it is like, what is in it, where you can go, what you can add. */
export function describe(place: Place): string {
  const lines = [
    `${place.name}: ${place.width} m wide, ${place.depth} m deep, ${place.height} m high, ${place.walls ?? "plain"} walls, ${place.floor ?? "wood"} floor${place.floorColor ? ` (${place.floorColor})` : ""}. The back and left walls are solid; the front and right sides are open to the viewer.`,
    ...(place.purpose ? [`It is for: ${place.purpose}`] : []),
    ...(place.theme ? [`Its theme: ${place.theme === "none" ? "none, plain" : place.theme}.`] : []),
    ...(place.changes?.length
      ? [
          `Lately: ${place.changes
            .slice(0, 3)
            .map((c) => `${c.who} ${c.what}`)
            .join("; ")}.`,
        ]
      : []),
    "",
    "Things (id: name, where):",
    ...place.props.map(
      (p) =>
        `- ${p.id}: ${p.name} (${KINDS[p.kind]?.noun ?? p.kind}${p.color ? `, ${p.color}` : ""}${sizeWords(p)}), ${whereWords(place, p)}, at (${p.at[0]}, ${p.at[1]})`,
    ),
    "",
    `Spots you can go to: ${place.spots.map((s) => s.place).join(", ")}.`,
    "",
    "Kinds you can add:",
    `- floor: ${kindsBy((k) => k.mount === "floor" && !k.shaped)}`,
    `- wall: ${kindsBy((k) => k.mount === "wall")}`,
    `- on a surface: ${kindsBy((k) => k.mount === "on")}`,
    `- shapes, any size and colour: ${kindsBy((k) => !!k.shaped)}`,
  ];
  return lines.join("\n");
}

function kindsBy(test: (k: Kind) => boolean): string {
  return Object.entries(KINDS)
    .filter(([, k]) => test(k))
    .map(([id]) => id)
    .join(", ");
}

// --------------------------------------------------------------------------
// The record's shape, for world state
// --------------------------------------------------------------------------

const point = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } as const;

/** The `place` type's schema: enough to keep a hand edit from breaking the drawing. */
export const PLACE_SCHEMA = {
  type: "object",
  required: ["name", "width", "depth", "height", "props", "spots", "start"],
  properties: {
    name: { type: "string", maxLength: 80 },
    width: { type: "number", minimum: LIMITS.width[0], maximum: LIMITS.width[1] },
    depth: { type: "number", minimum: LIMITS.depth[0], maximum: LIMITS.depth[1] },
    height: { type: "number", minimum: LIMITS.height[0], maximum: LIMITS.height[1] },
    walls: { type: "string", pattern: "^#[0-9a-f]{6}$" },
    floor: { type: "string", enum: FLOORS },
    floorColor: { type: "string", pattern: "^#[0-9a-f]{6}$" },
    start: { type: "string" },
    area: { type: "string", maxLength: 60 },
    theme: { type: "string", maxLength: 40 },
    purpose: { type: "string", maxLength: 160 },
    changes: {
      type: "array",
      maxItems: CHANGES_KEPT,
      items: {
        type: "object",
        required: ["who", "what", "at"],
        properties: {
          who: { type: "string", maxLength: 80 },
          what: { type: "string", maxLength: CHANGE_LENGTH },
          at: { type: "string" },
          person: { type: "boolean" },
        },
      },
    },
    photos: {
      type: "array",
      maxItems: PHOTOS_KEPT,
      items: {
        type: "object",
        required: ["media", "what", "at"],
        properties: {
          media: { type: "string", maxLength: 128 },
          what: { type: "string", maxLength: 80 },
          at: { type: "string" },
        },
      },
    },
    props: {
      type: "array",
      maxItems: LIMITS.items,
      items: {
        type: "object",
        required: ["id", "name", "kind", "at", "facing"],
        properties: {
          id: { type: "string", maxLength: 64 },
          name: { type: "string", maxLength: 80 },
          kind: { type: "string", enum: Object.keys(KINDS) },
          at: point,
          facing: { type: "number" },
          elevation: { type: "number", minimum: 0 },
          spot: { type: "string" },
          on: { type: "string" },
          color: { type: "string", pattern: "^#[0-9a-f]{6}$" },
          scale: { type: "number", minimum: LIMITS.scale[0], maximum: LIMITS.scale[1] },
          size: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          label: { type: "string", maxLength: 40 },
          action: { type: "string", enum: PLACE_ACTIONS },
        },
      },
    },
    spots: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "place", "at", "facing"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          place: { type: "string" },
          at: point,
          facing: { type: "number" },
          activity: { type: "string", enum: ["sit", "type", "look", "browse"] },
          item: { type: "string" },
        },
      },
    },
  },
};
