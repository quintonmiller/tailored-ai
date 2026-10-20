/**
 * The rooms the world starts with: each agent's home, drawn from a seed so no
 * two are alike; a meeting room for each room agents talk in, sized by who is
 * in it and dressed for what it is for; and the lobby, the biggest room, where
 * everyone starts.
 *
 * Rooms are put together the way an agent furnishes one, piece by piece, each
 * checked with the rules the `place` tool keeps: nothing overlaps, nothing
 * stands where the avatar needs to stand, a tall thing never hides a window.
 * Furniture that belongs together (a desk with its chair and lamp, a couch
 * with a coffee table, two armchairs by a fire) comes as a group laid out
 * against a wall, and a preset (a study, a studio, a lounge, a workshop, a
 * reading nook, a garden room, a bedsit, a den) says which groups go on which
 * wall. The seed picks the preset (unless what the agent is for asks for one,
 * from `places-roles.ts`, with something in it for the work), the room's
 * proportions and colours, which way each group runs, and where the doorway is. Every room keeps a stretch of
 * wall clear for a door, which `doorways` in `places-layout.ts` finds.
 *
 * Pure, like `places-layout.ts`: the same seed always gives the same room.
 */
import {
  DOORWAY,
  type DoorSlot,
  type Floor,
  findPlacement,
  fitsOnFloor,
  fitsOnWall,
  footprintOf,
  heightOf,
  KINDS,
  LIMITS,
  newId,
  newName,
  normalizeFacing,
  PHOTO_FRAMES,
  type Place,
  type PlaceAction,
  type PlaceItem,
  type PlaceSpot,
  type Placing,
  placeProblems,
  removeItem,
  unreachable,
  wallPoint,
  withDoorwayHeld,
  withSpots,
} from "./places-layout.js";

// --------------------------------------------------------------------------
// Chance, from a seed
// --------------------------------------------------------------------------

/** Numbers in [0, 1) from a string: the same seed gives the same sequence, every time and everywhere. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const round = (n: number) => Math.round(n * 100) / 100;

// --------------------------------------------------------------------------
// Pieces and groups
// --------------------------------------------------------------------------

/** The colours a room is furnished in, and how big its windows are. */
interface Look {
  fabric: string;
  /** A second fabric, for chairs that go with a couch. */
  fabric2: string;
  wood: string;
  rug: string;
  /** Paintings and posters. */
  accent: string;
  window: number;
}

/**
 * One piece of a group, in the group's own frame: `u` metres along the wall
 * from the group's middle, toward the open side of the room, and `v` out from
 * the wall to the piece's middle (back against the wall when left out). A
 * facing of 0 looks into the room, 180 at the wall. A wall thing hangs at its
 * kind's height unless given one.
 */
interface Piece {
  kind: string;
  /** Its id, when something else names it ("table-1"); one is made otherwise. */
  id?: string;
  /** What it is called; "the <noun>" otherwise. */
  name?: string;
  u?: number;
  v?: number;
  facing?: number;
  elevation?: number;
  /** A name for it within the group, so others can stand `on` it. */
  key?: string;
  on?: string;
  color?: string;
  scale?: number;
  size?: [number, number, number];
  label?: string;
  action?: PlaceAction;
}

/** Furniture that belongs together, and how much wall it takes. */
interface Group {
  width: number;
  pieces: (look: Look) => Piece[];
}

const GROUPS = {
  desk: {
    width: 1.9,
    pieces: (l) => [
      { key: "desk", kind: "desk", color: l.wood },
      { kind: "laptop", on: "desk" },
      { kind: "table_lamp", name: "the desk lamp", on: "desk" },
      // Pulled out beside the desk, the way the first room had it: the avatar types standing.
      { kind: "chair", name: "the desk chair", u: -0.63, v: 0.9, facing: 200 },
      { key: "shelf", kind: "shelf", elevation: 1.5 },
      { kind: "books", on: "shelf" },
      { kind: "small_plant", on: "shelf" },
    ],
  },
  board: {
    width: 2.0,
    pieces: () => [
      { kind: "board", label: "Tasks", action: "tasks" },
      { kind: "plant", u: 1.0 },
    ],
  },
  couch: {
    width: 2.7,
    pieces: (l) => [
      { kind: "couch", color: l.fabric },
      { key: "side", kind: "side_table", u: -1.1, color: l.wood },
      { kind: "table_lamp", on: "side" },
      { kind: "plant", u: 1.12 },
      { kind: "painting", color: l.accent },
    ],
  },
  lounge: {
    width: 3.8,
    pieces: (l) => [
      { kind: "rug", v: 1.45, scale: 1.25, color: l.rug },
      { kind: "couch", color: l.fabric },
      { key: "table", kind: "coffee_table", v: 1.65, color: l.wood },
      { kind: "mug", on: "table" },
      { kind: "books", on: "table" },
      { kind: "armchair", u: -1.45, v: 1.65, facing: 90, color: l.fabric2 },
      { kind: "armchair", u: 1.45, v: 1.65, facing: -90, color: l.fabric2 },
      { kind: "lamp", name: "the floor lamp", u: -1.2 },
      { kind: "painting", color: l.accent },
    ],
  },
  fireside: {
    width: 2.9,
    pieces: (l) => [
      { kind: "rug", v: 1.55, color: l.rug },
      { key: "fire", kind: "fireplace" },
      { kind: "candle", on: "fire" },
      { kind: "small_plant", on: "fire" },
      { kind: "armchair", u: -0.95, v: 2.0, facing: 155, color: l.fabric },
      { kind: "armchair", u: 0.95, v: 2.0, facing: -155, color: l.fabric },
      { kind: "painting", color: l.accent, elevation: 1.55 },
    ],
  },
  media: {
    width: 2.6,
    pieces: (l) => [
      { kind: "tv" },
      { kind: "plant", u: -1.0 },
      { kind: "tall_plant", u: 1.05 },
      { kind: "rug", v: 2.0, color: l.rug },
      { kind: "couch", v: 2.75, facing: 180, color: l.fabric },
    ],
  },
  bed: {
    width: 2.5,
    pieces: (l) => [
      { kind: "bed", color: l.fabric },
      { key: "left", kind: "side_table", name: "the bedside table", u: -1.0, color: l.wood },
      { kind: "table_lamp", name: "the bedside lamp", on: "left" },
      { key: "right", kind: "side_table", name: "the other bedside table", u: 1.0, color: l.wood },
      { kind: "books", on: "right" },
      { kind: "picture", elevation: 1.5 },
    ],
  },
  books: {
    width: 2.4,
    pieces: (l) => [
      { kind: "bookshelf", u: -0.7, color: l.wood },
      { kind: "bookshelf", name: "the other bookshelf", u: 0.25, color: l.wood },
      { kind: "plant", u: 1.0 },
      { kind: "clock", u: -0.22, elevation: 2.05 },
    ],
  },
  reading: {
    width: 2.0,
    pieces: (l) => [
      { kind: "rug", v: 1.0, scale: 0.75, color: l.rug },
      { kind: "armchair", name: "the reading chair", v: 0.55, color: l.fabric2 },
      { kind: "lamp", name: "the reading lamp", u: -0.78 },
      { key: "table", kind: "side_table", u: 0.75, v: 0.35, color: l.wood },
      { kind: "books", on: "table" },
      { kind: "poster", color: l.accent, elevation: 1.45 },
    ],
  },
  sideboard: {
    width: 1.8,
    pieces: (l) => [
      { key: "top", kind: "sideboard", color: l.wood },
      { kind: "vase", on: "top" },
      { kind: "table_lamp", on: "top" },
      { kind: "books", on: "top" },
      { kind: "painting", color: l.accent },
    ],
  },
  aquarium: {
    width: 1.8,
    pieces: (l) => [
      { key: "top", kind: "sideboard", color: l.wood },
      { kind: "aquarium", on: "top" },
      { kind: "small_plant", on: "top" },
      { kind: "picture", elevation: 1.6 },
    ],
  },
  plants: {
    width: 1.5,
    pieces: () => [
      { kind: "tall_plant", u: -0.45 },
      { kind: "plant", u: 0.2 },
      { kind: "cactus", u: 0.65 },
    ],
  },
  window: {
    width: 1.9,
    pieces: (l) => [
      { kind: "window", scale: l.window },
      { kind: "plant", u: 1.0 },
    ],
  },
  windows: {
    width: 2.8,
    pieces: () => [
      { kind: "window", u: -0.78 },
      { kind: "window", name: "the other window", u: 0.78 },
    ],
  },
  easel: {
    width: 2.2,
    pieces: (l) => [
      { kind: "easel", v: 0.55 },
      { kind: "stool", u: 0.85, v: 0.5 },
      { kind: "poster", u: -0.8, color: l.accent },
      { kind: "poster", name: "the other poster", u: 0.8, color: l.rug },
    ],
  },
  workbench: {
    width: 2.5,
    pieces: () => [
      { key: "bench", kind: "desk", name: "the workbench", color: "#6f7378" },
      { kind: "laptop", on: "bench" },
      { kind: "mug", on: "bench" },
      { kind: "pegboard" },
      { kind: "stool", u: -0.85, v: 0.6 },
      { key: "crate", kind: "block", name: "the crate", u: 1.05, size: [0.55, 0.45, 0.5], color: "#a8794f" },
      { kind: "block", name: "the small crate", on: "crate", size: [0.4, 0.32, 0.38], color: "#bd8d5f" },
    ],
  },
  // For meeting rooms, where the middle of the room is the table's.
  hearth: {
    width: 1.6,
    pieces: (l) => [
      { key: "fire", kind: "fireplace" },
      { kind: "candle", on: "fire" },
      { kind: "painting", color: l.accent, elevation: 1.55 },
    ],
  },
  palms: {
    width: 1.6,
    pieces: () => [
      { kind: "palm", u: -0.4 },
      { kind: "palm", name: "the other palm", u: 0.45 },
    ],
  },
  crates: {
    width: 1.6,
    pieces: () => [
      { key: "crate", kind: "block", name: "the crate", u: -0.35, size: [0.6, 0.5, 0.55], color: "#a8794f" },
      { kind: "block", name: "the small crate", on: "crate", size: [0.45, 0.35, 0.4], color: "#bd8d5f" },
      { kind: "cylinder", name: "the barrel", u: 0.45, size: [0.5, 0.75, 0.5], color: "#7a5236" },
    ],
  },
  // For the work an agent does (see `ROLE_DRESSINGS`).
  rack: {
    width: 1.5,
    pieces: () => [
      { kind: "server_rack", u: -0.36 },
      { kind: "server_rack", name: "the other server rack", u: 0.36 },
      { kind: "clock", u: 0, elevation: 2.15 },
    ],
  },
  booth: {
    width: 2.1,
    pieces: () => [
      { key: "desk", kind: "desk", name: "the mixing desk", u: -0.2, color: "#3a3f4a" },
      { kind: "laptop", on: "desk" },
      { kind: "mic_stand", u: 0.75, v: 0.8, facing: -50 },
      { kind: "poster", name: "the acoustic panel", u: -0.55, color: "#3f4654", elevation: 1.5 },
      { kind: "poster", name: "the other acoustic panel", u: 0.15, color: "#3f4654", elevation: 1.5 },
    ],
  },
  travel: {
    width: 1.9,
    pieces: (l) => [
      { kind: "globe", u: -0.55, v: 0.4 },
      { kind: "map", u: 0.1, elevation: 1.5 },
      { kind: "block", name: "the suitcase", u: 0.65, size: [0.48, 0.62, 0.24], color: l.accent },
    ],
  },
  accounts: {
    width: 2.3,
    pieces: (l) => [
      { kind: "block", name: "the safe", u: -0.85, size: [0.5, 0.62, 0.45], color: "#4a4f57" },
      { key: "desk", kind: "desk", name: "the bureau", u: 0.3, color: l.wood },
      { kind: "ledger", on: "desk" },
      { kind: "ledger", name: "the other ledger", on: "desk" },
      { kind: "table_lamp", name: "the desk lamp", on: "desk" },
      { kind: "chair", name: "the desk chair", u: -0.33, v: 0.9, facing: 200 },
      { key: "shelf", kind: "shelf", u: 0.3, elevation: 1.5 },
      { kind: "books", name: "the account books", on: "shelf" },
    ],
  },
} satisfies Record<string, Group>;

type GroupId = keyof typeof GROUPS;

/** Groups a crowded wall drops last: what a room is built round, somewhere to work, and the task board. */
const KEEP: GroupId[] = ["desk", "board", "workbench", "easel", "lounge", "media", "fireside", "bed", "hearth"];
/** And later still: what the work its agent does needs (`ROLE_DRESSINGS`), which is what says whose room it is. */
const FOR_WORK: GroupId[] = ["rack", "booth", "travel", "accounts"];

// --------------------------------------------------------------------------
// Putting pieces in a room
// --------------------------------------------------------------------------

/** Where a group goes: against the back or left wall, its middle this far along it; flipped, it runs the other way. */
interface Frame {
  wall: "back" | "left";
  at: number;
  flip: boolean;
}

/** A piece with its place in the room worked out. */
interface Placed extends Omit<Piece, "u" | "v"> {
  at: [number, number];
  facing: number;
  /** A wall thing's wall, and how far along it. */
  wall?: { side: "back" | "left"; along: number };
}

/**
 * A piece's floor point and facing in the room, from its group's frame. The
 * back wall runs along x and the left wall along z, each toward the open side,
 * so the left wall's frame is the back wall's mirrored across the corner: what
 * is near the corner in one is near it in the other.
 */
function inRoom(place: Place, frame: Frame, piece: Piece, key: string): Placed {
  const kind = KINDS[piece.kind];
  const f = piece.facing ?? 0;
  const [w, d] = footprintOf(piece);
  // Back against the wall, whichever way it is turned.
  const v =
    piece.v ??
    Math.abs((w / 2) * Math.sin((f * Math.PI) / 180)) + Math.abs((d / 2) * Math.cos((f * Math.PI) / 180)) + 0.02;
  const along = round(frame.at + (frame.flip ? -1 : 1) * (piece.u ?? 0));
  const facing = frame.flip ? -f : f;
  const placed: Placed = {
    ...piece,
    key: piece.key ? `${key}:${piece.key}` : undefined,
    on: piece.on ? `${key}:${piece.on}` : undefined,
    at: frame.wall === "back" ? [along, round(-place.depth / 2 + v)] : [round(-place.width / 2 + v), along],
    facing: normalizeFacing(frame.wall === "back" ? facing : 90 - facing),
  };
  if (kind?.mount === "wall") placed.wall = { side: frame.wall, along };
  return placed;
}

/** Small steps either way along a wall, nearest first. */
const ALONG = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6];

/** Points round a spot, nearest first, out to half a metre. */
function* nearby(): Generator<[number, number]> {
  yield [0, 0];
  for (let r = 0.1; r <= 0.5; r += 0.1) {
    const n = Math.round(r * 60);
    for (let i = 0; i < n; i++) yield [r * Math.sin((i / n) * 2 * Math.PI), r * Math.cos((i / n) * 2 * Math.PI)];
  }
}

/**
 * Add pieces to a room in order, each where it was meant to go if it fits
 * there, else the nearest place close by that does, else not at all; what
 * stands on something goes wherever there is room on it. Each piece is checked
 * against everything before it, its spot included, so the room ends up sound
 * by the rules the `place` tool keeps.
 */
function furnish(start: Place, pieces: Placed[]): Place {
  let place = start;
  const ids = new Map<string, string>();
  for (const piece of pieces) {
    const kind = KINDS[piece.kind];
    if (!kind) continue;
    const placing: Placing = {
      kind: piece.kind,
      ...(piece.scale ? { scale: piece.scale } : {}),
      ...(piece.size ? { size: piece.size } : {}),
    };
    let to: { at: [number, number]; facing: number; elevation?: number; on?: string } | undefined;
    if (piece.on) {
      const base = ids.get(piece.on);
      const got = base ? findPlacement(place, placing, { on: base }) : "";
      if (typeof got !== "string") to = got;
    } else if (kind.mount === "wall" && piece.wall) {
      const { side, along } = piece.wall;
      // A bigger one hangs with its middle where a normal one's would be.
      const elevation = round((piece.elevation ?? kind.elevation ?? 1.2) - (heightOf(placing) - kind.height) / 2);
      const d = ALONG.find((step) => fitsOnWall(place, placing, side, round(along + step), elevation));
      if (d !== undefined)
        to = { at: wallPoint(place, side, round(along + d)), facing: side === "back" ? 0 : 90, elevation };
    } else if (kind.mount === "floor") {
      for (const [dx, dz] of nearby()) {
        const at: [number, number] = [round(piece.at[0] + dx), round(piece.at[1] + dz)];
        if (fitsOnFloor(place, placing, at, piece.facing)) {
          to = { at, facing: piece.facing };
          break;
        }
      }
    }
    if (!to) continue;
    const taken = (s: string) => place.props.some((p) => p.id === s || p.name === s);
    const item: PlaceItem = {
      id:
        piece.id && !taken(piece.id) && !place.spots.some((s) => s.id === piece.id)
          ? piece.id
          : newId(place, piece.kind),
      name: piece.name && !taken(piece.name) ? piece.name : newName(place, piece.kind),
      kind: piece.kind,
      at: to.at,
      facing: normalizeFacing(to.facing),
    };
    if (to.elevation !== undefined) item.elevation = to.elevation;
    if (to.on) {
      item.on = to.on;
      const base = place.props.find((p) => p.id === to.on);
      if (base?.spot) item.spot = base.spot;
    }
    if (piece.color) item.color = piece.color;
    if (piece.scale && piece.scale !== 1) item.scale = piece.scale;
    if (piece.size) item.size = piece.size;
    if (piece.label) item.label = piece.label;
    if (piece.action) item.action = piece.action;
    if (piece.key) ids.set(piece.key, item.id);
    place = withSpots({ ...place, props: [...place.props, item] });
  }
  return place;
}

/**
 * Frames for groups along a free stretch of wall, in order, the spare wall
 * shared out between them. When they don't all fit, groups go from the open
 * end first, keeping what the room is built round (`KEEP`), and what its
 * agent's work needs (`FOR_WORK`), to the last.
 */
function lineUp(ids: GroupId[], wall: "back" | "left", from: number, to: number, flips: () => boolean) {
  const chosen = [...ids];
  const total = () => chosen.reduce((sum, id) => sum + GROUPS[id].width, 0);
  const worth = (id: GroupId) => (FOR_WORK.includes(id) ? 2 : KEEP.includes(id) ? 1 : 0);
  while (chosen.length && total() > to - from) {
    // The least worth keeping, nearest the open end.
    let drop = chosen.length - 1;
    for (let i = chosen.length - 1; i >= 0; i--) if (worth(chosen[i]) < worth(chosen[drop])) drop = i;
    chosen.splice(drop, 1);
  }
  const gap = (to - from - total()) / (chosen.length + 1);
  let x = from + gap;
  return chosen.map((id) => {
    const frame: Frame = { wall, at: round(x + GROUPS[id].width / 2), flip: flips() };
    x += GROUPS[id].width + gap;
    return { id, frame };
  });
}

/** Where a doorway is kept clear: which wall, and its middle along it. */
interface Door {
  wall: "back" | "left";
  at: number;
}

/** What a room is made from. */
interface Spec {
  name: string;
  width: number;
  depth: number;
  height: number;
  palette: Palette;
  look: Look;
  doors: Door[];
  /** What the room is for, in the middle, before anything else: a meeting table and its seats, kiosks. */
  centre?: Placed[];
  /** The spot everyone starts at, which nothing may cover. */
  start: PlaceSpot;
  back: GroupId[];
  left: GroupId[];
  /** Where the back and left walls' groups start, from the corner they share. */
  corner: { back: number; left: number };
  flips: () => boolean;
  /** What goes in last, in what floor is left: corners, an island of chairs. */
  after?: Placed[];
  /** What the room must have, put wherever it fits when nothing else brought one. */
  needs?: Need[];
  /** Where floor lamps may go, in order, while the room has too few lights. */
  lampsAt?: [number, number][];
}

/** A room from its spec: doorways held clear while it is furnished, then let go. */
function build(spec: Spec): Place {
  const { width, depth } = spec;
  // Each doorway is held by a block as tall as the room while the furniture goes in, so nothing stands in it or hangs over it.
  const holds: PlaceItem[] = spec.doors.map((door, i) => {
    const span = DOORWAY.width + 0.2;
    return {
      id: `doorway-hold-${i + 1}`,
      name: `doorway ${i + 1}`,
      kind: "block",
      at:
        door.wall === "back"
          ? [door.at, round(-depth / 2 + DOORWAY.depth / 2)]
          : [round(-width / 2 + DOORWAY.depth / 2), door.at],
      facing: 0,
      size: door.wall === "back" ? [span, 9, DOORWAY.depth] : [DOORWAY.depth, 9, span],
    };
  });
  let place: Place = {
    name: spec.name,
    width,
    depth,
    height: spec.height,
    walls: spec.palette.walls,
    floor: spec.palette.floor,
    ...(spec.palette.floorColor ? { floorColor: spec.palette.floorColor } : {}),
    props: holds,
    spots: [],
    start: spec.start.id,
  };
  place = furnish(place, spec.centre ?? []);
  place = withSpots({ ...place, spots: [spec.start, ...place.spots] });
  // The walls' free stretches: from the shared corner to the open side, less a doorway at either end.
  const stretch = (wall: "back" | "left") => {
    const span = wall === "back" ? width : depth;
    let from = -span / 2 + spec.corner[wall];
    let to = span / 2 - 0.3;
    for (const door of spec.doors) {
      if (door.wall !== wall) continue;
      if (door.at > 0) to = Math.min(to, door.at - (DOORWAY.width + 0.2) / 2);
      else from = Math.max(from, door.at + (DOORWAY.width + 0.2) / 2);
    }
    return lineUp(spec[wall], wall, from, to, spec.flips);
  };
  const groups = [...stretch("back"), ...stretch("left")];
  place = furnish(
    place,
    groups.flatMap(({ id, frame }, g) =>
      GROUPS[id].pieces(spec.look).map((p) => inRoom(place, frame, p, `${id}-${g}`)),
    ),
  );
  place = furnish(place, spec.after ?? []);
  // While the doorways are still held, so a seat or a window made up for doesn't land in one.
  for (const need of spec.needs ?? []) place = ensure(place, need);
  for (const at of spec.lampsAt ?? []) {
    if (lights(place) >= LAMPS) break;
    // Not right beside a lamp that is already there.
    if (place.props.some((p) => p.kind === "lamp" && Math.hypot(p.at[0] - at[0], p.at[1] - at[1]) < 1.8)) continue;
    place = furnish(place, [{ kind: "lamp", at, facing: 0 }]);
  }
  const held = new Set(holds.map((h) => h.id));
  return clearWays(withSpots({ ...place, props: place.props.filter((p) => !held.has(p.id)) }));
}

/**
 * The room with every spot reachable on foot. Groups set side by side can
 * box a spot in (a window between one group's desk chair and the next one's
 * armchair), so while one is, a piece close to it goes: the first whose
 * going frees the spot, trying things that bring no spot of their own (a
 * chair, a plant, a lamp) before the rest. Seats at a meeting table, the
 * tables and the kiosks stay. A spot nothing nearby frees is left as it is.
 */
function clearWays(start: Place): Place {
  let place = start;
  for (let tries = 0; tries < 6; tries++) {
    const [stuck] = unreachable(place);
    if (!stuck) break;
    const away = (p: PlaceItem) => Math.hypot(p.at[0] - stuck.at[0], p.at[1] - stuck.at[1]);
    const close = place.props
      .filter(
        (p) =>
          !p.on &&
          KINDS[p.kind]?.mount === "floor" &&
          !KINDS[p.kind]?.walkable &&
          p.id !== stuck.item &&
          !p.action &&
          !/^(seat|table)-\d+$/.test(p.id) &&
          away(p) < 1.8,
      )
      .sort((a, b) => Number(!!KINDS[a.kind]?.use) - Number(!!KINDS[b.kind]?.use) || away(a) - away(b));
    const freeing = close.find((p) => !unreachable(removeItem(place, p.id).place, [stuck.id]).length);
    if (!freeing) break;
    place = removeItem(place, freeing.id).place;
  }
  return place;
}

/**
 * Something every home has: somewhere to sit, somewhere to work, a window, a
 * frame for the photos taken there, and a calendar of its owner's day.
 */
type Need = "seat" | "desk" | "window" | "picture" | "calendar";

interface Needed {
  kind: string;
  has: (p: Place) => boolean;
  /** What it goes by, when it goes by something. */
  near?: (p: Place) => string | undefined;
  /** Smaller sizes to try, in turn, on a wall too full for a normal one. */
  smaller?: number[];
}

const NEEDS: Record<Need, Needed> = {
  seat: { kind: "armchair", has: (p) => p.spots.some((s) => s.activity === "sit") },
  desk: { kind: "desk", has: (p) => p.spots.some((s) => s.activity === "type") },
  window: { kind: "window", has: (p) => p.props.some((i) => i.kind === "window") },
  picture: { kind: "picture", has: (p) => p.props.some((i) => PHOTO_FRAMES.includes(i.kind)) },
  // By the desk, where a day is planned: on the wall nearest it, as close as there is room.
  calendar: {
    kind: "calendar",
    has: (p) => p.props.some((i) => i.kind === "calendar"),
    near: (p) => p.spots.find((s) => s.activity === "type")?.item,
    smaller: [0.8, 0.6],
  },
};

/** A room with what it needs: put wherever it fits (near what it goes by), the way the `place` tool would, when the room has none. */
function ensure(place: Place, need: Need): Place {
  const { kind, has, near, smaller = [] } = NEEDS[need];
  if (has(place)) return place;
  const by = near?.(place);
  for (const scale of [1, ...smaller]) {
    const got = findPlacement(place, { kind, ...(scale !== 1 ? { scale } : {}) }, by ? { near: by } : {});
    if (typeof got === "string") continue;
    const item: PlaceItem = {
      id: newId(place, kind),
      name: newName(place, kind),
      kind,
      ...got,
      ...(scale !== 1 ? { scale } : {}),
    };
    return withSpots({ ...place, props: [...place.props, item] });
  }
  return place;
}

// --------------------------------------------------------------------------
// Homes
// --------------------------------------------------------------------------

interface Palette {
  walls: string;
  floor: Floor;
  floorColor?: string;
}

const WARM: Palette[] = [
  { walls: "#efe6d6", floor: "wood" },
  { walls: "#e9dfd0", floor: "wood", floorColor: "#c9a178" },
  { walls: "#f0e5c2", floor: "wood", floorColor: "#8a5f3f" },
];
const COOL: Palette[] = [
  { walls: "#c8d6e2", floor: "wood", floorColor: "#a59e94" },
  { walls: "#dcd6e8", floor: "carpet", floorColor: "#6d7f8c" },
  { walls: "#d8d3cc", floor: "concrete" },
];
const SOFT: Palette[] = [
  { walls: "#ead3cc", floor: "carpet", floorColor: "#8a6f7d" },
  { walls: "#e2bfa5", floor: "wood" },
  { walls: "#c9d6c1", floor: "carpet", floorColor: "#7d8a6a" },
];
const BRIGHT: Palette[] = [
  { walls: "#f5f3ef", floor: "concrete" },
  { walls: "#dcd6e8", floor: "wood", floorColor: "#c9a178" },
  { walls: "#f2dfa0", floor: "concrete" },
];
const WORK: Palette[] = [
  { walls: "#d3d7dc", floor: "concrete" },
  { walls: "#b9cfd6", floor: "concrete" },
  { walls: "#e0cdb8", floor: "wood", floorColor: "#9b8b7a" },
  { walls: "#d8d3cc", floor: "tile", floorColor: "#8d949c" },
];
const BOOKISH: Palette[] = [
  { walls: "#e8dfcf", floor: "wood", floorColor: "#6b4a33" },
  { walls: "#d9e4c8", floor: "wood", floorColor: "#8a5f3f" },
  { walls: "#c7d3cf", floor: "carpet", floorColor: "#7a5a4a" },
];
const GREEN: Palette[] = [
  { walls: "#cfe5da", floor: "tile", floorColor: "#c98f6b" },
  { walls: "#c9d6c1", floor: "tile" },
  { walls: "#d9e4c8", floor: "wood", floorColor: "#b5835a" },
];

const FABRICS = ["#5b7c99", "#8a5a5a", "#6b8a5e", "#c08a4a", "#4f5d75", "#a8705a", "#7a6a9a", "#3f7f7a"];
const WOODS = ["#8a5a3b", "#a87650", "#6b4a33", "#b5835a"];
const RUGS = ["#a5543a", "#4f6d8a", "#7a8f5a", "#8a5a7a", "#c9a24a", "#5a7f7f"];
const ACCENTS = ["#c0504d", "#4f81bd", "#e6a23c", "#3cb6b0", "#8064a2", "#ee7f6d"];

/** A group, or a choice of groups the seed picks one of. */
type Choice = GroupId | GroupId[];

/**
 * A kind of home: what goes on each wall, what stands out in the floor, and
 * the colours it comes in. Each wall's list runs from the corner the walls
 * share toward the open side; a wall too short for all of it drops groups
 * from the open end, so the last ones are extras for a bigger room.
 */
export interface Preset {
  id: string;
  back: Choice[];
  left: Choice[];
  /** Two of these stand out in the floor, where `SPREADS` says. */
  islands: Island[];
  /** What stands in a corner of the left wall, at its back or its front. */
  corner: string;
  palettes: Palette[];
}

export const PRESETS: Preset[] = [
  {
    id: "study",
    back: [["books", "sideboard"], "desk", ["couch", "lounge"], "plants"],
    left: ["window", ["reading", "aquarium"], "board"],
    islands: ["worktable", "chat", "rug"],
    corner: "tall_plant",
    palettes: WARM,
  },
  {
    id: "studio",
    back: ["easel", "desk", ["windows", "window"], "plants"],
    left: [["couch", "sideboard"], "plants", "window"],
    islands: ["chat", "play", "worktable"],
    corner: "plant",
    palettes: BRIGHT,
  },
  {
    id: "lounge",
    back: [["window", "windows"], ["lounge", "media"], "sideboard"],
    left: ["desk", ["plants", "books"], "window"],
    islands: ["dining", "play", "chat"],
    corner: "tall_plant",
    palettes: SOFT,
  },
  {
    id: "workshop",
    back: ["workbench", ["desk", "books"], ["window", "windows"], "plants"],
    left: ["board", ["books", "sideboard", "aquarium"], "window"],
    islands: ["worktable", "rug", "play"],
    corner: "cactus",
    palettes: WORK,
  },
  {
    id: "nook",
    back: ["books", ["fireside", "couch"], "desk", "window"],
    left: ["window", "reading", "books"],
    islands: ["chat", "reading", "rug"],
    corner: "lamp",
    palettes: BOOKISH,
  },
  {
    id: "garden",
    back: [["windows", "window"], ["aquarium", "sideboard"], "plants", "window"],
    left: ["desk", "reading", "plants"],
    islands: ["dining", "greenery", "chat"],
    corner: "tall_plant",
    palettes: GREEN,
  },
  {
    id: "bedsit",
    back: ["desk", "bed", ["window", "windows"], "plants"],
    left: [["couch", "reading"], "plants", "window"],
    islands: ["dining", "chat", "worktable"],
    corner: "plant",
    palettes: WARM,
  },
  {
    id: "den",
    back: ["plants", ["media", "fireside"], "desk"],
    left: ["window", ["reading", "couch"], "books"],
    islands: ["play", "worktable", "dining"],
    corner: "tall_plant",
    palettes: COOL,
  },
];

/** What can stand out in the floor, away from the walls. */
type Island = "chat" | "dining" | "rug" | "reading" | "worktable" | "play" | "greenery" | "game";

/**
 * Something standing out in the floor, round a middle point. Islands stand
 * between the camera and the walls, so all of it is low enough to see past:
 * no floor lamps or tall plants.
 */
function island(kind: Island, [x, z]: [number, number], look: Look, key: string): Placed[] {
  const at = (dx: number, dz: number): [number, number] => [round(x + dx), round(z + dz)];
  const ring = (n: number, r: number, from = 0) =>
    Array.from({ length: n }, (_, i) => {
      const a = from + (360 * i) / n;
      return { at: at(r * Math.sin((a * Math.PI) / 180), r * Math.cos((a * Math.PI) / 180)), facing: a + 180 };
    });
  switch (kind) {
    case "chat":
      return [
        { kind: "round_rug", at: at(0, 0), facing: 0, color: look.rug },
        { kind: "beanbag", at: at(-0.55, -0.15), facing: 25, color: look.fabric2 },
        { kind: "beanbag", name: "the other beanbag", at: at(0.55, -0.15), facing: -25, color: look.fabric },
      ];
    case "dining":
      return [
        { kind: "round_rug", at: at(0, 0), facing: 0, scale: 1.2, color: look.rug },
        { key: `${key}:table`, kind: "round_table", at: at(0, 0), facing: 0, color: look.wood },
        { kind: "vase", on: `${key}:table`, at: at(0, 0), facing: 0 },
        ...ring(3, 0.78).map((r, i) => ({
          kind: "chair",
          name: i ? `the dining chair ${i + 1}` : "the dining chair",
          ...r,
          color: look.wood,
        })),
      ];
    case "rug":
      return [
        { kind: "rug", at: at(0, 0), facing: 0, scale: 1.1, color: look.rug },
        { kind: "beanbag", at: at(-0.3, 0.05), facing: 20, color: look.fabric },
        { key: `${key}:table`, kind: "side_table", at: at(0.45, -0.25), facing: 0, color: look.wood },
        { kind: "mug", on: `${key}:table`, at: at(0, 0), facing: 0 },
      ];
    case "reading":
      return [
        { kind: "rug", at: at(0, 0), facing: 0, scale: 0.85, color: look.rug },
        { kind: "armchair", name: "the big armchair", at: at(-0.2, 0), facing: 40, color: look.fabric },
        { key: `${key}:table`, kind: "side_table", at: at(0.55, -0.35), facing: 0, color: look.wood },
        { kind: "table_lamp", on: `${key}:table`, at: at(0, 0), facing: 0 },
        { kind: "books", on: `${key}:table`, at: at(0, 0), facing: 0 },
      ];
    case "worktable":
      return [
        { kind: "rug", at: at(0, 0), facing: 0, scale: 1.15, color: look.rug },
        { key: `${key}:table`, kind: "table", name: "the work table", at: at(0, 0), facing: 0, color: look.wood },
        { kind: "laptop", on: `${key}:table`, at: at(0, 0), facing: 0 },
        { kind: "books", on: `${key}:table`, at: at(0, 0), facing: 0 },
        { kind: "chair", name: "the table chair", at: at(-0.3, -0.62), facing: 0, color: look.fabric2 },
        { kind: "chair", name: "the other table chair", at: at(0.3, 0.62), facing: 180, color: look.fabric2 },
      ];
    case "play":
      return [
        { kind: "round_rug", at: at(0, 0), facing: 0, color: look.rug },
        { kind: "beanbag", at: at(-0.5, 0.2), facing: 60, color: look.fabric },
        { kind: "ball", at: at(0.35, -0.2), facing: 0, size: [0.45, 0.45, 0.45], color: look.accent },
        {
          kind: "cylinder",
          name: "the drum stool",
          at: at(0.55, 0.45),
          facing: 0,
          size: [0.4, 0.42, 0.4],
          color: look.fabric2,
        },
      ];
    case "game":
      return [
        { kind: "rug", at: at(0, 0), facing: 0, scale: 1.15, color: look.rug },
        { key: `${key}:table`, kind: "table", name: "the game table", at: at(0, 0), facing: 0, color: look.wood },
        { kind: "chessboard", on: `${key}:table`, at: at(0, 0), facing: 0 },
        { kind: "books", name: "the rule books", on: `${key}:table`, at: at(0, 0), facing: 0 },
        { kind: "chair", name: "the game chair", at: at(-0.3, -0.62), facing: 0, color: look.fabric2 },
        { kind: "chair", name: "the other game chair", at: at(0.3, 0.62), facing: 180, color: look.fabric2 },
      ];
    case "greenery":
      return [
        { kind: "round_rug", at: at(0, 0), facing: 0, scale: 0.8, color: "#9caf88" },
        { kind: "plant", at: at(-0.35, -0.2), facing: 0 },
        { kind: "plant", name: "the fern", at: at(0.35, -0.25), facing: 0 },
        { kind: "cactus", at: at(0.1, 0.35), facing: 0 },
        { kind: "stool", name: "the garden stool", at: at(-0.5, 0.45), facing: 30 },
      ];
  }
}

/**
 * Where a home's two islands stand, as fractions of its width and depth from
 * the middle, the seed picking one: side by side in front, one out to the
 * right and one in front, one in the front middle and one at the right. All
 * keep clear of the middle, where the avatar starts, and of the left wall's
 * furniture.
 */
const SPREADS: [[number, number], [number, number]][] = [
  [
    [0.24, 0.22],
    [-0.2, 0.27],
  ],
  [
    [0.3, -0.02],
    [-0.1, 0.3],
  ],
  [
    [0.08, 0.32],
    [0.32, 0.02],
  ],
  [
    [-0.02, 0.3],
    [0.33, -0.1],
  ],
];

/**
 * What a home has for the work its agent does (see `places-roles.ts`): a
 * group of furniture for it, in place of the first of `instead` the room
 * would have had, or else first along the left wall; groups that don't suit
 * the work swapped for others; and an island for it, in place of the seed's
 * first. Everything else is still the seed's.
 */
interface Dressing {
  group?: GroupId;
  instead?: GroupId[];
  swap?: Partial<Record<GroupId, GroupId>>;
  island?: Island;
}

export const ROLE_DRESSINGS: Record<string, Dressing> = {
  // A coder's or an operator's servers, where a sideboard or a shelf would have gone.
  rack: { group: "rack", instead: ["sideboard", "aquarium", "books", "plants"] },
  // A producer's desk with a microphone by it, and no easel.
  booth: { group: "booth", instead: ["desk"], swap: { easel: "sideboard" } },
  // A travel agent's globe and map, and a suitcase.
  travel: { group: "travel", instead: ["sideboard", "plants", "books"] },
  // A bookkeeper's desk with its ledgers, and a safe.
  accounts: { group: "accounts", instead: ["desk"] },
  // A game master's or a player's table with a board on it.
  game: { island: "game" },
};

/** A home's walls with what its work needs on them (see `ROLE_DRESSINGS`). */
export function dress(back: GroupId[], left: GroupId[], dressing: Dressing | undefined): [GroupId[], GroupId[]] {
  if (!dressing) return [back, left];
  const swapped = (wall: GroupId[]) => wall.map((g) => dressing.swap?.[g] ?? g);
  const walls = [swapped(back), swapped(left)];
  const { group } = dressing;
  if (!group) return [walls[0], walls[1]];
  for (const wanted of dressing.instead ?? []) {
    for (const wall of walls) {
      const i = wall.indexOf(wanted);
      if (i >= 0) {
        wall[i] = group;
        return [walls[0], walls[1]];
      }
    }
  }
  return [walls[0], [group, ...walls[1]]];
}

/** Fewer light sources than this and a room is dark after sunset: floor lamps go in wherever they fit. */
const LAMPS = 3;

const lights = (p: Place) => p.props.filter((i) => ["lamp", "table_lamp", "fireplace"].includes(i.kind)).length;

/**
 * A home of its own, from a seed (the place's id): a preset picked by the
 * seed, the room 8 to 10 m wide and 6 to 8 m deep, its colours, a choice of
 * groups for each wall and which way each runs, two islands in the floor, and
 * where the doorway is kept. There is always somewhere to sit, somewhere to
 * work, a window, and lamps for the evening. `kind` asks for a preset by id
 * (a study, a workshop) in place of the seed's, and `dressing` for what the
 * work its agent does needs in it (`ROLE_DRESSINGS`).
 */
export function homePlace(seed: string, name: string, kind?: string, dressing?: string): Place {
  const rand = seeded(seed);
  const drawn = pick(rand, PRESETS);
  const preset = PRESETS.find((p) => p.id === kind) ?? drawn;
  const width = 8 + 0.5 * Math.floor(rand() * 5);
  const depth = 6 + 0.5 * Math.floor(rand() * 5);
  const height = pick(rand, [2.7, 2.8, 3]);
  const look: Look = {
    fabric: pick(rand, FABRICS),
    fabric2: pick(rand, FABRICS),
    wood: pick(rand, WOODS),
    rug: pick(rand, RUGS),
    accent: pick(rand, ACCENTS),
    window: pick(rand, [1, 1.15, 1.3]),
  };
  const palette = pick(rand, preset.palettes);
  const choose = (list: Choice[]) => list.map((c) => (Array.isArray(c) ? pick(rand, c) : c));
  const work = dressing ? ROLE_DRESSINGS[dressing] : undefined;
  const [back, left] = dress(choose(preset.back), choose(preset.left), work);
  const span = DOORWAY.width + 0.2;
  // On the left wall only where it is long enough to keep a group or two beside the doorway.
  const door: Door =
    depth - 1.2 - 0.4 - span >= 3.4 && rand() < 0.5
      ? { wall: "left", at: round(depth / 2 - 0.4 - span / 2) }
      : { wall: "back", at: round(width / 2 - 0.4 - span / 2) };
  const drawnFirst = pick(rand, preset.islands);
  const drawnSecond = pick(
    rand,
    preset.islands.filter((i) => i !== drawnFirst),
  );
  // The work's island in place of the first, unless the seed had it second.
  const first = work?.island ?? drawnFirst;
  const second = drawnSecond === first ? drawnFirst : drawnSecond;
  const [one, two] = pick(rand, SPREADS);
  // The corner piece stands at the back of the left wall, or at its front when the doorway isn't there.
  const front = rand() < 0.5 && door.wall !== "left";
  const cornerZ = front ? round(depth / 2 - 0.45) : round(-depth / 2 + 0.45);
  const after: Placed[] = [
    { kind: preset.corner, at: [round(-width / 2 + 0.45), cornerZ], facing: 0 },
    ...island(first, [round(width * one[0]), round(depth * one[1])], look, "isle-1"),
    ...island(second, [round(width * two[0]), round(depth * two[1])], look, "isle-2"),
  ];
  // Where a lamp can go if the room is short of light: the corners on the left, then the back right.
  const lampsAt: [number, number][] = [
    [round(-width / 2 + 0.35), round(depth / 2 - 0.45)],
    [round(-width / 2 + 0.4), round(-depth / 2 + 0.4)],
    [round(width / 2 - 0.4), round(-depth / 2 + 0.4)],
  ];
  return build({
    name,
    width,
    depth,
    height,
    palette,
    look,
    doors: [door],
    start: {
      id: "middle",
      name: "the middle of the room",
      place: "the middle of the room",
      at: [0, round(depth * 0.08)],
      facing: 20,
    },
    back,
    left,
    corner: { back: 1.0, left: 1.2 },
    flips: () => rand() < 0.5,
    after,
    lampsAt,
    needs: ["seat", "desk", "window", "picture", "calendar"],
  });
}

/** What a shared place can be furnished as: any kind of home but the bedsit, with its bed. */
const SHARED_PRESETS = PRESETS.filter((p) => p.id !== "bedsit").map((p) => p.id);

/** A shared place, made with the `place` tool's `new`: furnished like a home, from its id, but never as a bedroom. */
export function sharedPlace(seed: string, name: string): Place {
  return homePlace(seed, name, pick(seeded(`${seed}\nshared`), SHARED_PRESETS));
}

// --------------------------------------------------------------------------
// Meeting rooms
// --------------------------------------------------------------------------

/**
 * How a room for a purpose looks, picked by the words in its name and purpose:
 * a trip by the sea, a workshop, a studio, a tavern, a library. A room whose
 * words match none is plain. Each comes in a few colourings, and the room's
 * name picks one, so two rooms of a kind still differ.
 */
export interface Theme {
  id: string;
  words: RegExp;
  palettes: Palette[];
}

export const THEMES: Theme[] = [
  {
    id: "beach",
    words: /\b(beach|vacation|holiday|trip|travel|surf|island|tropic|seaside)/i,
    palettes: [
      { walls: "#cfe8f0", floor: "tile", floorColor: "#e6d3a3" },
      { walls: "#f3e9d2", floor: "wood", floorColor: "#d9b98c" },
      { walls: "#d7efe6", floor: "tile", floorColor: "#efe0b9" },
    ],
  },
  {
    id: "tavern",
    words: /\b(d&d|dnd|campaign|quest|tavern|dungeon|adventure|rpg)/i,
    palettes: [
      { walls: "#6e4e38", floor: "wood" },
      { walls: "#5b4636", floor: "wood", floorColor: "#4a3424" },
      { walls: "#8a7660", floor: "concrete", floorColor: "#6f655a" },
    ],
  },
  {
    id: "studio",
    words: /\b(podcast|music|audio|studio|record|episode)/i,
    palettes: [
      { walls: "#3d3648", floor: "carpet" },
      { walls: "#2f3a44", floor: "carpet", floorColor: "#4a4f5a" },
      { walls: "#4a3a3a", floor: "wood", floorColor: "#5a4030" },
    ],
  },
  {
    id: "workshop",
    words: /\b(code|coder|coding|dev|engineer|build|deploy|bug|ops|review|repo)/i,
    palettes: WORK,
  },
  {
    id: "library",
    words: /\b(research|study|read|book|library|learn|notes)/i,
    palettes: BOOKISH,
  },
];

/** A room that matches no theme is coloured like a home, from the cooler and lighter end. */
const PLAIN: Palette[] = [{ walls: "#dfe4ea", floor: "carpet" }, ...COOL, ...BRIGHT, ...WARM];

/** The theme the words of a room's name and purpose call for, if any. */
export function themeFor(words: string): Theme | undefined {
  return THEMES.find((t) => t.words.test(words));
}

/** A place with no theme: chosen, so no guess dresses it again. */
export const NO_THEME = "none";

/**
 * The theme someone asked for: one by its id ("beach"), "none" for plain, or
 * one its words call for ("the seaside" is the beach). Undefined when the
 * words name none of them.
 */
export function themeNamed(words: string): Theme | typeof NO_THEME | undefined {
  const asked = words
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "");
  if (/^(none|plain|no theme|nothing|no)$/.test(asked)) return NO_THEME;
  return THEMES.find((t) => t.id === asked || `${t.id}s` === asked) ?? themeFor(asked);
}

/** What each theme brings with it when a room someone has furnished is given it: one thing that says so. */
const SIGNS_OF: Record<string, string> = {
  beach: "palm",
  tavern: "fireplace",
  studio: "easel",
  workshop: "pegboard",
  library: "bookshelf",
};

/**
 * A room someone has furnished, given a theme: repainted in one of the
 * theme's colourings (the room's name picks which), and with the one thing
 * that says what it is, when it has none and there is room. Everything
 * already in it stays where it is. "none" repaints it plain.
 */
export function retheme(place: Place, theme: Theme | typeof NO_THEME): { place: Place; added?: PlaceItem } {
  const id = theme === NO_THEME ? NO_THEME : theme.id;
  const palette = pick(seeded(`${place.name}\n${id}`), theme === NO_THEME ? PLAIN : theme.palettes);
  const { floorColor: _old, ...rest } = place;
  const painted: Place = {
    ...rest,
    walls: palette.walls,
    floor: palette.floor,
    ...(palette.floorColor ? { floorColor: palette.floorColor } : {}),
    theme: id,
  };
  const kind = SIGNS_OF[id];
  if (!kind || painted.props.some((p) => p.kind === kind)) return { place: painted };
  const spot = findPlacement(withDoorwayHeld(painted), { kind }, {});
  if (typeof spot === "string") return { place: painted };
  const added: PlaceItem = {
    id: newId(painted, kind),
    name: newName(painted, kind),
    kind,
    at: spot.at,
    facing: spot.facing,
    ...(spot.elevation !== undefined ? { elevation: spot.elevation } : {}),
  };
  const next = withSpots({ ...painted, props: [...painted.props, added] });
  // Something that would leave a spot out of reach isn't worth the theme: the colours alone say it.
  return placeProblems(next).length ? { place: painted } : { place: next, added };
}

/**
 * What a meeting room puts on its walls, by theme, in a few arrangements the
 * room's name picks between: the task board always, in the middle of the back
 * wall. Nothing deep, since the middle of the room is the table's.
 */
const DRESSING: Record<string, { back: GroupId[]; left: GroupId[] }[]> = {
  plain: [
    { back: ["window", "board", "sideboard"], left: ["couch", "plants"] },
    { back: ["plants", "board", "windows"], left: ["sideboard", "window"] },
    { back: ["books", "board", "window"], left: ["aquarium", "couch"] },
  ],
  beach: [
    { back: ["window", "board", "palms"], left: ["windows", "plants"] },
    { back: ["palms", "board", "windows"], left: ["couch", "palms"] },
  ],
  tavern: [
    { back: ["books", "board", "crates"], left: ["hearth", "window"] },
    { back: ["crates", "board", "hearth"], left: ["window", "books"] },
  ],
  studio: [
    { back: ["easel", "board", "window"], left: ["couch", "plants"] },
    { back: ["window", "board", "easel"], left: ["sideboard", "couch"] },
  ],
  workshop: [
    { back: ["workbench", "board", "window"], left: ["books", "crates"] },
    { back: ["window", "board", "workbench"], left: ["crates", "plants"] },
  ],
  library: [
    { back: ["books", "board", "books"], left: ["window", "reading"] },
    { back: ["window", "board", "books"], left: ["books", "reading"] },
  ],
};

/**
 * A room for a conversation several agents share, sized by how many are in
 * it: up to six sit round a round table, more at a long one, a seat for each.
 * The task board hangs on the back wall, and the room is dressed for what it
 * is for (see `THEMES`).
 */
export function meetingRoom(name: string, seats: number, purpose = "", chosen?: string): Place {
  const n = Math.max(2, Math.min(16, Math.floor(seats)));
  // A theme someone chose beats the one the words call for; "none" is a choice too.
  const theme =
    chosen === NO_THEME ? undefined : (THEMES.find((t) => t.id === chosen) ?? themeFor(`${name} ${purpose}`));
  const rand = seeded(`${name}\n${purpose}`);
  const palette = pick(rand, theme?.palettes ?? PLAIN);
  const dressing = pick(rand, DRESSING[theme?.id ?? "plain"]);
  const look: Look = {
    fabric: pick(rand, FABRICS),
    fabric2: pick(rand, FABRICS),
    wood: pick(rand, WOODS),
    rug: pick(rand, RUGS),
    accent: pick(rand, ACCENTS),
    window: 1.15,
  };
  const centre: Placed[] = [];
  let width: number;
  let depth: number;
  let head: PlaceSpot;
  if (n <= 6) {
    // Round: the seats in a ring facing the middle, a gap at the front where the head of the table is.
    const scale = n <= 4 ? 1.15 : 1.4;
    const ring = round(0.71 * scale + 0.8);
    width = round(Math.max(7.5, 2 * ring + 5));
    depth = round(Math.max(6.5, 2 * ring + 3.4));
    const tableZ = round(-depth / 2 + 1.5 + ring);
    centre.push(
      {
        kind: "round_rug",
        at: [0, tableZ],
        facing: 0,
        scale: round(Math.min(LIMITS.scale[1], (ring * 2 + 0.9) / 1.8)),
        color: look.rug,
      },
      { id: "table-1", key: "t:1", name: "the table", kind: "round_table", at: [0, tableZ], facing: 0, scale },
    );
    for (let i = 0; i < n; i++) {
      const a = 180 / n + (360 * i) / n;
      const r = (a * Math.PI) / 180;
      centre.push({
        id: `seat-${i + 1}`,
        name: `seat ${i + 1}`,
        kind: "armchair",
        at: [round(ring * Math.sin(r)), round(tableZ + ring * Math.cos(r))],
        facing: normalizeFacing(a + 180),
        color: look.fabric,
      });
    }
    head = {
      id: "head",
      name: "at the head of the table",
      place: "the head of the table",
      at: [0, round(tableZ + ring + 0.9)],
      facing: 180,
    };
  } else {
    // Long: tables end to end, half the seats on each side, facing across.
    const perSide = Math.ceil(n / 2);
    const spacing = 1.0;
    const tables = Math.ceil((perSide * spacing) / 1.2);
    const row = tables * 1.2;
    width = round(Math.max(9, row + 5.5));
    depth = 7.5;
    const tableZ = -0.3;
    centre.push({
      kind: "rug",
      at: [0, tableZ],
      facing: 0,
      scale: round(Math.min(LIMITS.scale[1], (row + 1.6) / 2)),
      color: look.rug,
    });
    for (let i = 0; i < tables; i++)
      centre.push({
        id: `table-${i + 1}`,
        key: `t:${i + 1}`,
        name: tables > 1 ? `table ${i + 1}` : "the table",
        kind: "table",
        at: [round(-row / 2 + 0.6 + i * 1.2), tableZ],
        facing: 0,
      });
    for (let i = 0; i < n; i++) {
      const far = i % 2 === 0;
      const k = Math.floor(i / 2);
      const count = far ? perSide : n - perSide;
      // The far side faces the camera across the table; the near side faces back.
      centre.push({
        id: `seat-${i + 1}`,
        name: `seat ${i + 1}`,
        kind: "armchair",
        // Set back far enough for someone to walk between the seats and the table.
        at: [round((k - (count - 1) / 2) * spacing), round(tableZ + (far ? -1.45 : 1.45))],
        facing: far ? 0 : 180,
        color: look.fabric,
      });
    }
    head = {
      id: "head",
      name: "at the head of the table",
      place: "the head of the table",
      at: [round(row / 2 + 0.6), tableZ],
      facing: -90,
    };
  }
  const tables = centre.filter((p) => p.key?.startsWith("t:"));
  if (theme?.id === "tavern")
    for (const [i, t] of tables.entries())
      centre.push({
        kind: "candle",
        name: tables.length > 1 ? `candle ${i + 1}` : "the candle",
        on: t.key,
        at: t.at,
        facing: 0,
      });
  else
    for (const t of tables.slice(0, 1))
      centre.push({ kind: theme?.id === "beach" ? "small_plant" : "vase", on: t.key, at: t.at, facing: 0 });
  const span = DOORWAY.width + 0.2;
  const door: Door =
    rand() < 0.5
      ? { wall: "back", at: round(width / 2 - 0.4 - span / 2) }
      : { wall: "left", at: round(depth / 2 - 0.4 - span / 2) };
  const after: Placed[] = [
    // Lamps at the back left and the front left, out of the camera's way: a room with none is dark after sunset.
    { kind: "lamp", at: [round(-width / 2 + 0.35), round(-depth / 2 + 0.35)], facing: 0 },
    { kind: "lamp", name: "the other lamp", at: [round(-width / 2 + 0.35), round(depth / 2 - 0.45)], facing: 0 },
    // And one on the right, so a long room is lit from both ends.
    { kind: "lamp", name: "the far lamp", at: [round(width / 2 - 0.45), round(-depth / 2 + 1.7)], facing: 0 },
    {
      kind: theme?.id === "beach" ? "palm" : "plant",
      at: [round(width / 2 - 0.45), round(depth / 2 - 0.6)],
      facing: 0,
    },
  ];
  if (theme?.id === "beach")
    after.push({
      kind: "umbrella",
      name: "the beach umbrella",
      at: [round(-width / 2 + 1.1), round(depth / 2 - 1.3)],
      facing: 0,
      color: "#e85d4a",
    });
  const room = build({
    name,
    width,
    depth,
    height: 2.8,
    palette,
    look,
    doors: [door],
    centre,
    start: head,
    back: dressing.back,
    left: dressing.left,
    corner: { back: 0.9, left: 0.9 },
    flips: () => rand() < 0.5,
    after,
  });
  // The look it is dressed in, so whoever changes it later knows; a plain room nobody chose says nothing.
  return theme ? { ...room, theme: theme.id } : chosen === NO_THEME ? { ...room, theme: NO_THEME } : room;
}

// --------------------------------------------------------------------------
// The lobby
// --------------------------------------------------------------------------

/** The lobby's id on the map. */
export const LOBBY = "lobby";

/**
 * The lobby's doorway: in the middle of its open front, out on to the square.
 * The lobby is the town hall's, and the town hall faces the square.
 */
export const LOBBY_DOORS: DoorSlot[] = [{ wall: "front", along: 0 }];

/**
 * The town hall's lobby, and the biggest room there is, its way out in the
 * middle of its open front: kiosks to make a new agent, a new task or a new
 * room, a big screen over them showing the dashboard, a board of every open
 * task, a calendar of everyone's next wakes, a lounge by the windows, and
 * tables to sit at, either side of the way out.
 */
export function lobby(): Place {
  const width = 14;
  const depth = 10;
  const look: Look = {
    fabric: "#4f5d75",
    fabric2: "#c08a4a",
    wood: "#8a5a3b",
    rug: "#5a7f7f",
    accent: "#4f81bd",
    window: 1.3,
  };
  const back = round(-depth / 2);
  const kiosk = (id: string, x: number, label: string, action: PlaceAction): Placed => ({
    id,
    name: `the ${label.toLowerCase()} kiosk`,
    kind: "kiosk",
    at: [x, round(back + 0.7)],
    facing: 0,
    label,
    action,
  });
  const centre: Placed[] = [
    { kind: "rug", at: [0, -1.4], facing: 0, scale: 2, color: "#7d6a8a" },
    kiosk("kiosk-agent", -2, "New agent", "new-agent"),
    kiosk("kiosk-task", 0, "New task", "new-task"),
    kiosk("kiosk-room", 2, "New room", "new-room"),
    {
      id: "board",
      name: "the task board",
      kind: "board",
      at: [4, back],
      facing: 0,
      wall: { side: "back", along: 4 },
      label: "Open tasks",
      action: "tasks",
    },
    // Over the kiosks, high enough to be seen past them from across the room: the dashboard, a page at a time.
    {
      id: "screen",
      name: "the big screen",
      kind: "screen",
      at: [0, back],
      facing: 0,
      wall: { side: "back", along: 0 },
      scale: 1.6,
      elevation: 1.78,
    },
    // Close by the kiosks, clear of the wall beside them, so nothing tall stands in front of the board or the calendar.
    { kind: "tall_plant", at: [-2.62, round(back + 0.4)], facing: 0 },
    { kind: "tall_plant", name: "the other tall plant", at: [2.62, round(back + 0.4)], facing: 0 },
    // Across from the board, big enough to read from across the room: when everyone next wakes.
    {
      id: "calendar",
      name: "the calendar",
      kind: "calendar",
      at: [-3.7, back],
      facing: 0,
      wall: { side: "back", along: -3.7 },
      scale: 1.5,
      elevation: 1.45,
    },
  ];
  const after: Placed[] = [
    ...island("dining", [3.4, 2.3], look, "cafe"),
    ...island("chat", [-2.3, 2.7], look, "chat"),
    ...island("reading", [5.2, -1.4], look, "reading"),
    { kind: "lamp", name: "the corner lamp", at: [round(-width / 2 + 0.4), round(depth / 2 - 0.4)], facing: 0 },
    { kind: "plant", at: [round(width / 2 - 0.5), round(depth / 2 - 0.5)], facing: 0 },
  ];
  return build({
    name: "the lobby",
    width,
    depth,
    height: 3.2,
    palette: { walls: "#e4e1ec", floor: "tile", floorColor: "#cfd3dc" },
    look,
    // Its way out is at the open front, where no wall needs a doorway kept.
    doors: [],
    centre,
    start: { id: "middle", name: "in the middle", place: "the middle of the lobby", at: [0, 0.6], facing: 180 },
    back: [],
    left: ["windows", "lounge"],
    corner: { back: 1, left: 1 },
    flips: () => false,
    after,
  });
}

/**
 * A floor of the office, an atrium with the meeting rooms' doors round it:
 * along the back and left walls (`doors`, kept clear while it is furnished),
 * and standing along its open right side past what the walls hold, with the
 * way in at the front on the left and the stairs on at the front on the right.
 * In the middle, kept as far from every side as a door's approach: a directory
 * by the way in, a lounge, a table to work at, and plants.
 */
export function officeFloor(name: string, width: number, depth: number, doors: DoorSlot[]): Place {
  const look: Look = {
    fabric: "#3f5f7a",
    fabric2: "#c08a4a",
    wood: "#a87650",
    rug: "#4f6d8a",
    accent: "#4f81bd",
    window: 1.2,
  };
  const inner = { left: round(-width / 2 + 2.4), right: round(width / 2 - 2.6), back: round(-depth / 2 + 2.3) };
  const front = round(depth / 2 - 2.4);
  const centre: Placed[] = [
    // By the way in, a directory where the doors are listed.
    {
      id: "directory",
      name: "the directory",
      kind: "kiosk",
      at: [round(-width / 2 + 2.5), round(front - 0.2)],
      facing: 45,
      label: "Directory",
    },
    ...island("chat", [round(inner.left + 1.6), round(inner.back + 1.2)], look, "lounge"),
    ...island("worktable", [round((inner.left + inner.right) / 2 + 1), round((inner.back + front) / 2)], look, "work"),
    ...island("reading", [round(inner.right - 1), round(inner.back + 1)], look, "reading"),
  ];
  const after: Placed[] = [
    { kind: "tall_plant", at: [round(-width / 2 + 0.45), round(-depth / 2 + 0.45)], facing: 0 },
    { kind: "plant", at: [round(width / 2 - 0.5), round(-depth / 2 + 0.5)], facing: 0 },
  ];
  return build({
    name,
    width,
    depth,
    height: 3.2,
    palette: { walls: "#e6e9ee", floor: "tile", floorColor: "#d7d9dd" },
    look,
    doors: doors
      .filter((d) => d.wall === "back" || d.wall === "left")
      .map((d) => ({ wall: d.wall as "back" | "left", at: d.along })),
    centre,
    start: {
      id: "middle",
      name: "in the middle",
      place: "the middle of the floor",
      at: [0, round(front - 0.4)],
      facing: 180,
    },
    back: [],
    left: [],
    corner: { back: 1, left: 1 },
    flips: () => false,
    after,
    lampsAt: [
      [round(inner.left - 0.6), round(front + 0.6)],
      [round(inner.right + 0.6), round(inner.back - 0.6)],
    ],
  });
}
