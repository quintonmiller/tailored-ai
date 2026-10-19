/**
 * Doors between places, as the stage needs them: where a door stands and which
 * way it faces, where you come in through one, when walking takes you through
 * it, and what its light says about whoever lives behind it. Pure, so it is
 * tested without a GPU; the stage draws and walks by what this says.
 *
 * A door faces into its room. On the back wall it looks toward +Z, on the left
 * toward +X, and on the open front and right sides back into the room.
 */
import { type AgentActivity, DOING_COLORS } from "./doing";
import type { Obstacle } from "./locomotion";
import type { Room, RoomDoor } from "./scene";

/**
 * How far inside a door you are put when you come through it: clear of its
 * doorway, so you don't go straight back. Further through a gate at the open
 * front or right, which stands between you and the camera: any nearer and its
 * name plate hides you. The `place` tool keeps the floor this far in clear of
 * anything new (`DOOR_APPROACH` in core's `places-layout.ts`).
 */
export const ARRIVE_IN = { wall: 1.1, open: 1.7 };
/** The widest a body is from its middle: where you come in has this much room all round. */
const BODY = 0.3;
/** Walking within this far of a door's opening, toward it, takes you through. */
export const DOOR_REACH = 0.55;
/** Half the width you have to be within, across the door, to go through it. */
export const DOOR_HALF = 0.6;

/** Where a door stands on the floor plan, and which way it faces, in degrees (0 faces +Z). */
export function doorFrame(room: Pick<Room, "width" | "depth">, door: Pick<RoomDoor, "wall" | "along">) {
  switch (door.wall) {
    case "back":
      return { at: [door.along, -room.depth / 2] as [number, number], facing: 0 };
    case "left":
      return { at: [-room.width / 2, door.along] as [number, number], facing: 90 };
    case "front":
      return { at: [door.along, room.depth / 2] as [number, number], facing: 180 };
    case "right":
      return { at: [room.width / 2, door.along] as [number, number], facing: -90 };
  }
}

/** The way into the room from a door, as a unit vector on the floor. */
function inward(facing: number): [number, number] {
  const f = (facing * Math.PI) / 180;
  return [Math.round(Math.sin(f) * 1e6) / 1e6, Math.round(Math.cos(f) * 1e6) / 1e6];
}

/** Whether a body stands clear of everything on the floor, and inside the room. */
export function standsClear(room: Pick<Room, "width" | "depth">, obstacles: Obstacle[], [x, z]: [number, number]) {
  if (Math.abs(x) > room.width / 2 - BODY || Math.abs(z) > room.depth / 2 - BODY) return false;
  return !obstacles.some((o) => x > o.minX - BODY && x < o.maxX + BODY && z > o.minZ - BODY && z < o.maxZ + BODY);
}

/**
 * Where you stand having just come through a door, and the way you face: into
 * the room, radians as the walker keeps them. Straight in from the door, as
 * far as `ARRIVE_IN`, or the nearest point on that line clear of what stands
 * on the floor (`obstacles`): a room furnished before doors came may have
 * something just inside one.
 */
export function arrivalAt(
  room: Pick<Room, "width" | "depth">,
  door: Pick<RoomDoor, "wall" | "along">,
  obstacles: Obstacle[] = [],
): { at: [number, number]; facing: number } {
  const { at, facing } = doorFrame(room, door);
  const [ix, iz] = inward(facing);
  const point = (d: number): [number, number] => [at[0] + ix * d, at[1] + iz * d];
  const want = door.wall === "front" || door.wall === "right" ? ARRIVE_IN.open : ARRIVE_IN.wall;
  const across = door.wall === "back" || door.wall === "front" ? room.depth : room.width;
  // Further in first, then back toward the door, but never so near that you stand in its doorway.
  const step = (k: number) => Math.round((want + k / 10) * 100) / 100;
  const tries: number[] = [];
  for (let k = 0; step(k) <= across - BODY; k++) tries.push(step(k));
  for (let k = -1; step(k) >= DOOR_REACH + BODY; k--) tries.push(step(k));
  const found = tries.find((d) => standsClear(room, obstacles, point(d)));
  return { at: point(found ?? want), facing: (facing * Math.PI) / 180 };
}

/** How far inside a door's opening a body stands on its threshold, coming in or about to go out. */
export const THRESHOLD = 0.35;

/**
 * The point just inside a door, and the way into the room from it (radians):
 * where an agent's body comes in, and the last place it walks to on its way
 * out.
 */
export function threshold(
  room: Pick<Room, "width" | "depth">,
  door: Pick<RoomDoor, "wall" | "along">,
): { at: [number, number]; facing: number } {
  const { at, facing } = doorFrame(room, door);
  const [ix, iz] = inward(facing);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { at: [round(at[0] + ix * THRESHOLD), round(at[1] + iz * THRESHOLD)], facing: (facing * Math.PI) / 180 };
}

/** The door back to where you came from, if this room has one. */
export function doorTo(room: Pick<Room, "doors">, from: string | undefined): RoomDoor | undefined {
  return from ? room.doors?.find((d) => d.to === from) : undefined;
}

/** Where a point is from a door: `across` it (0 in the middle) and how far `in` from its opening. */
function fromDoor(room: Pick<Room, "width" | "depth">, door: RoomDoor, [x, z]: [number, number]) {
  const { at, facing } = doorFrame(room, door);
  const [ix, iz] = inward(facing);
  const dx = x - at[0];
  const dz = z - at[1];
  return { across: dx * iz - dz * ix, in: dx * ix + dz * iz };
}

/**
 * The door a step takes you through: you are at its opening, within reach and
 * square on to it, and the step was toward it, not along the wall past it.
 * `push` is the way you are trying to go, when you are pressing a key: up
 * against the wall in front of a door the wall stops the step, but pressing
 * toward the door still takes you through.
 */
export function doorReached(
  room: Pick<Room, "width" | "depth" | "doors">,
  at: [number, number],
  step: [number, number],
  push?: [number, number],
): RoomDoor | undefined {
  const way = push && Math.hypot(push[0], push[1]) > 1e-6 ? push : step;
  const length = Math.hypot(way[0], way[1]);
  // A step too small to have a way is standing still; a push always has one.
  if (way === step && length < 1e-4) return undefined;
  for (const door of room.doors ?? []) {
    const p = fromDoor(room, door, at);
    if (Math.abs(p.across) > DOOR_HALF || p.in > DOOR_REACH || p.in < -0.3) continue;
    const [ix, iz] = inward(doorFrame(room, door).facing);
    // Mostly toward it: walking along the wall past a door isn't going through it.
    if (-(way[0] * ix + way[1] * iz) / length > 0.5) return door;
  }
  return undefined;
}

/** Whether a point is in a door's opening at all: someone just come through it hasn't left it yet. */
export function inDoorway(room: Pick<Room, "width" | "depth">, door: RoomDoor, at: [number, number]): boolean {
  const p = fromDoor(room, door, at);
  return Math.abs(p.across) <= DOOR_HALF && p.in <= DOOR_REACH;
}

/**
 * The colour of the light by a home's door, by what its agent is doing (the
 * colours every view of a doing uses), and how bright it is (0–1): full when
 * it needs you, dim asleep, a plain grey idle. Drawn as they are, so each
 * reads at a glance against the plate beside it.
 */
export function doorLight(doing: AgentActivity["doing"] | undefined): { color: number; glow: number } {
  const d = doing ?? "idle";
  const glow = d === "waiting" || d === "stuck" ? 1 : d === "asleep" ? 0.4 : 0.9;
  return { color: DOING_COLORS[d], glow };
}

/** Where a door goes, in words for a pointer over it: "to Residences E–N", "to analyst's home", "to #budget". */
export function doorWords(door: Pick<RoomDoor, "kind" | "label" | "occupant">): string {
  if (door.kind === "lobby") return "to the lobby";
  if (door.kind === "home") {
    const who = door.occupant ?? door.label;
    return `to ${who === "default" ? "the default agent" : who}'s home`;
  }
  return `to ${door.label}`;
}

/** How large words on a plate may be, as a share of its height: one line, two lines, and the least either may be. */
const PLATE = { one: 0.58, two: 0.4, least: 0.22 };
/** How much of a plate's width words may take: a margin either side. */
const PLATE_WIDTH = 0.9;
/** A name on one line smaller than this share of the plate's height reads better on two. */
const ONE_LINE_AT_LEAST = 0.42;

/**
 * Where a name breaks across two lines: after a hyphen, an underscore, a dot
 * or a space, or between a word and a capital, wherever leaves the two lines
 * most even. In a name with none of those, in the middle, with a hyphen.
 */
export function plateBreak(label: string): [string, string] {
  const at: number[] = [];
  for (let i = 1; i < label.length; i++) {
    const before = label[i - 1];
    const here = label[i];
    if (
      "-_.".includes(before) ||
      (here === " " && i < label.length - 1) ||
      (/[a-z]/.test(before) && /[A-Z]/.test(here))
    )
      at.push(i);
  }
  if (!at.length) {
    const mid = Math.ceil(label.length / 2);
    return [`${label.slice(0, mid)}-`, label.slice(mid)];
  }
  // The break whose longer line is shortest; between two as good, the later, so the top line is the fuller.
  const longer = (i: number) => Math.max(i, label.length - i);
  const best = at.reduce((a, b) => (longer(b) <= longer(a) ? b : a));
  return [label.slice(0, best).trimEnd(), label.slice(best).trimStart()];
}

/**
 * How a name goes on a plate `width` by `height` pixels: on one line as large
 * as fits; a name too long for that at a size worth reading goes on two lines,
 * broken where it breaks best (`plateBreak`), when they can be larger; and the
 * words are never smaller than a floor, past which they are squeezed rather
 * than cut off. `measure` says how wide some words are at a size of 1.
 */
export function fitPlate(
  label: string,
  measure: (text: string) => number,
  width: number,
  height: number,
): { lines: string[]; size: number } {
  const room = width * PLATE_WIDTH;
  const largest = (text: string, most: number) => Math.min(height * most, room / Math.max(1e-6, measure(text)));
  const one = largest(label, PLATE.one);
  if (one >= height * ONE_LINE_AT_LEAST || label.length < 4)
    return { lines: [label], size: Math.max(one, height * PLATE.least) };
  const lines = plateBreak(label);
  const two = Math.min(...lines.map((l) => largest(l, PLATE.two)));
  return two > one
    ? { lines, size: Math.max(two, height * PLATE.least) }
    : { lines: [label], size: Math.max(one, height * PLATE.least) };
}
