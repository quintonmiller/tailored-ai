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
}

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
};

export const LIMITS = {
  width: [2.5, 8] as const,
  depth: [2.5, 8] as const,
  height: [2.2, 3.5] as const,
  scale: [0.5, 2] as const,
  /** Each side of a basic shape. */
  side: [0.05, 2.5] as const,
  items: 60,
};

/** The room a new place starts as: the one the avatar first lived in. */
export function defaultPlace(name = "your room"): Place {
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

/**
 * A room for a conversation several agents share: a long table with a seat
 * for each, a window, a plant, a picture on the back wall. Wider the more
 * seats it has. Seats face the table, half on each side.
 */
/**
 * How a room for a purpose looks, picked by the words in its name and purpose:
 * a trip by the sea, a workshop, a studio, a tavern, a library. A room whose
 * words match none is plain.
 */
export interface Theme {
  id: string;
  words: RegExp;
  walls: string;
  floor: Floor;
  floorColor?: string;
}

export const THEMES: Theme[] = [
  {
    id: "beach",
    words: /\b(beach|vacation|holiday|trip|travel|surf|island|tropic|seaside)/i,
    walls: "#cfe8f0",
    floor: "tile",
    floorColor: "#e6d3a3",
  },
  {
    id: "tavern",
    words: /\b(d&d|dnd|campaign|quest|tavern|dungeon|adventure|rpg)/i,
    walls: "#6e4e38",
    floor: "wood",
  },
  { id: "studio", words: /\b(podcast|music|audio|studio|record|episode)/i, walls: "#3d3648", floor: "carpet" },
  {
    id: "workshop",
    words: /\b(code|coder|coding|dev|engineer|build|deploy|bug|ops|review|repo)/i,
    walls: "#d3d7dc",
    floor: "concrete",
  },
  { id: "library", words: /\b(research|study|read|book|library|learn|notes)/i, walls: "#e8dfcf", floor: "wood" },
];

/** The theme the words of a room's name and purpose call for, if any. */
export function themeFor(words: string): Theme | undefined {
  return THEMES.find((t) => t.words.test(words));
}

export function meetingRoom(name: string, seats: number, purpose = ""): Place {
  const n = Math.max(2, Math.min(16, Math.floor(seats)));
  const perSide = Math.ceil(n / 2);
  const spacing = 1.0;
  const tables = Math.max(1, Math.ceil((perSide * spacing) / 1.2));
  const tableRow = tables * 1.2;
  const width = round(Math.max(4.6, Math.max(perSide * spacing, tableRow) + 2.2));
  const depth = 4.2;
  const tableZ = -0.2;
  const props: PlaceItem[] = [
    { id: "rug", name: "the rug", kind: "rug", at: [0, tableZ], facing: 0, scale: Math.min(1.6, 0.8 + tables * 0.4) },
  ];
  for (let i = 0; i < tables; i++) {
    const x = round(-tableRow / 2 + 0.6 + i * 1.2);
    props.push({
      id: `table-${i + 1}`,
      name: tables > 1 ? `table ${i + 1}` : "the table",
      kind: "table",
      at: [x, tableZ],
      facing: 0,
    });
  }
  for (let i = 0; i < n; i++) {
    const far = i % 2 === 0;
    const k = Math.floor(i / 2);
    const row = far ? perSide : n - perSide;
    const x = round((k - (row - 1) / 2) * spacing);
    // Far side faces +Z, toward the table and the camera; the near side faces back.
    props.push({
      id: `seat-${i + 1}`,
      name: `seat ${i + 1}`,
      kind: "armchair",
      at: [x, far ? round(tableZ - 1.25) : round(tableZ + 1.25)],
      facing: far ? 0 : 180,
    });
  }
  const theme = themeFor(`${name} ${purpose}`);
  props.push(
    {
      id: "window",
      name: "the window",
      kind: "window",
      at: [round(-width / 2 + 0.01), -0.4],
      facing: 90,
      elevation: 1.0,
    },
    // The room's tasks on the back wall.
    {
      id: "board",
      name: "the task board",
      kind: "board",
      at: [0, round(-depth / 2 + 0.03)],
      facing: 0,
      elevation: 1.05,
      label: "Tasks",
      action: "tasks",
    },
    {
      id: "plant",
      // By the sea, a palm.
      name: theme?.id === "beach" ? "the palm" : "the plant",
      kind: theme?.id === "beach" ? "palm" : "plant",
      at: [round(width / 2 - 0.4), round(-depth / 2 + 0.4)],
      facing: 0,
    },
    // Lamps, back left and on the right wall, clear of the camera at the open front: a room with none is dark after sunset.
    { id: "lamp", name: "the lamp", kind: "lamp", at: [round(-width / 2 + 0.3), round(-depth / 2 + 0.3)], facing: 0 },
    {
      id: "lamp-2",
      name: "the other lamp",
      kind: "lamp",
      at: [round(width / 2 - 0.3), round(-depth / 2 + 1.1)],
      facing: 0,
    },
  );
  if (theme?.id === "beach")
    props.push({
      id: "umbrella",
      name: "the beach umbrella",
      kind: "umbrella",
      at: [round(-width / 2 + 0.8), round(depth / 2 - 0.8)],
      facing: 0,
      color: "#e85d4a",
    });
  if (theme?.id === "tavern")
    for (let i = 0; i < tables; i++)
      props.push({
        id: `candle-${i + 1}`,
        name: tables > 1 ? `candle ${i + 1}` : "the candle",
        kind: "candle",
        at: [round(-tableRow / 2 + 0.6 + i * 1.2), tableZ],
        facing: 0,
        elevation: 0.75,
        on: `table-${i + 1}`,
      });
  return withSpots({
    name,
    width,
    depth,
    height: 2.6,
    walls: theme?.walls ?? "#dfe4ea",
    floor: theme?.floor ?? "carpet",
    ...(theme?.floorColor ? { floorColor: theme.floorColor } : {}),
    props,
    spots: [
      {
        id: "head",
        name: "at the head of the table",
        place: "the head of the table",
        at: [round(tableRow / 2 + 0.55), tableZ],
        facing: -90,
      },
    ],
    start: "head",
  });
}

/** The lobby's id on the map. */
export const LOBBY = "lobby";

/**
 * Where everyone starts: kiosks to make a new agent, a new task or a new room,
 * a board of every open task, and somewhere to sit.
 */
export function lobby(): Place {
  const width = 7;
  const depth = 5;
  const kiosk = (id: string, x: number, label: string, action: PlaceAction): PlaceItem => ({
    id,
    name: `the ${label.toLowerCase()} kiosk`,
    kind: "kiosk",
    at: [x, round(-depth / 2 + 0.6)],
    facing: 0,
    label,
    action,
  });
  return withSpots({
    name: "the lobby",
    width,
    depth,
    height: 2.8,
    walls: "#e4e1ec",
    floor: "tile",
    floorColor: "#cfd3dc",
    props: [
      { id: "rug", name: "the rug", kind: "rug", at: [0, 0.4], facing: 0, scale: 1.4 },
      kiosk("kiosk-agent", -1.9, "New agent", "new-agent"),
      kiosk("kiosk-task", 0, "New task", "new-task"),
      kiosk("kiosk-room", 1.9, "New room", "new-room"),
      {
        id: "board",
        name: "the task board",
        kind: "board",
        at: [round(width / 2 - 0.03), -0.3],
        facing: -90,
        elevation: 1.05,
        label: "Open tasks",
        action: "tasks",
      },
      {
        id: "window",
        name: "the window",
        kind: "window",
        at: [round(-width / 2 + 0.01), -0.6],
        facing: 90,
        elevation: 1.0,
      },
      { id: "couch", name: "the couch", kind: "couch", at: [round(-width / 2 + 0.45), 0.85], facing: 90 },
      {
        id: "plant",
        name: "the plant",
        kind: "plant",
        at: [round(width / 2 - 0.4), round(-depth / 2 + 0.4)],
        facing: 0,
      },
      {
        id: "plant-2",
        name: "the other plant",
        kind: "plant",
        at: [round(-width / 2 + 0.4), round(-depth / 2 + 0.4)],
        facing: 0,
      },
      { id: "lamp", name: "the lamp", kind: "lamp", at: [round(width / 2 - 0.35), round(depth / 2 - 0.9)], facing: 0 },
      {
        id: "lamp-2",
        name: "the other lamp",
        kind: "lamp",
        at: [round(-width / 2 + 0.35), round(depth / 2 - 0.35)],
        facing: 0,
      },
    ],
    spots: [{ id: "middle", name: "in the middle", place: "the middle of the lobby", at: [0, 0.6], facing: 180 }],
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
    chair.kind === "chair" && (table.kind === "desk" || table.kind === "table") && !contains(rt, chair.at);
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

/** The spot words refer to: its place ("the couch"), its name ("on the couch") or its id. */
export function findSpot(place: Place, words: string): PlaceSpot | undefined {
  const t = bare(words);
  return place.spots.find((s) => [s.place, s.name, s.id].some((n) => bare(n) === t));
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

/** Whether a floor thing fits here: inside, clear of the rest, and not standing on anyone's spot. */
function floorFits(place: Place, placing: Placing, rect: Rect): boolean {
  const kind = KINDS[placing.kind];
  const ignore = placing.id ? carried(place, placing.id) : new Set<string>();
  const margin = 0.01;
  for (const [x, z] of corners(rect))
    if (Math.abs(x) > place.width / 2 - margin || Math.abs(z) > place.depth / 2 - margin) return false;
  if (kind?.walkable) return true;
  for (const other of place.props) {
    if (ignore.has(other.id) || !blocks(other)) continue;
    const ro = rectOf(other);
    if (overlaps(rect, ro, 0.03) && !tucks({ kind: placing.kind, at: rect.at }, rect, other, ro)) return false;
  }
  for (const spot of place.spots) {
    if (spot.item && ignore.has(spot.item)) continue;
    if (contains(rect, spot.at, 0.18)) return false;
  }
  // A tall thing against a wall must not cover a window or picture there.
  const tall = heightOf(placing);
  for (const other of place.props) {
    if (ignore.has(other.id) || KINDS[other.kind]?.mount !== "wall") continue;
    const w = rectOf(other);
    if (tall > (other.elevation ?? 0) && overlaps({ ...rect }, { ...w, hd: w.hd + 0.25 })) return false;
  }
  return useFits(place, placing, rect, ignore);
}

/** The spot a thing brings must be somewhere the avatar can stand. */
function useFits(place: Place, placing: Placing, rect: Rect, ignore: Set<string>): boolean {
  const use = KINDS[placing.kind]?.use;
  if (!use) return true;
  const [sx, sz] = offset(rect.at, rect.facing, 0, use.offset * (placing.scale ?? 1));
  const m = 0.15;
  if (Math.abs(sx) > place.width / 2 - m || Math.abs(sz) > place.depth / 2 - m) return false;
  for (const other of place.props) {
    if (ignore.has(other.id) || !blocks(other)) continue;
    if (contains(rectOf(other), [sx, sz], 0.15)) return false;
  }
  return true;
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
  const [w] = footprintOf(placing);
  const h = heightOf(placing);
  const span = wall === "back" ? place.width : place.depth;
  if (Math.abs(along) > span / 2 - w / 2 - 0.05) return false;
  if (elevation < 0.05 || elevation + h > place.height - 0.05) return false;
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
      if (vertical && Math.abs(otherAlong - along) < (w + ow) / 2 + 0.05) return false;
    } else if (blocks(other) && heightOf(other) > elevation) {
      // A tall bookcase against the wall would hide it.
      const r = rectOf(other);
      const probe: Rect =
        wall === "back"
          ? { at: [along, -place.depth / 2 + 0.2], hw: w / 2, hd: 0.2, facing: 0 }
          : { at: [-place.width / 2 + 0.2, along], hw: 0.2, hd: w / 2, facing: 0 };
      if (overlaps(probe, r)) return false;
    }
  }
  const at = wallPoint(place, wall, along);
  return useFits(place, placing, { at, hw: w / 2, hd: 0.04, facing: WALL_FACING[wall] }, ignore);
}

function wallPoint(place: Place, wall: Wall, along: number): [number, number] {
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

  const alongWall = (wall: Wall, target?: number) => {
    const facing = facingFrom(place, where.facing, [0, 0]) ?? WALL_FACING[wall];
    const span = wall === "back" || wall === "front" ? place.width : place.depth;
    // Its back to the wall, so its depth is what stands out from it, whichever wall.
    const inset = d / 2 + 0.02;
    const points: [number, number][] = [];
    const centre = target ?? 0;
    for (let s = 0; s <= span; s += 0.05) {
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
    const nearFacing = near.facing;
    const seatToFocus = !!kind?.use && kind.use.activity === "sit" && !!item && !!KINDS[item.kind]?.focus;
    const sides: Side[] = where.side ? [where.side] : ["left", "right", "front", "behind"];
    let best: { at: [number, number]; facing: number; dist: number } | undefined;
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
      const got = tryAt(points, (at) => explicit(at) ?? (seatToFocus ? towards(at, near.at) : nearFacing));
      if (got) {
        const dist = Math.hypot(got.at[0] - near.at[0], got.at[1] - near.at[1]);
        if (!best || dist < best.dist) best = { ...got, dist };
      }
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
  const got = tryAt(
    around([0, 0], 3.5),
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
