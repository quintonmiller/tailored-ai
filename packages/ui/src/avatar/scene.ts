/**
 * The room the avatar stands in, as data: its size, the furniture, and the
 * named spots a figure can stand at. The stage builds it from simple shapes,
 * so it needs no model files and matches the low-poly look of most VRM
 * avatars.
 *
 * Spots are named, never just coordinates: when an agent later moves around
 * the room, it says "the couch", and the stage works out where that is.
 *
 * Units are metres. +X is to the viewer's right, +Z toward the viewer, and
 * the back and left walls close the room. A `facing` of 0° looks toward the
 * viewer, 90° toward +X.
 */

export type PropKind =
  | "rug"
  | "couch"
  | "lamp"
  | "desk"
  | "laptop"
  | "chair"
  | "bookshelf"
  | "plant"
  | "window"
  | "picture";

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
}

export interface Spot {
  id: string;
  name: string;
  at: [number, number];
  facing: number;
}

export interface Room {
  width: number;
  depth: number;
  height: number;
  props: Prop[];
  spots: Spot[];
  /** Where the avatar stands when the page opens. */
  start: string;
}

export const DEFAULT_ROOM: Room = {
  width: 4.2,
  depth: 3.6,
  height: 2.5,
  props: [
    { id: "rug", name: "the rug", kind: "rug", at: [0.1, 0.25], facing: 0 },
    { id: "couch", name: "the couch", kind: "couch", at: [-0.85, -1.38], facing: 0 },
    { id: "picture", name: "the picture", kind: "picture", at: [-0.85, -1.79], facing: 0, elevation: 1.55 },
    { id: "lamp", name: "the floor lamp", kind: "lamp", at: [0.25, -1.5], facing: 0 },
    { id: "desk", name: "the desk", kind: "desk", at: [1.35, -1.47], facing: 0 },
    { id: "laptop", name: "the laptop", kind: "laptop", at: [1.35, -1.5], facing: 0, elevation: 0.76 },
    { id: "chair", name: "the desk chair", kind: "chair", at: [1.35, -0.95], facing: 160 },
    { id: "window", name: "the window", kind: "window", at: [-2.09, -0.45], facing: 90, elevation: 1.0 },
    { id: "bookshelf", name: "the bookshelf", kind: "bookshelf", at: [-1.9, 0.95], facing: 90 },
    { id: "plant", name: "the plant", kind: "plant", at: [-1.78, -1.48], facing: 0 },
  ],
  spots: [
    { id: "middle", name: "the middle of the room", at: [0.15, 0.35], facing: 20 },
    { id: "couch", name: "by the couch", at: [-0.85, -0.75], facing: 10 },
    { id: "desk", name: "at the desk", at: [0.7, -1.0], facing: 150 },
    { id: "window", name: "at the window", at: [-1.5, -0.45], facing: -90 },
    { id: "bookshelf", name: "by the bookshelf", at: [-1.35, 0.95], facing: -90 },
  ],
  start: "middle",
};

export function spotById(room: Room, id: string): Spot | undefined {
  return room.spots.find((s) => s.id === id);
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
  return {
    sun: { color: 0x8fa8ff, intensity: 0.35 },
    sky: { color: 0x5a6a8c, ground: 0x3a3340, intensity: 0.45 },
    lamp: { on: true, intensity: 2.2 },
    window: { color: 0x2b3a66, glow: 0.25 },
  };
}

/** Where the camera starts: above and to the right, the whole room in frame. */
export const ROOM_VIEW = { azimuth: 0.42, elevation: 0.5, fov: 35 };

/**
 * How far back the camera sits to fit the room at this aspect ratio: a narrow
 * frame (a phone) has to back off further than a wide one.
 */
export function roomDistance(room: Room, aspect: number): number {
  const vfov = (ROOM_VIEW.fov * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  // The room seen from the corner is about as wide as its diagonal.
  const span = Math.hypot(room.width, room.depth) * 1.02;
  const fitWidth = span / 2 / Math.tan(hfov / 2);
  const fitHeight = (room.height * 1.7) / 2 / Math.tan(vfov / 2);
  return Math.max(fitWidth, fitHeight);
}
