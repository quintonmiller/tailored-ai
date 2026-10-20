/**
 * The room the avatar stands in, as data: its size, the furniture, and the
 * named spots a figure can stand at. The stage builds it from simple shapes,
 * so it needs no model files and matches the low-poly look of most VRM
 * avatars.
 *
 * Spots are named, never just coordinates: the avatar walks between them,
 * and when an agent moves it later, it says "the couch" and the stage works
 * out where that is. Each spot can come with something to do there.
 *
 * The agent's own room comes from the server, as a `place` record it can
 * change; the room below is what the page shows when the server has none.
 *
 * Units are metres. +X is to the viewer's right, +Z toward the viewer, and
 * the back and left walls close the room. A `facing` of 0° looks toward the
 * viewer, 90° toward +X.
 */

import type { ModelDef } from "./models";
import { OUTDOOR_FAR, type TownPlan } from "./town";

export type PropKind =
  | "rug"
  | "couch"
  | "armchair"
  | "beanbag"
  | "bed"
  | "chair"
  | "desk"
  | "table"
  | "coffee_table"
  | "side_table"
  | "bookshelf"
  | "tv"
  | "fireplace"
  | "lamp"
  | "plant"
  | "window"
  | "picture"
  | "board"
  | "kiosk"
  | "palm"
  | "umbrella"
  | "clock"
  | "shelf"
  | "laptop"
  | "books"
  | "vase"
  | "small_plant"
  | "mug"
  | "candle"
  | "aquarium"
  | "block"
  | "ball"
  | "cylinder"
  | "round_rug"
  | "sideboard"
  | "round_table"
  | "stool"
  | "easel"
  | "tall_plant"
  | "cactus"
  | "painting"
  | "poster"
  | "pegboard"
  | "table_lamp"
  | "bench"
  | "sign"
  | "screen"
  | "calendar"
  | "globe"
  | "map"
  | "mic_stand"
  | "server_rack"
  | "ledger"
  | "chessboard"
  // Models agents make from parts, by where they go (`models.ts`).
  | "model"
  | "wall_model"
  | "small_model"
  // Widgets: live pages drawn from what the server keeps (`widgets.ts`).
  | "status_board"
  | "feed"
  | "needs_board"
  | "todo"
  | "photo_wall"
  | "ticker"
  | "chart"
  | "agenda"
  | "display"
  | "monitor"
  | "cafe_table"
  | "cafe_chair"
  | "coffee_cart"
  | "whiteboard";

export interface Prop {
  id: string;
  /** What a person, or later an agent, calls it. */
  name: string;
  kind: PropKind;
  /** Floor position, [x, z]. */
  at: [number, number];
  facing: number;
  /** Height above the floor, for things on a wall or a table. */
  elevation?: number;
  /** The spot to walk to when someone clicks this. */
  spot?: string;
  /** The prop it stands on. */
  on?: string;
  /** "#rrggbb" for its main part. */
  color?: string;
  /** Size relative to normal. */
  scale?: number;
  /** The basic shapes' width, height and depth. */
  size?: [number, number, number];
  /** Words it shows: a kiosk's screen, a board's heading. */
  label?: string;
  /**
   * What clicking it does on the page: make an agent, a task or a room, or see
   * the tasks. A screen and a calendar open what they show without being told.
   */
  action?: string;
  /** For a model an agent made, its record's id: `room.models` has what it is made of. */
  model?: string;
  /** What a widget shows, for kinds that can show more than one thing: a chart's measure, a ticker's room. */
  shows?: string;
}

/** What the avatar does once it gets to a spot. */
export type Activity = "sit" | "type" | "look" | "browse";

export interface Spot {
  id: string;
  name: string;
  /** Where it is, as you would say it after "go to": "the couch". */
  place: string;
  at: [number, number];
  facing: number;
  activity?: Activity;
  /** For `sit`: where the seat is and how high, so the avatar settles onto it. */
  seat?: { at: [number, number]; height: number };
  /** The prop this spot belongs to. */
  item?: string;
  /**
   * What an idle body goes there for, on a spot the page adds by something
   * that brings none of its own (see `idleSpots` in `idle.ts`).
   */
  for?: "plant" | "board" | "counter" | "fish" | "picture";
}

export type Floor = "wood" | "carpet" | "tile" | "concrete";

export interface Room {
  name?: string;
  width: number;
  depth: number;
  height: number;
  props: Prop[];
  spots: Spot[];
  /** Where the avatar stands when the page opens. */
  start: string;
  /** "#rrggbb". */
  walls?: string;
  floor?: Floor;
  floorColor?: string;
  /** Photos taken here, newest first, by their media id: the pictures on the walls show them. */
  photos?: { media: string; what: string; at: string }[];
  /** Doors to other places, as the server lays the building out; none when the room stands on its own. */
  doors?: RoomDoor[];
  /** The look it was dressed in ("beach", "library"), or "none"; chosen or guessed from its name. */
  theme?: string;
  /** What it is for, in a line. */
  purpose?: string;
  /** What agents did to it lately with their place tool, and the person on the page, newest first. */
  changes?: RoomChange[];
  /** The town outdoors, when this is it: its buildings, roads, water and trees, which the stage builds instead of walls. */
  town?: TownPlan;
  /**
   * The models agents made that things here are, by record id, as the server sends them with the place. Not part
   * of the place's record: a write leaves it out (`recordOf`).
   */
  models?: Record<string, ModelDef>;
}

/** One change to a room: "planner added the bookshelf", and when. */
export interface RoomChange {
  /** The agent that made it, or the person, by what agents call them in rooms. */
  who: string;
  /** A few words that follow the agent's name. */
  what: string;
  at: string;
  /** Made by the person on the page: shown as "you". */
  person?: boolean;
}

/**
 * What a change to a room did to its things, so the stage can show it
 * happening: what is new or made over (another colour, size or label) grows
 * in, and what only moved or turned glides there from where it stood.
 */
export function roomChanges(before: Room, after: Room): { fresh: Set<string>; moved: Map<string, Prop> } {
  const was = new Map(before.props.map((p) => [p.id, p]));
  // A model made over since grows in again, wherever it stands; not one whose faces only show other records now.
  const made = (room: Room, id: string) =>
    JSON.stringify(room.models?.[id], (key, v) => (key === "spec" ? undefined : v));
  const madeOver = (id: string | undefined) => !!id && made(before, id) !== made(after, id);
  const fresh = new Set<string>();
  const moved = new Map<string, Prop>();
  for (const prop of after.props) {
    const old = was.get(prop.id);
    if (
      !old ||
      old.kind !== prop.kind ||
      old.color !== prop.color ||
      old.scale !== prop.scale ||
      old.label !== prop.label ||
      String(old.size) !== String(prop.size) ||
      old.model !== prop.model ||
      madeOver(prop.model)
    )
      fresh.add(prop.id);
    else if (
      old.at[0] !== prop.at[0] ||
      old.at[1] !== prop.at[1] ||
      (old.elevation ?? 0) !== (prop.elevation ?? 0) ||
      old.facing !== prop.facing
    )
      moved.set(prop.id, old);
  }
  return { fresh, moved };
}

/**
 * What the stage shows changing when a room arrives: for the same place
 * changing, what is new and what moved (see {@link roomChanges}); for another
 * place, or the first room after the stand-in, nothing, as on walking in,
 * since things in two places can share an id without being the same thing.
 */
export function changesShown(
  before: Room,
  after: Room,
  samePlace: boolean,
): ReturnType<typeof roomChanges> | undefined {
  return samePlace && before !== DEFAULT_ROOM ? roomChanges(before, after) : undefined;
}

/**
 * A door in a room: which side it is on and where along it (x on the back and
 * front, z on the left and right), the place it opens on, and what its name
 * plate says. The back and left are walls; a door on the open front or right
 * stands on its own at the floor's edge. Outdoors, a door is on the front of
 * a building: `at` says where, and `facing` the way out of it.
 */
export interface RoomDoor {
  wall: "back" | "left" | "front" | "right";
  along: number;
  at?: [number, number];
  facing?: number;
  /** The place it opens on, by id. */
  to: string;
  label: string;
  kind: "town" | "lobby" | "office" | "home" | "shared" | "room";
  /** The agent whose home it opens on: its light says what that agent is doing. */
  occupant?: string;
  /** Who put it in, for a door an agent or a person put in rather than one the town has: it can be taken out. */
  by?: string;
}

export const DEFAULT_ROOM: Room = {
  width: 4.2,
  depth: 3.6,
  height: 2.5,
  props: [
    { id: "rug", name: "the rug", kind: "rug", at: [0.1, 0.25], facing: 0, spot: "middle" },
    { id: "couch", name: "the couch", kind: "couch", at: [-0.85, -1.38], facing: 0, spot: "couch" },
    { id: "picture", name: "the picture", kind: "picture", at: [-0.85, -1.79], facing: 0, elevation: 1.55 },
    { id: "lamp", name: "the floor lamp", kind: "lamp", at: [0.25, -1.5], facing: 0 },
    { id: "desk", name: "the desk", kind: "desk", at: [1.35, -1.47], facing: 0, spot: "desk" },
    { id: "laptop", name: "the laptop", kind: "laptop", at: [1.35, -1.5], facing: 0, elevation: 0.76, spot: "desk" },
    { id: "chair", name: "the desk chair", kind: "chair", at: [0.72, -0.9], facing: 200, spot: "desk" },
    {
      id: "window",
      name: "the window",
      kind: "window",
      at: [-2.09, -0.45],
      facing: 90,
      elevation: 1.0,
      spot: "window",
    },
    { id: "bookshelf", name: "the bookshelf", kind: "bookshelf", at: [-1.9, 0.95], facing: 90, spot: "bookshelf" },
    { id: "plant", name: "the plant", kind: "plant", at: [-1.86, -1.5], facing: 0 },
  ],
  spots: [
    { id: "middle", name: "the middle of the room", place: "the middle of the room", at: [0.15, 0.35], facing: 20 },
    {
      id: "couch",
      name: "on the couch",
      place: "the couch",
      at: [-0.85, -0.72],
      facing: 0,
      activity: "sit",
      seat: { at: [-0.85, -1.25], height: 0.47 },
    },
    { id: "desk", name: "at the desk", place: "the desk", at: [1.35, -0.98], facing: 180, activity: "type" },
    { id: "window", name: "at the window", place: "the window", at: [-1.55, -0.45], facing: -90, activity: "look" },
    {
      id: "bookshelf",
      name: "by the bookshelf",
      place: "the bookshelf",
      at: [-1.4, 0.95],
      facing: -90,
      activity: "browse",
    },
  ],
  start: "middle",
};

export function spotById(room: Room, id: string): Spot | undefined {
  return room.spots.find((s) => s.id === id);
}

/**
 * The gestures the avatar can make with a cue in a spoken reply, and so the
 * ones the agent is offered there. Each has a move in `motion.ts`, as every
 * gesture the `body` tool makes does.
 */
export const GESTURES = [
  "wave",
  "nod",
  "shake",
  "shrug",
  "think",
  "bow",
  "cheer",
  "clap",
  "dance",
  "laugh",
  "salute",
  "jump",
] as const;

/** Words that mean the person watching, when the agent looks or points at them. */
const VIEWER = new Set([
  "you",
  "me",
  "the user",
  "user",
  "the person",
  "person",
  "them",
  "the viewer",
  "camera",
  "the camera",
]);

/**
 * What the avatar's body can do in this room, as a live session declares it:
 * the agent is told these moves and names, and writes cues with them.
 */
export function bodyFor(room: Room, company: string[] = []) {
  const things = [...new Set([...room.props.map((p) => p.name), ...room.spots.map((s) => s.place)])];
  // Who else is here, in the plain words the body description allows: no commas.
  const others = company.length > 1 ? `${company.slice(0, -1).join(" ")} and ${company.at(-1)}` : company[0];
  const looks = `a small figure in a cozy room${others ? ` with ${others}` : ""}`;
  return {
    looks: looks.length <= 80 ? looks : "a small figure in a cozy room with others",
    gestures: [...GESTURES],
    aimed: [
      { verb: "go", prep: "to", does: "walk somewhere", targets: room.spots.map((s) => s.place) },
      { verb: "look", prep: "at", does: "look at something", targets: ["you", ...company, ...things] },
      { verb: "point", prep: "at", does: "point at something", targets: [...company, ...things] },
    ],
  };
}

const bare = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(the|a|an|your|my)\s+/, "")
    .trim();

/** The spot a "go to" means: by its place, its name, its id, or a piece of furniture that leads there. */
export function spotFor(room: Room, target: string): Spot | undefined {
  const t = bare(target);
  const direct = room.spots.find((s) => [s.place, s.name, s.id].some((n) => bare(n) === t));
  if (direct) return direct;
  const prop = room.props.find((p) => bare(p.name) === t || bare(p.name).includes(t) || t.includes(bare(p.name)));
  if (prop?.spot) return spotById(room, prop.spot);
  return room.spots.find((s) => bare(s.place).includes(t) || t.includes(bare(s.place)));
}

/**
 * Where something to look or point at is: the viewer, a prop (at the height
 * of its middle), or a spot. Undefined when it isn't in the room.
 */
export function lookTarget(
  room: Room,
  target: string,
): { viewer: true } | { at: [number, number, number] } | undefined {
  const t = bare(target);
  if (VIEWER.has(t) || VIEWER.has(target.toLowerCase().trim())) return { viewer: true };
  const prop = room.props.find((p) => bare(p.name) === t || bare(p.name).includes(t) || t.includes(bare(p.name)));
  if (prop) {
    const middle: Partial<Record<string, number>> = {
      window: 0.5,
      picture: 0.3,
      lamp: 1.4,
      bookshelf: 1.0,
      plant: 0.6,
      tv: 0.85,
      fireplace: 0.5,
      clock: 0.18,
      aquarium: 0.2,
      bed: 0.45,
      easel: 1.1,
      tall_plant: 1.1,
      cactus: 0.5,
      painting: 0.4,
      poster: 0.42,
      pegboard: 0.38,
      sideboard: 0.5,
      table_lamp: 0.3,
    };
    const size = prop.size ? prop.size[1] / 2 : undefined;
    const up = (size ?? middle[prop.kind] ?? 0.4) * (prop.scale ?? 1);
    return { at: [prop.at[0], (prop.elevation ?? 0) + up, prop.at[1]] };
  }
  const spot = spotFor(room, target);
  return spot ? { at: [spot.at[0], 0.5, spot.at[1]] } : undefined;
}

/** Problems with a room's layout, as sentences; empty when it is sound. */
export function roomProblems(room: Room): string[] {
  const problems: string[] = [];
  const inside = ([x, z]: [number, number]) => Math.abs(x) <= room.width / 2 && Math.abs(z) <= room.depth / 2;
  for (const list of [room.props, room.spots]) {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.id)) problems.push(`"${item.id}" is used twice.`);
      seen.add(item.id);
      if (!inside(item.at)) problems.push(`"${item.id}" is outside the room.`);
    }
  }
  if (!spotById(room, room.start)) problems.push(`The starting spot "${room.start}" does not exist.`);
  for (const prop of room.props)
    if (prop.spot && !spotById(room, prop.spot)) problems.push(`"${prop.id}" leads to a spot that does not exist.`);
  for (const spot of room.spots)
    if (spot.activity === "sit" && !spot.seat) problems.push(`"${spot.id}" is for sitting but has no seat.`);
  return problems;
}

/** How the room is lit at an hour of the day: daylight through the window, the lamp after dark. */
export interface Lighting {
  /** Light from the window: its colour and strength. */
  sun: { color: number; intensity: number };
  /** Fill light from everywhere: sky and floor colours, strength. */
  sky: { color: number; ground: number; intensity: number };
  /** The floor lamp: off by day. `reach` stretches how far its light goes, beyond what the room's size gives it. */
  lamp: { on: boolean; intensity: number; reach?: number };
  /** The window glass glows with what is outside. */
  window: { color: number; glow: number };
  /**
   * Outdoors at night, the colour the town's buildings give off of their
   * own: the moonlight off everything round, which no one light gives, so a
   * roof turned from the moon reads as a roof rather than a black mass.
   */
  glow?: number;
}

/**
 * How a place is lit after dark. A home is cosy: moonlight and its own lamps.
 * The lobby, the office and the meeting rooms are public, where anyone may be
 * at any hour, so the lights overhead are on and they stay bright; only the
 * windows say it is night. The town is outdoors: the sun by day, and by night
 * the moon and the street lamps.
 */
export type Lights = "home" | "public" | "outdoor";

/** How a place is lit, by its id: the town outdoors; the lobby, the office and the meeting rooms public; the rest as homes. */
export function lightsFor(place: string | undefined): Lights {
  if (place === "town") return "outdoor";
  return place === "lobby" || place === "office" || !!place?.startsWith("office:") || !!place?.startsWith("room:")
    ? "public"
    : "home";
}

export function lightingFor(hour: number, lights: Lights = "home"): Lighting {
  if (lights === "outdoor") return outdoorLighting(hour);
  if (hour >= 7 && hour < 17) {
    return {
      sun: { color: 0xfff4e0, intensity: 2.4 },
      sky: { color: 0xe4eef8, ground: 0xb9a389, intensity: 1.1 },
      lamp: { on: false, intensity: 0 },
      window: { color: 0xbfe3ff, glow: 0.7 },
    };
  }
  const evening = hour >= 17 && hour < 20;
  // The lights overhead, warm white, from above as the sun would be, and bounced off the floor and walls.
  if (lights === "public")
    return {
      sun: { color: 0xfff1de, intensity: 1.9 },
      sky: { color: 0xfff4e6, ground: 0xa89a88, intensity: 1.15 },
      lamp: { on: true, intensity: 1.6 },
      window: evening ? { color: 0xffb88a, glow: 0.55 } : { color: 0x2b3a66, glow: 0.25 },
    };
  if (evening) {
    return {
      sun: { color: 0xffb36b, intensity: 1.3 },
      sky: { color: 0xf3d6c0, ground: 0x9c7f66, intensity: 0.75 },
      lamp: { on: true, intensity: 1.4 },
      window: { color: 0xffb88a, glow: 0.55 },
    };
  }
  // Moonlight and the sky's glow, enough to make out who is where and what they sit on across a big room; the
  // lamps, reaching further than in the evening, do the rest, and still pool warm round each one.
  return {
    sun: { color: 0x9db2ff, intensity: 0.5 },
    sky: { color: 0x7180a6, ground: 0x4a4352, intensity: 0.88 },
    lamp: { on: true, intensity: 2.4, reach: 1.35 },
    window: { color: 0x2b3a66, glow: 0.25 },
  };
}

/** The town's buildings' own glow at night (see `Lighting.glow`): a dim moonlit blue. */
export const NIGHT_GLOW = 0x283252;

/**
 * The town's light: a bright sun and a blue sky by day, low and orange in the
 * evening, and at night the moon, the sky's glow and the street lamps, enough
 * to find your way down any street.
 */
function outdoorLighting(hour: number): Lighting {
  if (hour >= 7 && hour < 17)
    return {
      sun: { color: 0xfff2dc, intensity: 2.7 },
      sky: { color: 0xd8e9f8, ground: 0x7a8a5a, intensity: 1.15 },
      lamp: { on: false, intensity: 0 },
      window: { color: 0xbfe3ff, glow: 0.4 },
    };
  if ((hour >= 17 && hour < 20) || (hour >= 5 && hour < 7))
    return {
      sun: { color: 0xffa860, intensity: 1.5 },
      sky: { color: 0xf0c8a8, ground: 0x6a5a48, intensity: 0.85 },
      lamp: { on: true, intensity: 1.8, reach: 1.6 },
      window: { color: 0xffb88a, glow: 0.55 },
    };
  // A clear night: moonlight enough to read the walls across town as blue shapes, and the street lamps' pools still
  // warm round each one. A roof turned from the moon has only the sky's glow, which leaves a dark one black: the
  // buildings' own faint glow keeps it a roof.
  return {
    sun: { color: 0xa9bcff, intensity: 1.15 },
    sky: { color: 0x8496cc, ground: 0x3c4a50, intensity: 1.9 },
    lamp: { on: true, intensity: 3, reach: 1.8 },
    window: { color: 0x2b3a66, glow: 0.25 },
    glow: NIGHT_GLOW,
  };
}

/** Where the camera starts: above and to the right, the whole room in frame. */
export const ROOM_VIEW = { azimuth: 0.42, elevation: 0.5, fov: 35 };

/**
 * The camera angles that look in through the room's open sides (radians,
 * 0 from the front). Swinging past them would put a wall between you and
 * the room.
 */
export const OPEN_SIDES: [number, number] = [-0.25, 1.25];

/** `angle` if it falls in `range`, otherwise whichever end of it is the shorter turn away. */
export function nearestWithin(angle: number, [lo, hi]: [number, number]): number {
  const a = lo + ((((angle - lo) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  if (a <= hi) return a;
  return a - hi < lo + 2 * Math.PI - a ? hi : lo;
}

/** The point the room view looks at and turns about: the middle of the floor, a little up. */
export const ROOM_TARGET: [number, number, number] = [0, 0.65, -0.15];

/** How much of the frame the room may fill, leaving a margin round it. */
const FRAME_FILL = 0.92;

/**
 * How far back the camera sits to fit the room at this aspect ratio: every
 * corner of what is drawn (the floor, and the tops of the back and left
 * walls) inside the frame, with a margin. A narrow frame (a phone) backs off
 * further than a wide one, and a big room further than a small one. `tall` is
 * the share of the stage's height that can be seen: with a phone's chat over
 * the rest, the room is fitted into what is left.
 */
export function roomDistance(room: Room, aspect: number, tall = 1): number {
  const tanV = Math.tan((ROOM_VIEW.fov * Math.PI) / 360) * FRAME_FILL * tall;
  const tanH = tanV * aspect;
  const { azimuth: a, elevation: e } = ROOM_VIEW;
  // Toward the camera from what it looks at, and the frame's right and up.
  const back = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
  const right = [Math.cos(a), 0, -Math.sin(a)];
  const up = [
    back[1] * right[2] - back[2] * right[1],
    back[2] * right[0] - back[0] * right[2],
    back[0] * right[1] - back[1] * right[0],
  ];
  const { width: w, depth: d, height: h } = room;
  const corners = [
    [-w / 2, 0, -d / 2],
    [w / 2, 0, -d / 2],
    [-w / 2, 0, d / 2],
    [w / 2, 0, d / 2],
    [-w / 2, h, -d / 2],
    [w / 2, h, -d / 2],
    [-w / 2, h, d / 2],
  ];
  const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  let distance = 0;
  for (const c of corners) {
    const p = [c[0] - ROOM_TARGET[0], c[1] - ROOM_TARGET[1], c[2] - ROOM_TARGET[2]];
    // A corner nearer the camera than the target needs more room either side of it, by how much nearer it is.
    const toward = dot(p, back);
    distance = Math.max(distance, Math.abs(dot(p, right)) / tanH + toward, Math.abs(dot(p, up)) / tanV + toward);
  }
  return distance;
}

type V3 = [number, number, number];

/** The room view's own way of looking: toward the camera from what it looks at, and the frame's right and up. */
function viewAxes(): { back: V3; right: V3; up: V3 } {
  const { azimuth: a, elevation: e } = ROOM_VIEW;
  const back: V3 = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
  const right: V3 = [Math.cos(a), 0, -Math.sin(a)];
  const up: V3 = [
    back[1] * right[2] - back[2] * right[1],
    back[2] * right[0] - back[0] * right[2],
    back[0] * right[1] - back[1] * right[0],
  ];
  return { back, right, up };
}

/**
 * Where to look, and from how far back, to have every one of `points` in the
 * frame from the room view's angle, with a margin: the middle of them as the
 * camera sees them, and far enough back that the furthest out is inside the
 * edge, a point nearer the camera needing more room by as much as it is
 * nearer. `aspect` and `tall` are the shape of what can be seen, as for
 * `roomDistance`; `foot` is the share of its height along the bottom that is
 * covered (the keys hint), which the points are kept above, and `head` the
 * share along the top (the rows of tools), which they are kept below.
 */
export function fitView(points: V3[], aspect: number, tall = 1, foot = 0, head = 0): { target: V3; distance: number } {
  // Half of what can be seen, each way, as the tangent of the angle out to its edge; up and down, what is left
  // between the head and the foot, whose middle is `lift` of the half-height above the middle of what can be seen.
  const half = Math.tan((ROOM_VIEW.fov * Math.PI) / 360) * tall;
  const tanH = half * aspect * FRAME_FILL;
  const tanV = half * Math.max(0.05, 1 - foot - head) * FRAME_FILL;
  const lift = foot - head;
  const { back, right, up } = viewAxes();
  const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  if (!points.length) return { target: [...ROOM_TARGET], distance: 0 };
  const across = points.map((p) => dot(p, right));
  const high = points.map((p) => dot(p, up));
  const mid = (xs: number[]) => (Math.min(...xs) + Math.max(...xs)) / 2;
  const deep = points.reduce((sum, p) => sum + dot(p, back), 0) / points.length;
  const [r, u] = [mid(across), mid(high)];
  const middle = [0, 1, 2].map((i) => right[i] * r + up[i] * u + back[i] * deep) as V3;
  let distance = 0;
  for (const p of points) {
    const d: V3 = [p[0] - middle[0], p[1] - middle[1], p[2] - middle[2]];
    const toward = dot(d, back);
    // Up and down it is measured from the middle of what is left between the head and the foot, where the points are
    // put (below): a point nearer the camera sits that much further from the middle of what can be seen.
    distance = Math.max(
      distance,
      Math.abs(dot(d, right)) / tanH + toward,
      Math.abs(dot(d, up) + half * lift * toward) / tanV + toward,
    );
  }
  // The middle of what is left is above the middle of what can be seen by `lift` of its half-height (below it, with
  // more covered along the top than the foot): the camera looks that much below the middle of the points, or above.
  const drop = distance * half * lift;
  return { target: [0, 1, 2].map((i) => middle[i] - up[i] * drop) as V3, distance };
}

/** Tables a room isn't gathered round: beside a chair, or under a lamp. */
const SMALL_TABLES = new Set(["side_table", "night_table", "bedside_table"]);

/**
 * What a room is gathered round, for the camera to show you on the way in:
 * its table (the one nearest the middle, as a meeting room's is), and the
 * task board on its wall. Their ids; none in a room with neither.
 */
export function centrepieces(room: Pick<Room, "props">): string[] {
  const tables = room.props
    .filter((p) => /table$/.test(p.kind) && !SMALL_TABLES.has(p.kind) && !p.on)
    .sort((a, b) => Math.hypot(...a.at) - Math.hypot(...b.at));
  const boards = room.props.filter((p) => p.kind === "board");
  return [...tables.slice(0, 1), ...boards].map((p) => p.id);
}

/** The narrowest the visible part of the stage is taken to be: a phone in portrait with a panel over it. */
export const MIN_ASPECT = 0.2;

/**
 * The camera's far plane for a room: past the furthest the room view ever
 * backs off for it, at the narrowest frame, and the room's own depth beyond
 * that, so a big room in a narrow frame is never cut off.
 */
export function farFor(room: Room): number {
  if (room.town) return OUTDOOR_FAR;
  return Math.max(60, roomDistance(room, MIN_ASPECT) + Math.hypot(room.width, room.depth, room.height));
}

/**
 * How much of the room the chat page's view takes in round the agent you
 * talk to, in metres: this much of the room's height up the frame, so the
 * agent stands about a quarter of it tall, and never less than `width`
 * across, so a phone held upright still shows what is round it.
 */
export const OWN_VIEW = { height: 4.6, width: 3.4 };
/** The nearest the wheel or a pinch brings the chat page's view, as a share of how far back it starts. */
export const OWN_NEAREST = 0.55;

/**
 * How far back the chat page's view sits to take in `OWN_VIEW` at this
 * aspect ratio, before any zoom. `tall` is the share of the stage's height
 * that can be seen, with a phone's chat over the rest: the view takes in as
 * much in what is left.
 */
export function ownDistance(aspect: number, tall = 1): number {
  const tanV = Math.tan((ROOM_VIEW.fov * Math.PI) / 360) * tall;
  return Math.max(OWN_VIEW.height / (2 * tanV), OWN_VIEW.width / (2 * tanV * aspect));
}

/**
 * A zoom for the chat page's view, kept between the nearest it comes and the
 * whole room: so zooming out past the whole room and back starts coming in at
 * once. 1 is where it starts; more is further back.
 */
export function ownZoom(zoom: number, room: Room, aspect: number, tall = 1): number {
  return Math.min(
    Math.max(zoom, OWN_NEAREST),
    Math.max(1, roomDistance(room, aspect, tall) / ownDistance(aspect, tall)),
  );
}

/**
 * Where the chat page's room view looks, and from how far: near enough that
 * the agent you talk to is comfortably big (see `OWN_VIEW`), times `zoom`,
 * centred on the agent as nearly as the room's edges allow, so the view
 * follows it round a big room and never runs off the room. A room small
 * enough to see whole from there, or zoomed out that far, is seen whole.
 */
export function roomFocus(
  room: Room,
  aspect: number,
  agent: { x: number; z: number },
  zoom = 1,
  tall = 1,
): { target: [number, number, number]; distance: number } {
  const whole = roomDistance(room, aspect, tall);
  const distance = ownDistance(aspect, tall) * Math.max(zoom, OWN_NEAREST);
  if (whole <= distance) return { target: [...ROOM_TARGET], distance: whole };
  // The share of the room out of view, which is how far off the middle the view may slide.
  const slack = 1 - distance / whole;
  const toward = (from: number, to: number, half: number) =>
    from + Math.max(-half * slack, Math.min(half * slack, to - from));
  return {
    target: [
      toward(ROOM_TARGET[0], agent.x, room.width / 2),
      ROOM_TARGET[1],
      toward(ROOM_TARGET[2], agent.z, room.depth / 2),
    ],
    distance,
  };
}

/**
 * How far back the close-up sits to fit `span` metres of the agent, from
 * its head down, into what can be seen: `tall` is the share of the stage's
 * height that can be seen, and `aspect` the shape of that part. Above a
 * phone's chat it backs off by the share the chat covers, so the head and
 * shoulders fill the strip that shows rather than the whole stage.
 */
export function closeDistance(span: number, aspect: number, tall = 1): number {
  const tanV = Math.tan((ROOM_VIEW.fov * Math.PI) / 360) * tall;
  return Math.max(span / 2 / tanV, (span * 0.9) / 2 / (tanV * aspect));
}

/** A part of the stage, in pixels from its top left. */
export interface Part {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Pixels kept between the controls over the stage and the part the agent is framed in beside or under them. */
const CONTROLS_MARGIN = 8;

/** How much of the width a row of controls along the top spans for the scene to be framed under it, not past it. */
const ACROSS = 0.6;

/**
 * The part of the stage to frame the agent in. Mostly `open`, what the page
 * leaves uncovered: the controls over the stage (`controls`) sit up in a
 * corner, over the far wall. A row of them right across the top (a phone's
 * one row of tools) is a bar, and the part starts under it. Where they reach
 * into the middle third of it, where the framed agent stands, as they do in
 * the short strip above a phone's chat, the agent is framed clear of them:
 * under them or beside them, whichever it comes out bigger in, taking in
 * `OWN_VIEW`.
 */
export function framedIn(given: Part, controls: Part[]): Part {
  const touching = (c: Part, p: Part) => c.left < p.right && p.left < c.right && c.top < p.bottom && p.top < c.bottom;
  let open = given;
  const bars = controls.filter(
    (c) =>
      touching(c, given) &&
      c.right - c.left >= (given.right - given.left) * ACROSS &&
      c.top < given.top + (given.bottom - given.top) / 4,
  );
  if (bars.length) open = { ...given, top: Math.max(given.top, ...bars.map((c) => c.bottom + CONTROLS_MARGIN)) };
  const w = open.right - open.left;
  const h = open.bottom - open.top;
  const on = controls.filter((c) => !bars.includes(c) && touching(c, open));
  const middle = {
    left: open.left + w / 3,
    right: open.right - w / 3,
    top: open.top + h / 3,
    bottom: open.bottom - h / 3,
  };
  if (!on.some((c) => c.left < middle.right && middle.left < c.right && c.top < middle.bottom && middle.top < c.bottom))
    return open;
  const centre = (open.left + open.right) / 2;
  const under = { ...open, top: Math.max(...on.map((c) => c.bottom)) + CONTROLS_MARGIN };
  const beside = { ...open };
  for (const c of on) {
    if ((c.left + c.right) / 2 < centre) beside.left = Math.max(beside.left, c.right + CONTROLS_MARGIN);
    else beside.right = Math.min(beside.right, c.left - CONTROLS_MARGIN);
  }
  /** How big the agent comes out framed in a part: what limits it, its height or its width. */
  const size = (p: Part) => Math.min((p.bottom - p.top) / OWN_VIEW.height, (p.right - p.left) / OWN_VIEW.width);
  const best = size(beside) > size(under) ? beside : under;
  return size(best) > 0 ? best : open;
}

/**
 * Which lights to keep when a room has more than the frame rate allows: fires
 * first, since they burn by day too, then each next one as far as it can be
 * from those already kept, so a big room is lit all over rather than in one
 * corner.
 */
export function spreadLights<T extends { at: { x: number; z: number }; fire: boolean }>(lights: T[], n: number): T[] {
  const kept = lights.filter((l) => l.fire).slice(0, n);
  const rest = lights.filter((l) => !l.fire);
  while (kept.length < n && rest.length) {
    let best = 0;
    let bestGap = -1;
    for (const [i, l] of rest.entries()) {
      const gap = kept.length ? Math.min(...kept.map((k) => Math.hypot(k.at.x - l.at.x, k.at.z - l.at.z))) : 0;
      if (gap > bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    kept.push(...rest.splice(best, 1));
  }
  return kept;
}
