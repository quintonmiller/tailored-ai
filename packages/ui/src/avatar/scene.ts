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
  | "sign";

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
  /** What clicking it does on the page: make an agent, a task or a room, or see the tasks. */
  action?: string;
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
  /** What agents did to it lately with their place tool, newest first. */
  changes?: RoomChange[];
}

/** One change to a room: "planner added the bookshelf", and when. */
export interface RoomChange {
  who: string;
  /** A few words that follow the agent's name. */
  what: string;
  at: string;
}

/**
 * What a change to a room did to its things, so the stage can show it
 * happening: what is new or made over (another colour, size or label) grows
 * in, and what only moved or turned glides there from where it stood.
 */
export function roomChanges(before: Room, after: Room): { fresh: Set<string>; moved: Map<string, Prop> } {
  const was = new Map(before.props.map((p) => [p.id, p]));
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
      String(old.size) !== String(prop.size)
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
 * A door in a room: which side it is on and where along it (x on the back and
 * front, z on the left and right), the place it opens on, and what its name
 * plate says. The back and left are walls; a door on the open front or right
 * stands on its own at the floor's edge.
 */
export interface RoomDoor {
  wall: "back" | "left" | "front" | "right";
  along: number;
  /** The place it opens on, by id. */
  to: string;
  label: string;
  kind: "lobby" | "hall" | "home" | "shared" | "room";
  /** The agent whose home it opens on: its light says what that agent is doing. */
  occupant?: string;
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

/** The gestures the avatar can make, and so the ones the agent is offered. */
export const GESTURES = ["wave", "nod", "shake", "shrug", "think", "bow"] as const;

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
  /** The floor lamp: off by day. */
  lamp: { on: boolean; intensity: number };
  /** The window glass glows with what is outside. */
  window: { color: number; glow: number };
}

export function lightingFor(hour: number): Lighting {
  if (hour >= 7 && hour < 17) {
    return {
      sun: { color: 0xfff4e0, intensity: 2.4 },
      sky: { color: 0xe4eef8, ground: 0xb9a389, intensity: 1.1 },
      lamp: { on: false, intensity: 0 },
      window: { color: 0xbfe3ff, glow: 0.7 },
    };
  }
  if (hour >= 17 && hour < 20) {
    return {
      sun: { color: 0xffb36b, intensity: 1.3 },
      sky: { color: 0xf3d6c0, ground: 0x9c7f66, intensity: 0.75 },
      lamp: { on: true, intensity: 1.4 },
      window: { color: 0xffb88a, glow: 0.55 },
    };
  }
  // Moonlight and the sky's glow, enough to make out a big room's far side; the lamps do the rest.
  return {
    sun: { color: 0x8fa8ff, intensity: 0.4 },
    sky: { color: 0x5a6a8c, ground: 0x3a3340, intensity: 0.62 },
    lamp: { on: true, intensity: 2.2 },
    window: { color: 0x2b3a66, glow: 0.25 },
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
 * further than a wide one, and a big room further than a small one.
 */
export function roomDistance(room: Room, aspect: number): number {
  const tanV = Math.tan((ROOM_VIEW.fov * Math.PI) / 360) * FRAME_FILL;
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

/** The narrowest the visible part of the stage is taken to be: a phone in portrait with a panel over it. */
export const MIN_ASPECT = 0.2;

/**
 * The camera's far plane for a room: past the furthest the room view ever
 * backs off for it, at the narrowest frame, and the room's own depth beyond
 * that, so a big room in a narrow frame is never cut off.
 */
export function farFor(room: Room): number {
  return Math.max(60, roomDistance(room, MIN_ASPECT) + Math.hypot(room.width, room.depth, room.height));
}

/** How far back the chat page's room view sits at most, however big the room: near enough to make out the agent. */
export const ROOM_REACH = 12;

/**
 * Where the chat page's room view looks, and from how far. A room that fits
 * within `ROOM_REACH` is seen whole, as before. A bigger one is seen from
 * `ROOM_REACH`, as much of it as fits, centred on the agent as nearly as the
 * room's edges allow, so the agent stays a readable size and the view never
 * runs off the room. Dragging and the Map show the rest.
 */
export function roomFocus(
  room: Room,
  aspect: number,
  agent: { x: number; z: number },
): { target: [number, number, number]; distance: number } {
  const whole = roomDistance(room, aspect);
  if (whole <= ROOM_REACH) return { target: [...ROOM_TARGET], distance: whole };
  // The share of the room out of view, which is how far off the middle the view may slide.
  const slack = 1 - ROOM_REACH / whole;
  const toward = (from: number, to: number, half: number) =>
    from + Math.max(-half * slack, Math.min(half * slack, to - from));
  return {
    target: [
      toward(ROOM_TARGET[0], agent.x, room.width / 2),
      ROOM_TARGET[1],
      toward(ROOM_TARGET[2], agent.z, room.depth / 2),
    ],
    distance: ROOM_REACH,
  };
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
