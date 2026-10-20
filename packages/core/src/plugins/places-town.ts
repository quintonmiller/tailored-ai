/**
 * The world as a town you walk round outdoors, with buildings you go into.
 *
 * In the middle is the square: paving round a fountain, benches and lamps,
 * the town hall along its north side with the kiosks in front of it and the
 * task board, the big screen, the calendar and the square's widgets on its
 * front, and stands with more of them at the square's top corners. Through the
 * square runs the avenue, east to west. East of the square, on the avenue,
 * is the office, where the rooms agents talk in are; behind it, a park with a
 * pond. Off the avenue run lanes of homes, each agent's a house of its own
 * facing its lane, `LANE_HOMES` to a lane at most: one lane north of the
 * avenue and one south of it, west of the square first, then east, then
 * further west. Main street runs south from the square, past the shared
 * places and the meeting rooms that have a building of their own (a tavern,
 * a studio, a workshop, a library), down to the shore, where a beach room is
 * a hut on the sand. A stream comes down the west side of town to the sea,
 * under a bridge where the avenue crosses it and another on the shore. Each
 * area an agent puts its places in is a plot of its own at the edge of town,
 * fenced, at the end of the avenue.
 *
 * Homes go into lanes in name order, cut where the first letter changes (see
 * `packLanes`), so a new agent changes only the lane it joins. Lanes,
 * landmarks and plots each have a place of their own, and each plot its own
 * end of the avenue: nothing moves because something was added somewhere
 * else, apart from what is further along main street than a new shared
 * place, and plots further out than a new lane, or than a new plot at their
 * end of the avenue.
 *
 * Units are metres, +X east and +Z south, toward the viewer, as in a room. A
 * `facing` of 0° looks south (+Z), 90° east. Pure: the same places always
 * give the same town.
 */
import { KINDS, type Place, type PlaceItem, type PlaceSpot, withSpots } from "./places-layout.js";

/** The town's place id: the outdoors, as one place. */
export const TOWN = "town";
/** What the town is called. */
export const TOWN_NAME = "the town";

/** The most homes on one lane, both sides together, before the next lane takes over. */
export const LANE_HOMES = 12;

type P = [number, number];

/** What a building is, which is how the page draws it. */
export type BuildingKind =
  | "house"
  | "hall"
  | "office"
  | "tavern"
  | "studio"
  | "workshop"
  | "library"
  | "hut"
  | "shop"
  | "cottage";

/** A building in the town, standing on its own footprint, with a door in the middle of its front. */
export interface Building {
  /** The place its door opens on. */
  id: string;
  kind: BuildingKind;
  /** The middle of its footprint. */
  at: P;
  /** The way its front faces, in degrees. */
  facing: number;
  /** Its width along the front, its depth, and how tall its walls are. */
  size: [number, number, number];
  /** What its door's plate says. */
  label: string;
  /** The agent whose home it is. */
  owner?: string;
  /** For a look of its own, 0–1: its roof, its storeys, its trim. */
  style: number;
  /** The street its door is on, which is what the door out of it says: "Maple Lane", "the square". */
  street: string;
  /**
   * The pilasters along its front, as x from its middle, and how wide each
   * is: the town hall's. The page draws them; nothing hung on the front
   * crosses one.
   */
  pillars?: { x: number[]; width: number };
}

/** A road's centre line, sampled along it, and how wide it is. */
export interface Road {
  id: string;
  /** What the street is called, for a lane; the map shows it. */
  name?: string;
  kind: "avenue" | "street" | "lane" | "path" | "promenade";
  width: number;
  points: P[];
}

/** An area of an agent's own: a fenced plot at the edge of town, with its places on it. */
export interface Plot {
  id: string;
  name: string;
  at: P;
  size: P;
  /** Where its gate is, on the path in. */
  gate: P;
}

export interface Town {
  /** The ground you can walk on, centred on the square. */
  width: number;
  depth: number;
  square: { at: P; radius: number };
  /** The shore: sand from `sand` south to `sea`, the sea past that (z). */
  shore: { sand: number; sea: number };
  /** The stream's centre line, north to the sea, how wide it is, and where you cross it. */
  stream: { points: P[]; width: number; bridges: { at: P; facing: number; length: number }[] };
  park: { at: P; size: P; pond: { at: P; size: P } };
  roads: Road[];
  buildings: Building[];
  plots: Plot[];
  /** Trees: where, and how big (1 is a tree of an ordinary size). */
  trees: [number, number, number][];
  lamps: P[];
}

/** A place in the town, as the town needs to know it. */
export interface TownPlace {
  id: string;
  label: string;
  owner?: string;
}

/** What the town is built from: the homes on its lanes, what is on main street, the beach huts, the plots. */
export interface TownInput {
  homes: TownPlace[];
  /** Shared places, and meeting rooms with a building of their own by theme (`kind`), along main street. */
  street: (TownPlace & { kind: BuildingKind })[];
  /** Beach rooms: a hut each, on the sand. */
  huts: TownPlace[];
  /** Whether there are meeting rooms for the office to hold. */
  office: boolean;
  /** The areas of agents' own, by name, each with its places. */
  plots: { id: string; name: string; places: TownPlace[] }[];
}

// --------------------------------------------------------------------------
// Sizes
// --------------------------------------------------------------------------

/** The square's radius. */
const SQUARE = 11;
const AVENUE_WIDTH = 7;
const LANE_WIDTH = 5;
const MAIN_WIDTH = 6;
/** A house: width along its front, depth, and its walls' height. */
const HOUSE: [number, number, number] = [5.2, 4.6, 3];
/** From one house to the next along a lane, middle to middle. */
const PITCH = 7.6;
/** From a lane's middle to a house's middle: half the lane, a front garden, half the house. */
const HOUSE_OFFSET = LANE_WIDTH / 2 + 2 + HOUSE[1] / 2;
/** How far along its lane the first houses are, and how much lane goes on past the last. */
const LANE_START = 3.5;
const LANE_END = 5;
/** How far a lane bows out to one side halfway along it. */
const LANE_BEND = 3;
/** The x of each column of lanes, in the order they fill: west of the square, then east, then further west. */
const COLUMN_GAP = 30;
const FIRST_WEST = -35;
const FIRST_EAST = 50;
/** Buildings along main street: their sizes by kind, and from one to the next. */
const STREET_SIZES: Partial<Record<BuildingKind, [number, number, number]>> = {
  tavern: [8, 7, 4.2],
  studio: [7.4, 6.4, 4],
  workshop: [8.4, 7, 4.6],
  library: [8.4, 7, 5],
  shop: [7, 6, 3.6],
};
const STREET_PITCH = 11;
/** A hut on the sand. */
const HUT: [number, number, number] = [4.4, 4, 3];
/** The stream: where its middle is across the town, how far it wanders either side, and how wide it is. */
const STREAM_X = -18.5;
const STREAM_WANDER = 1.1;
const STREAM_WIDTH = 2.6;
/** How far past everything the ground you can walk on goes. */
const MARGIN = 14;

const round = (n: number) => Math.round(n * 100) / 100;
const pt = (x: number, z: number): P => [round(x), round(z)];

/** A number from 0 to 1 that words always give the same of. */
function hashed(words: string): number {
  let h = 2166136261;
  for (const c of words) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

/** Lane names, in the order lanes are made: a lane keeps its name however many there are. */
const LANE_NAMES = [
  "Maple Lane",
  "Willow Way",
  "Birch Row",
  "Cedar Close",
  "Elm Street",
  "Linden Walk",
  "Rowan Lane",
  "Aspen Way",
  "Hazel Row",
  "Juniper Close",
  "Larch Street",
  "Poplar Walk",
];
const laneName = (i: number) => {
  const name = LANE_NAMES[i % LANE_NAMES.length];
  return i < LANE_NAMES.length ? name : `${name} ${Math.floor(i / LANE_NAMES.length) + 1}`;
};

/** What a plot's gate says: its name without "the", starting with a capital. */
const plotName = (name: string) => {
  const bare = name.replace(/^(the|a|an)\s+/i, "").trim() || name;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
};

/** The avenue's centre line at `x`: straight through the square, a gentle wave either side of it. */
export function avenueZ(x: number): number {
  const off = Math.abs(x) - SQUARE - 2;
  return off <= 0 ? 0 : round(1.4 * Math.sin(off / 9) * Math.sign(x));
}

/** The stream's centre line at `z`. */
export function streamX(z: number): number {
  return round(STREAM_X + STREAM_WANDER * Math.sin(z / 7));
}

/**
 * Where `n` huts stand along the sand at `z`, across the town: out from the
 * middle, east then west, 8 m apart, leaving out any spot the stream runs
 * through on its way into the sea, banks and all. The spots are the same
 * however many huts there are, so one more takes the next and moves none.
 */
function hutSpots(n: number, z: number): number[] {
  const clear = HUT[0] / 2 + STREAM_WIDTH / 2 + 1.5;
  const stream = [z - HUT[1] / 2, z, z + HUT[1] / 2].map(streamX);
  const spots: number[] = [];
  for (let k = 0; spots.length < n; k++)
    for (const side of [1, -1]) {
      const x = side * (7 + k * 8);
      if (spots.length < n && stream.every((s) => Math.abs(x - s) >= clear)) spots.push(x);
    }
  return spots;
}

/** The facing that looks along a direction on the floor. */
const facingOf = (dx: number, dz: number) => round((Math.atan2(dx, dz) * 180) / Math.PI);

/**
 * Places, in order, cut into lanes of at most `cap`: each lane takes whole runs
 * of a first letter while they fit, so one more name changes only the lane it
 * falls in, unless that lane was full. A letter with more than a lane's worth
 * fills the lane it starts in and then takes whole lanes of its own.
 */
export function packLanes<T>(items: T[], letter: (item: T) => string, cap = LANE_HOMES): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last && letter(last[0]) === letter(item)) last.push(item);
    else runs.push([item]);
  }
  const lanes: T[][] = [];
  let current: T[] = [];
  for (const run of runs) {
    if (run.length <= cap) {
      if (current.length + run.length > cap) {
        lanes.push(current);
        current = [];
      }
      current.push(...run);
      continue;
    }
    // Topping up what is being filled; a full one goes as it is.
    const top = current.length ? cap - current.length : 0;
    if (current.length) lanes.push([...current, ...run.slice(0, top)]);
    current = [];
    for (let i = top; i < run.length; i += cap) {
      const part = run.slice(i, i + cap);
      if (part.length === cap) lanes.push(part);
      else current = part;
    }
  }
  if (current.length) lanes.push(current);
  return lanes;
}

/** The letter a place files under on a lane: its plate's first letter, or `#`. */
export const letterOf = (label: string) => {
  const c = label.replace(/^#/, "").charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
};

/** Where lane `i` is: its column's x, and north or south of the avenue. */
export function laneSlot(i: number): { x: number; north: boolean } {
  const column = Math.floor(i / 2);
  // West, east, west, east: a column at a time, each further out on its side.
  const side = column % 2 === 0 ? "west" : "east";
  const k = Math.floor(column / 2);
  return { x: side === "west" ? FIRST_WEST - k * COLUMN_GAP : FIRST_EAST + k * COLUMN_GAP, north: i % 2 === 0 };
}

/**
 * A lane's centre line, from the avenue outward, sampled every metre, with
 * where along it each pair of houses is. It bows out to one side halfway, a
 * different way on different lanes.
 */
function laneLine(i: number, pairs: number): { points: P[]; at: (t: number) => { p: P; tangent: P }; length: number } {
  const { x, north } = laneSlot(i);
  const dir = north ? -1 : 1;
  const z0 = avenueZ(x) + (dir * AVENUE_WIDTH) / 2;
  const length = LANE_START + pairs * PITCH + LANE_END;
  const bend = LANE_BEND * (i % 4 < 2 ? 1 : -1) * (north ? 1 : -1);
  const at = (t: number) => {
    const k = Math.PI / length;
    const p: P = [x + bend * Math.sin(k * t), z0 + dir * t];
    const dx = bend * k * Math.cos(k * t);
    const n = Math.hypot(dx, 1);
    return { p, tangent: [dx / n, dir / n] as P };
  };
  const points: P[] = [];
  for (let t = 0; t < length; t += 1) points.push(pt(...at(t).p));
  points.push(pt(...at(length).p));
  return { points, at, length };
}

/** A building beside a road at a point on it: `side` 1 to the road's right as you go along it, -1 to its left. */
function beside(road: { p: P; tangent: P }, side: 1 | -1, offset: number): { at: P; facing: number; front: P } {
  const [tx, tz] = road.tangent;
  // The road's right, going along it: +X for a road going north (-Z).
  const right: P = [-tz, tx];
  const at = pt(road.p[0] + right[0] * offset * side, road.p[1] + right[1] * offset * side);
  // Its front faces back to the road.
  const front: P = [-right[0] * side, -right[1] * side];
  return { at, facing: facingOf(front[0], front[1]), front };
}

/** Where a building's door is: the middle of its front, and the way out of it. */
export function doorOfBuilding(b: Pick<Building, "at" | "facing" | "size">): { at: P; facing: number } {
  const f = (b.facing * Math.PI) / 180;
  const half = b.size[1] / 2;
  return { at: pt(b.at[0] + Math.sin(f) * half, b.at[1] + Math.cos(f) * half), facing: b.facing };
}

/** The four corners of a building's footprint, grown by `grow` all round. */
export function cornersOf(b: Pick<Building, "at" | "facing" | "size">, grow = 0): P[] {
  const f = (b.facing * Math.PI) / 180;
  const [w, d] = [b.size[0] / 2 + grow, b.size[1] / 2 + grow];
  const across: P = [Math.cos(f), -Math.sin(f)];
  const ahead: P = [Math.sin(f), Math.cos(f)];
  return [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([a, b2]) => [
    b.at[0] + across[0] * w * a + ahead[0] * d * b2,
    b.at[1] + across[1] * w * a + ahead[1] * d * b2,
  ]);
}

/** Whether a point is inside a building's footprint, grown by `grow`. */
export function inBuilding(b: Pick<Building, "at" | "facing" | "size">, [x, z]: P, grow = 0): boolean {
  const f = (b.facing * Math.PI) / 180;
  const dx = x - b.at[0];
  const dz = z - b.at[1];
  const across = dx * Math.cos(f) - dz * Math.sin(f);
  const ahead = dx * Math.sin(f) + dz * Math.cos(f);
  return Math.abs(across) <= b.size[0] / 2 + grow && Math.abs(ahead) <= b.size[1] / 2 + grow;
}

/** Whether two footprints overlap, with `gap` kept between them: the separating axis test. */
export function overlaps(
  a: Pick<Building, "at" | "facing" | "size">,
  b: Pick<Building, "at" | "facing" | "size">,
  gap = 0,
) {
  const ca = cornersOf(a, gap / 2);
  const cb = cornersOf(b, gap / 2);
  for (const shape of [ca, cb])
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = shape[i];
      const [x2, z2] = shape[(i + 1) % 4];
      const axis: P = [z1 - z2, x2 - x1];
      const proj = (c: P[]) => c.map(([x, z]) => x * axis[0] + z * axis[1]);
      const pa = proj(ca);
      const pb = proj(cb);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  return true;
}

// --------------------------------------------------------------------------
// The town
// --------------------------------------------------------------------------

/** The town hall's footprint: the north side of the square, facing south across it. */
const HALL_AT: P = [0, -20];
const HALL_SIZE: [number, number, number] = [18, 9, 6.5];
/** The town hall's pilasters: at either end of its front and either side of its door. */
export const HALL_PILLARS = { x: [-HALL_SIZE[0] / 2 + 0.3, -1.4, 1.4, HALL_SIZE[0] / 2 - 0.3], width: 0.55 };
/** The office: on the avenue east of the square, facing south across it. */
const OFFICE_AT: P = [24, -10.5];
const OFFICE_SIZE: [number, number, number] = [14, 10, 9];

/** The whole town, from what is in it. */
export function layTown(input: TownInput, ids: { hall: string; office: string }): Town {
  const buildings: Building[] = [];
  const roads: Road[] = [];
  const lamps: P[] = [];
  const trees: [number, number, number][] = [];

  buildings.push({
    id: ids.hall,
    kind: "hall",
    at: HALL_AT,
    facing: 0,
    size: HALL_SIZE,
    label: "Town hall",
    style: 0.5,
    street: "The square",
    pillars: HALL_PILLARS,
  });
  if (input.office)
    buildings.push({
      id: ids.office,
      kind: "office",
      at: OFFICE_AT,
      facing: 0,
      size: OFFICE_SIZE,
      label: "Office",
      style: 0.5,
      street: "The Avenue",
    });

  // The lanes of homes, in name order, a lane's worth at a time.
  const lanes = packLanes(input.homes, (h) => letterOf(h.label));
  let west = 0;
  let east = 0;
  // How far south the lanes go: the shore is past the end of the longest.
  let south = 0;
  for (const [i, homes] of lanes.entries()) {
    const pairs = Math.ceil(homes.length / 2);
    const line = laneLine(i, Math.max(2, pairs));
    const slot = laneSlot(i);
    if (slot.x < 0) west = Math.min(west, slot.x - HOUSE_OFFSET - HOUSE[1]);
    else east = Math.max(east, slot.x + HOUSE_OFFSET + HOUSE[1]);
    roads.push({ id: `lane-${i + 1}`, name: laneName(i), kind: "lane", width: LANE_WIDTH, points: line.points });
    if (!slot.north) south = Math.max(south, ...line.points.map((p) => p[1]));
    for (const [k, home] of homes.entries()) {
      // Read in pairs down the lane, the first on the right as you walk away from the avenue, the next facing it.
      const t = LANE_START + (Math.floor(k / 2) + 0.5) * PITCH;
      const { at, facing } = beside(line.at(t), k % 2 ? -1 : 1, HOUSE_OFFSET);
      buildings.push({
        id: home.id,
        kind: "house",
        at,
        facing,
        size: HOUSE,
        label: home.label,
        ...(home.owner ? { owner: home.owner } : {}),
        style: hashed(home.id),
        street: laneName(i),
      });
    }
    // A tree behind each pair of plots, between the back gardens, and lamps along the lane.
    for (let k = 0; k <= Math.max(2, pairs); k++) {
      const t = LANE_START + k * PITCH;
      for (const side of [1, -1] as const) {
        const back = beside(line.at(t), side, HOUSE_OFFSET + HOUSE[1] / 2 + 1.6);
        trees.push([back.at[0], back.at[1], round(0.85 + hashed(`${i}:${k}:${side}`) * 0.4)]);
      }
      if (k % 2 === 1) {
        const lamp = beside(line.at(t), k % 4 === 1 ? 1 : -1, LANE_WIDTH / 2 + 0.6);
        lamps.push(lamp.at);
      }
    }
    // The end of the lane: a tree in its turning circle.
    const end = line.at(line.length);
    trees.push([round(end.p[0]), round(end.p[1] + Math.sign(end.tangent[1]) * 2.5), 1.25]);
  }

  // Main street, south from the square to the shore, its buildings in turn down each side.
  const street = input.street;
  const length = Math.max(26, 6 + Math.ceil(street.length / 2) * STREET_PITCH + 4, south + 4 - SQUARE);
  const shoreZ = SQUARE + length;
  const mainAt = (t: number) => {
    const k = Math.PI / length;
    const p: P = [2.4 * Math.sin(k * t), SQUARE + t];
    const dx = 2.4 * k * Math.cos(k * t);
    const n = Math.hypot(dx, 1);
    return { p, tangent: [dx / n, 1 / n] as P };
  };
  const mainPoints: P[] = [];
  for (let t = 0; t < length; t += 1) mainPoints.push(pt(...mainAt(t).p));
  mainPoints.push(pt(...mainAt(length).p));
  roads.push({ id: "main-street", name: "Main Street", kind: "street", width: MAIN_WIDTH, points: mainPoints });
  for (const [k, place] of street.entries()) {
    const size = STREET_SIZES[place.kind] ?? (STREET_SIZES.shop as [number, number, number]);
    const t = 6 + (Math.floor(k / 2) + 0.5) * STREET_PITCH;
    const { at, facing } = beside(mainAt(t), k % 2 ? -1 : 1, MAIN_WIDTH / 2 + 1.6 + size[1] / 2);
    buildings.push({
      id: place.id,
      kind: place.kind,
      at,
      facing,
      size,
      label: place.label,
      style: hashed(place.id),
      street: "Main Street",
    });
  }
  for (let t = 8; t < length - 2; t += 12) {
    const side = Math.round(t / 12) % 2 ? 1 : -1;
    lamps.push(beside(mainAt(t), side, MAIN_WIDTH / 2 + 0.6).at);
  }

  // The shore: a promenade along the top of the beach, the sand, and the huts on it facing the sea.
  const sand = shoreZ + 3;
  const sea = sand + 15;
  const hutXs = hutSpots(input.huts.length, sand + 5);
  for (const [j, hut] of input.huts.entries()) {
    buildings.push({
      id: hut.id,
      kind: "hut",
      at: pt(hutXs[j], sand + 5),
      facing: 0,
      size: HUT,
      label: hut.label,
      style: hashed(hut.id),
      street: "The beach",
    });
  }

  // How far the avenue goes: past the furthest lane on each side, on to the plots, and never short of the office.
  const plots: Plot[] = [];
  const plotBuildings: Building[] = [];
  let westEnd = Math.min(west, -SQUARE - 16) - 6;
  let eastEnd = Math.max(east, input.office ? OFFICE_AT[0] + OFFICE_SIZE[0] / 2 + 6 : SQUARE + 16) + 6;
  const avenueWest = westEnd;
  const avenueEast = eastEnd;
  for (const area of input.plots) {
    const n = area.places.length;
    // One row along the back of the plot facing the path through it, up to five; past that, a row along the front
    // facing back as well, the two as long as each other, the plot growing wider to hold them.
    const row = n <= 5 ? n : Math.ceil(n / 2);
    const width = Math.max(16, row * 7.6 + 4);
    const depth = n > 5 ? 26 : 16;
    // Each plot's end of the avenue is its own, from its id, so one added never sends another to the other end.
    const toWest = hashed(`plot\n${area.id}`) < 0.5;
    const cx = toWest ? westEnd - 4 - width / 2 : eastEnd + 4 + width / 2;
    if (toWest) westEnd = cx - width / 2;
    else eastEnd = cx + width / 2;
    const at = pt(cx, depth > 16 ? 3 : 0);
    plots.push({
      id: area.id,
      name: area.name,
      at,
      size: [width, depth],
      gate: pt(toWest ? cx + width / 2 : cx - width / 2, 0),
    });
    for (const [k, place] of area.places.entries()) {
      const front = k < row;
      const i = front ? k : k - row;
      const across = front ? row : n - row;
      const x = cx - ((across - 1) * 7.6) / 2 + i * 7.6;
      plotBuildings.push({
        id: place.id,
        kind: place.owner ? "house" : "cottage",
        at: pt(x, front ? -4.6 : 9.8),
        facing: front ? 0 : 180,
        size: place.owner ? HOUSE : [4.8, 4.4, 2.8],
        label: place.label,
        ...(place.owner ? { owner: place.owner } : {}),
        style: hashed(place.id),
        street: plotName(area.name),
      });
    }
  }
  buildings.push(...plotBuildings);

  // The avenue, east to west through the square, and the paths on to the plots beyond its ends.
  const avenue: P[] = [];
  for (let x = avenueWest; x <= avenueEast; x += 2) avenue.push(pt(x, avenueZ(x)));
  roads.unshift({ id: "avenue", name: "The Avenue", kind: "avenue", width: AVENUE_WIDTH, points: avenue });
  if (westEnd < avenueWest)
    roads.push({
      id: "path-west",
      kind: "path",
      width: 3,
      points: [pt(avenueWest, avenueZ(avenueWest)), pt(westEnd + 2, 2)],
    });
  if (eastEnd > avenueEast)
    roads.push({
      id: "path-east",
      kind: "path",
      width: 3,
      points: [pt(avenueEast, avenueZ(avenueEast)), pt(eastEnd - 2, 2)],
    });
  for (let x = avenueWest + 6; x < avenueEast - 3; x += 16) {
    if (Math.abs(x) < SQUARE + 2) continue;
    const side = Math.round(x / 16) % 2 ? 1 : -1;
    lamps.push(pt(x, avenueZ(x) + side * (AVENUE_WIDTH / 2 + 0.6)));
  }
  const promenade: P[] = [];
  // Along the whole shore, from the furthest lane on one side to the furthest on the other.
  const shoreHalf = Math.max(30, -west, east, ...hutXs.map((x) => Math.abs(x) + 8));
  for (let x = -shoreHalf; x <= shoreHalf; x += 2) promenade.push(pt(x, shoreZ + 1.2));
  roads.push({ id: "promenade", name: "The Promenade", kind: "promenade", width: 4, points: promenade });

  // Lamps round the square, and trees in its corners.
  for (let a = 0; a < 8; a++) {
    const angle = ((a + 0.5) * Math.PI) / 4;
    lamps.push(pt(Math.sin(angle) * (SQUARE - 0.8), Math.cos(angle) * (SQUARE - 0.8)));
  }

  // The stream, from the north edge down to the sea, under the avenue and the promenade.
  const north = Math.min(
    -30,
    ...buildings.map((b) => b.at[1] - b.size[1]),
    ...plots.map((p) => p.at[1] - p.size[1] / 2),
  );
  const streamPoints: P[] = [];
  for (let z = north - MARGIN - 20; z <= sea + 2; z += 2) streamPoints.push(pt(streamX(z), z));
  const bridges = [
    { at: pt(streamX(avenueZ(STREAM_X)), avenueZ(STREAM_X)), facing: 90, length: STREAM_WIDTH + 3 },
    { at: pt(streamX(shoreZ + 1.2), shoreZ + 1.2), facing: 90, length: STREAM_WIDTH + 2.4 },
  ];

  // The park behind the office: a pond, trees round it.
  const park = { at: pt(23, -29), size: [22, 15] as P, pond: { at: pt(25, -29.5), size: [8, 5] as P } };
  for (const [dx, dz, s] of [
    [-9, -5, 1.2],
    [-6, 5, 1],
    [-9, 2, 0.9],
    [7, -5.5, 1.1],
    [9, 4, 1.3],
    [-2, -6.5, 1],
    [3, 6, 0.95],
    [10, -1, 1],
  ])
    trees.push([round(park.at[0] + dx), round(park.at[1] + dz), s]);
  // By the town hall, either side of it; along the shore, palms are the props' (see `townPlace`).
  trees.push([-12.5, -19, 1.2], [12.5, -19, 1.2], [-14, -9, 1], [14.5, 9.5, 1], [-14.5, 9.5, 1.05]);

  // The ground you can walk on: everything with a margin round it, the sea for its south edge.
  const xs = [
    ...buildings.flatMap((b) => cornersOf(b).map((c) => c[0])),
    ...plots.flatMap((p) => [p.at[0] - p.size[0] / 2, p.at[0] + p.size[0] / 2]),
    avenueWest,
    avenueEast,
  ];
  const zs = [...buildings.flatMap((b) => cornersOf(b).map((c) => c[1])), ...plots.map((p) => p.at[1] - p.size[1] / 2)];
  const halfW = Math.max(...xs.map(Math.abs)) + MARGIN;
  const halfD = Math.max(-Math.min(...zs) + MARGIN, sea);
  const width = round(halfW * 2);
  const depth = round(halfD * 2);

  // Trees all round the edge of town, outside what you can walk on, so the town sits in woods by the sea.
  const woods: [number, number, number][] = [];
  const rand = seededRandom(`woods\n${width}\n${depth}`);
  for (let k = 0; k < 900 && woods.length < 340; k++) {
    const x = (rand() - 0.5) * (width + 70);
    const z = -halfD - 30 + rand() * (halfD + 30 + sea - 2);
    const inside = Math.abs(x) < halfW - 2 && Math.abs(z) < halfD - 2;
    if (inside || z > sea - 4) continue;
    if (Math.abs(x - streamX(z)) < STREAM_WIDTH + 1.5) continue;
    woods.push([round(x), round(z), round(0.9 + rand() * 0.7)]);
  }
  trees.push(...woods);

  // Trees about the empty ground in town, on a loose grid, clear of the roads and of every door.
  const doors = buildings.map((b) => doorOfBuilding(b).at);
  const scatter = seededRandom(`scatter\n${width}\n${depth}`);
  for (let x = -halfW + 6; x < halfW - 6; x += 9)
    for (let z = -halfD + 6; z < sand - 3; z += 9) {
      if (scatter() > 0.55) continue;
      const p: P = [round(x + (scatter() - 0.5) * 6), round(z + (scatter() - 0.5) * 6)];
      if (roads.some((r) => nearLine(r.points, p, r.width / 2 + 3))) continue;
      if (buildings.some((b) => inBuilding(b, p, 2.5)) || doors.some((d) => Math.hypot(d[0] - p[0], d[1] - p[1]) < 5))
        continue;
      if (Math.hypot(p[0], p[1]) < SQUARE + 4) continue;
      trees.push([p[0], p[1], round(0.8 + scatter() * 0.5)]);
    }

  // Keep trees out of buildings, off roads and out of the water.
  const clear = ([x, z]: [number, number, number]) =>
    !buildings.some((b) => inBuilding(b, [x, z], 1.2)) &&
    !roads.some((r) => nearLine(r.points, [x, z], r.width / 2 + 1)) &&
    Math.abs(x - streamX(z)) > STREAM_WIDTH / 2 + 1 &&
    !(
      Math.abs(x - park.pond.at[0]) < park.pond.size[0] / 2 + 1 &&
      Math.abs(z - park.pond.at[1]) < park.pond.size[1] / 2 + 1
    ) &&
    Math.hypot(x, z) > SQUARE + 1 &&
    !plots.some((p) => Math.abs(x - p.at[0]) < p.size[0] / 2 + 1 && Math.abs(z - p.at[1]) < p.size[1] / 2 + 1);

  return {
    width,
    depth,
    square: { at: [0, 0], radius: SQUARE },
    shore: { sand: round(sand), sea: round(sea) },
    stream: { points: streamPoints, width: STREAM_WIDTH, bridges },
    park,
    roads,
    buildings,
    plots,
    trees: trees.filter(clear),
    lamps: lamps.filter(([x, z]) => !buildings.some((b) => inBuilding(b, [x, z], 0.5))),
  };
}

/** Whether a point is within `reach` of a line through `points`. */
export function nearLine(points: P[], [x, z]: P, reach: number): boolean {
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const dx = bx - ax;
    const dz = bz - az;
    const len = dx * dx + dz * dz;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len)) : 0;
    if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) <= reach) return true;
  }
  return false;
}

/** The same numbers from the same words, 0 to 1. */
function seededRandom(words: string): () => number {
  let s = Math.floor(hashed(words) * 2 ** 31) || 1;
  return () => {
    s = (Math.imul(s, 48271) % 2147483647) >>> 0;
    return s / 2147483647;
  };
}

// --------------------------------------------------------------------------
// The town as a place to stand in
// --------------------------------------------------------------------------

/** The town as a place: the square's kiosks, board, screen, calendar and benches, and the town itself for the page. */
export type TownPlaceRecord = Place & { town: Town };

/**
 * The town as the page draws it: a place like any other, its ground the size
 * of the town, with the things in it a room has (the kiosks, the task board,
 * the big screen and the calendar on the town hall's front, benches round the
 * fountain and in the park, palms and umbrellas on the beach), where you start
 * on the square, and the town's own plan, which the page builds the buildings,
 * roads, trees and water from.
 */
export function townPlace(town: Town): TownPlaceRecord {
  const props: PlaceItem[] = [];
  const add = (item: Omit<PlaceItem, "name"> & { name?: string }) =>
    props.push({ name: `the ${KINDS[item.kind].noun}`, ...item } as PlaceItem);
  const front = HALL_AT[1] + HALL_SIZE[1] / 2 + 0.03;
  // On the town hall's front, either side of its door: the big screen, the board of open tasks, the calendar. Each in
  // a bay between the pilasters (`HALL_PILLARS`), with the square's widgets, spaced evenly along it.
  add({
    id: "screen",
    name: "the big screen",
    kind: "screen",
    at: [-3.9, front],
    facing: 0,
    scale: 2.2,
    elevation: 1.7,
  });
  add({
    id: "board",
    name: "the task board",
    kind: "board",
    at: [5.2, front],
    facing: 0,
    scale: 1.4,
    elevation: 1.2,
    label: "Open tasks",
    action: "tasks",
  });
  add({
    id: "calendar",
    name: "the calendar",
    kind: "calendar",
    at: [7.3, front],
    facing: 0,
    scale: 1.4,
    elevation: 1.35,
  });
  // The widgets the square has, for a glance from anywhere on it: who is doing what, left of the big screen, and what
  // waits on you, right of the door; over the door, between its pilasters, the latest lines from every room, like a
  // marquee; and on stands at the square's top corners, turned to its middle, what got done lately and the numbers
  // behind it. Bigger than indoors, as everything on the hall's front is, to read from across the square.
  add({
    id: "status",
    name: "the status board",
    kind: "status_board",
    at: [-7.04, front],
    facing: 0,
    scale: 1.25,
    elevation: 1.3,
  });
  add({
    id: "needs",
    name: "the needs-you board",
    kind: "needs_board",
    at: [2.95, front],
    facing: 0,
    scale: 1.4,
    elevation: 1.3,
  });
  add({ id: "ticker", name: "the ticker", kind: "ticker", at: [0, front], facing: 0, scale: 1.1, elevation: 3.1 });
  const stand = { kind: "display", scale: 1.8 } as const;
  add({ ...stand, id: "feed", name: "the activity stand", shows: "feed", at: [-9.4, -10.4], facing: 42 });
  add({ ...stand, id: "chart", name: "the chart stand", shows: "chart", at: [9.4, -10.4], facing: -42 });
  // In front of it, on the square: a kiosk each to make a new agent, a new task and a new room.
  const kiosk = (id: string, x: number, label: string, action: PlaceItem["action"]) =>
    add({
      id,
      name: `the ${label.toLowerCase()} kiosk`,
      kind: "kiosk",
      at: [x, round(front + 2.6)],
      facing: 0,
      label,
      action,
    });
  // Under the big screen, to the left of the door, so the way in and out of the town hall stays clear.
  kiosk("kiosk-agent", -6.6, "New agent", "new-agent");
  kiosk("kiosk-task", -4.4, "New task", "new-task");
  kiosk("kiosk-room", -2.2, "New room", "new-room");
  // Benches round the fountain, facing it, and two by the pond.
  for (const [i, angle] of [45, 135, 225, 315].entries()) {
    const a = (angle * Math.PI) / 180;
    add({
      id: `bench-${i + 1}`,
      name: i ? `the bench ${i + 1}` : "the bench",
      kind: "bench",
      at: [round(Math.sin(a) * 5.6), round(Math.cos(a) * 5.6)],
      facing: round(angle + 180),
    });
  }
  const pond = town.park.pond;
  add({
    id: "pond-bench",
    name: "the bench by the pond",
    kind: "bench",
    at: [pond.at[0], round(pond.at[1] + pond.size[1] / 2 + 1.4)],
    facing: 180,
  });
  add({
    id: "pond-bench-2",
    name: "the other bench by the pond",
    kind: "bench",
    at: [round(pond.at[0] - pond.size[0] / 2 - 1.4), pond.at[1]],
    facing: 90,
  });
  // On the beach: palms and umbrellas between the huts.
  const sandMiddle = round((town.shore.sand + town.shore.sea) / 2);
  for (const [i, x] of [-11, 3, 19].entries()) {
    add({
      id: `palm-${i + 1}`,
      name: i ? `the palm ${i + 1}` : "the palm",
      kind: "palm",
      at: [x, round(sandMiddle + 3)],
      facing: 0,
      scale: 1.6,
    });
    add({
      id: `umbrella-${i + 1}`,
      name: i ? `the umbrella ${i + 1}` : "the umbrella",
      kind: "umbrella",
      at: [x + 4, round(sandMiddle + 4)],
      facing: 0,
      color: ["#e05a47", "#3f8fd2", "#f2b134"][i],
    });
  }
  const start: PlaceSpot = { id: "square", name: "on the square", place: "the square", at: [0, 7], facing: 180 };
  return {
    ...withSpots({
      name: TOWN_NAME,
      width: town.width,
      depth: town.depth,
      height: 3,
      floor: "concrete",
      props,
      spots: [start],
      start: start.id,
    }),
    town,
  };
}

/** Where a building's door is in the town, and where it goes. */
export interface TownDoor {
  wall: "front";
  along: 0;
  at: P;
  facing: number;
}

/** Every building's door, where it stands on the building's front and the way it faces. */
export function townDoors(town: Town): (TownDoor & { building: Building })[] {
  return town.buildings.map((b) => ({ wall: "front", along: 0, ...doorOfBuilding(b), building: b }));
}
