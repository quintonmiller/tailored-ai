/**
 * The town outdoors, as the stage needs it: the plan the server lays out
 * (`places-town.ts` in core), the colours a house takes from its owner, what
 * stands by a house for the work its owner does, whether its windows are lit,
 * the sky at each hour, which street lamps light up round you, and the strips
 * the roads are drawn as. Pure, so it is tested without a GPU;
 * `townscape.ts` builds what this says.
 *
 * Units are metres, +X east and +Z south (toward the viewer), as in a room;
 * a `facing` of 0° looks south.
 */
import type { AgentActivity } from "./doing";
import { hueFor } from "./doing";

type P = [number, number];

/** What a building is, which is how it is drawn. */
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

/** A building in the town, as the server lays it out. */
export interface TownBuilding {
  /** The place its door opens on. */
  id: string;
  kind: BuildingKind;
  at: P;
  facing: number;
  /** Width along its front, depth, and its walls' height. */
  size: [number, number, number];
  label: string;
  owner?: string;
  /** What its owner does, by role id (`places-roles.ts` in core): what stands by the house says so. */
  role?: string;
  style: number;
  street: string;
}

export interface TownRoad {
  id: string;
  name?: string;
  kind: "avenue" | "street" | "lane" | "path" | "promenade";
  width: number;
  points: P[];
}

export interface TownPlot {
  id: string;
  name: string;
  at: P;
  size: P;
  gate: P;
}

/** The town as the server lays it out. */
export interface TownPlan {
  width: number;
  depth: number;
  square: { at: P; radius: number };
  shore: { sand: number; sea: number };
  stream: { points: P[]; width: number; bridges: { at: P; facing: number; length: number }[] };
  park: { at: P; size: P; pond: { at: P; size: P } };
  roads: TownRoad[];
  buildings: TownBuilding[];
  plots: TownPlot[];
  trees: [number, number, number][];
  lamps: P[];
}

/** Where a building's door is: the middle of its front, and the way out. */
export function doorOfBuilding(b: Pick<TownBuilding, "at" | "facing" | "size">): { at: P; facing: number } {
  const f = (b.facing * Math.PI) / 180;
  const half = b.size[1] / 2;
  return { at: [b.at[0] + Math.sin(f) * half, b.at[1] + Math.cos(f) * half], facing: b.facing };
}

/** Where you stand to go in: a step and a half out from a building's door. */
export function outsideDoor(b: Pick<TownBuilding, "at" | "facing" | "size">, out = 1.7): P {
  const door = doorOfBuilding(b);
  const f = (door.facing * Math.PI) / 180;
  return [door.at[0] + Math.sin(f) * out, door.at[1] + Math.cos(f) * out];
}

/** A building's footprint as a box on the floor, for walking round: the box round it, however it is turned. */
export function footprintBox(b: Pick<TownBuilding, "at" | "facing" | "size">, grow = 0) {
  const f = (b.facing * Math.PI) / 180;
  const [c, s] = [Math.abs(Math.cos(f)), Math.abs(Math.sin(f))];
  const hx = (c * b.size[0] + s * b.size[1]) / 2 + grow;
  const hz = (s * b.size[0] + c * b.size[1]) / 2 + grow;
  return { minX: b.at[0] - hx, maxX: b.at[0] + hx, minZ: b.at[1] - hz, maxZ: b.at[1] + hz };
}

// --------------------------------------------------------------------------
// What a house looks like
// --------------------------------------------------------------------------

/** HSL to a number colour. */
export function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

/** The roofs a house can have, by its style. */
export type Roof = "gable" | "front-gable" | "hip";

/**
 * A house's colours and shape, from its owner and its own style: walls a pale
 * wash of the owner's colour (the colour the map and its body show), the
 * door, shutters and trim in the colour itself, a roof from a few that suit,
 * one roof shape of three, and one storey or two.
 */
export function houseLook(owner: string | undefined, style: number) {
  // The map's swatch for an agent: hsl(145 + hue, 52%, 52%).
  const hue = (145 + (hueFor(owner ?? "") ?? 0)) % 360;
  const roofs = [0x8a4b3a, 0x5d6470, 0x7a5c48, 0x4d5a4a, 0x9a6040];
  const roof: Roof = style < 0.4 ? "gable" : style < 0.75 ? "front-gable" : "hip";
  return {
    walls: hsl(hue, 0.42, 0.84),
    trim: hsl(hue, 0.52, 0.42),
    accent: hsl(hue, 0.52, 0.52),
    roofColor: roofs[Math.floor(style * 997) % roofs.length],
    roof,
    storeys: style > 0.82 ? 2 : 1,
    chimney: Math.floor(style * 131) % 3 !== 0,
  };
}

/** Something by a house that says what its owner does. */
export type Feature =
  | "dish"
  | "mast"
  | "rack"
  | "easel"
  | "telescope"
  | "signpost"
  | "garden"
  | "woodpile"
  | "chalkboard"
  | "banner"
  | "sundial"
  | "awning"
  | "lantern"
  | "flag";

/** What stands by a house for each role: a dish on a reporter's roof, an easel by an artist's door. */
const FEATURES: Record<string, Feature[]> = {
  reporter: ["dish"],
  producer: ["mast", "lantern"],
  ops: ["rack", "dish"],
  coder: ["rack"],
  artist: ["easel", "garden"],
  researcher: ["telescope"],
  travel: ["signpost"],
  housekeeper: ["garden"],
  coach: ["garden", "flag"],
  builder: ["woodpile"],
  tutor: ["chalkboard"],
  "game-master": ["banner", "lantern"],
  player: ["banner"],
  planner: ["sundial", "garden"],
  concierge: ["awning", "lantern"],
  bookkeeper: ["awning"],
  clerk: ["awning"],
  writer: ["lantern", "garden"],
  reviewer: ["flag"],
};

/** What stands by a house whose owner has this role; a house whose owner has none, a lantern or nothing. */
export function featuresFor(role: string | undefined, style = 0): Feature[] {
  if (role && FEATURES[role]) return FEATURES[role];
  return style > 0.5 ? ["lantern"] : [];
}

// --------------------------------------------------------------------------
// Light
// --------------------------------------------------------------------------

/** How a building's windows look: the sky in them, a light on inside, or dark. */
export type WindowLook = "day" | "lit" | "dark";

/** Night, for a building's windows and the street lamps: before seven and from five. */
export const isEvening = (hour: number) => hour < 7 || hour >= 17;

/**
 * How a building's windows look at an hour, by what is going on inside. A
 * home is lit after dark while its owner is awake, and dark once it sleeps;
 * by day it shows a light only while its owner is at work, so a busy street
 * reads at a glance. The town hall, the office and the places on main street
 * are lit every evening; a meeting room's building, while anyone is talking.
 */
export function windowLook(kind: BuildingKind, hour: number, doing?: AgentActivity["doing"]): WindowLook {
  const busy = doing === "working" || doing === "thinking" || doing === "talking";
  const evening = isEvening(hour);
  if (kind === "house" || kind === "cottage") {
    if (doing === "asleep") return evening ? "dark" : "day";
    if (evening) return "lit";
    return busy ? "lit" : "day";
  }
  if (evening) return "lit";
  return busy ? "lit" : "day";
}

/** The sky at an hour: its colour overhead and at the horizon, and whether the stars are out. */
export function skyFor(hour: number): { zenith: number; horizon: number; stars: boolean } {
  if (hour >= 7 && hour < 17) return { zenith: 0x5f9fd8, horizon: 0xd4e8f4, stars: false };
  if (hour >= 17 && hour < 20) return { zenith: 0x3a4a7c, horizon: 0xf2b07a, stars: false };
  if (hour >= 5 && hour < 7) return { zenith: 0x34497a, horizon: 0xe9b8a0, stars: false };
  return { zenith: 0x0a1128, horizon: 0x26355a, stars: true };
}

/** Which way the light comes from at an hour: the sun's arc by day, the moon's by night (a unit vector, up is +Y). */
export function lightFrom(hour: number): [number, number, number] {
  const day = hour >= 6 && hour < 20;
  // The sun rises in the east (+X) and sets in the west, high in the south (+Z) at midday; the moon the same, by night.
  const t = day ? (hour - 6) / 14 : ((hour + 4) % 24) / 10;
  const a = Math.PI * Math.min(1, Math.max(0, t));
  const up = Math.max(0.25, Math.sin(a));
  const x = Math.cos(a);
  const v: [number, number, number] = [x * 0.8, up, 0.55];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** The `n` street lamps nearest a point: the ones that light up round you. */
export function nearestLamps(lamps: P[], [x, z]: P, n: number): P[] {
  return lamps
    .map((p) => ({ p, d: (p[0] - x) ** 2 + (p[1] - z) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((l) => l.p);
}

// --------------------------------------------------------------------------
// Getting about
// --------------------------------------------------------------------------

/** The camera's far plane outdoors: past the woods round the town to the horizon. */
export const OUTDOOR_FAR = 420;
/** Doors further than this from what the camera looks at aren't drawn: their buildings have one painted on. */
export const DOOR_SHOWN = 24;

/** Whether a room is the town outdoors. */
export const isOutdoors = (room: { town?: unknown }): room is { town: TownPlan } => !!room.town;

// --------------------------------------------------------------------------
// Roads as strips
// --------------------------------------------------------------------------

/**
 * A road's strip on the ground, as pairs of points either side of its centre
 * line, `width` apart: one pair per point, each square to the line there, so
 * a bend stays as wide as the straight. A line of fewer than two points has
 * no strip.
 */
export function ribbon(points: P[], width: number): [P, P][] {
  if (points.length < 2) return [];
  const half = width / 2;
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const n = Math.hypot(dx, dz) || 1;
    // To the left and right of the way the line goes.
    const lx = -dz / n;
    const lz = dx / n;
    return [
      [p[0] + lx * half, p[1] + lz * half],
      [p[0] - lx * half, p[1] - lz * half],
    ];
  });
}

// --------------------------------------------------------------------------
// Bodies going by
// --------------------------------------------------------------------------

/**
 * The door in town a place is gone into by, as a point just outside it: its
 * own building's, or the office's for a meeting room on one of its floors.
 * Undefined for a place with no door on the street.
 */
export function doorInTown(plan: TownPlan, place: string): P | undefined {
  const own = plan.buildings.find((b) => b.id === place);
  if (own) return outsideDoor(own, 1.1);
  const office = plan.buildings.find((b) => b.kind === "office");
  if (office && (place.startsWith("room:") || place === "office" || place.startsWith("office:")))
    return outsideDoor(office, 1.1);
  return undefined;
}

/** A body's walk through the town: from the door of the place it left to the door of the place it went to. */
export interface Trip {
  agent: string;
  from: P;
  to: P;
}

/**
 * Who went from one place to another between two looks at where everyone is
 * (agent → place id), as walks through the town. A body that came from, or
 * went to, a place with no door on the street makes none, and nor does one
 * that stayed inside the same building: from one room of the office to
 * another.
 */
export function tripsBetween(before: Map<string, string>, after: Map<string, string>, plan: TownPlan): Trip[] {
  const trips: Trip[] = [];
  for (const [agent, to] of after) {
    const from = before.get(agent);
    if (!from || from === to) continue;
    const a = doorInTown(plan, from);
    const b = doorInTown(plan, to);
    if (!a || !b || Math.hypot(a[0] - b[0], a[1] - b[1]) < 1) continue;
    trips.push({ agent, from: a, to: b });
  }
  return trips;
}
