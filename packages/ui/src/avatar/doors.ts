/**
 * Doors between places, as the stage needs them: where a door stands and which
 * way it faces, where you come in through one, when walking takes you through
 * it, and what its light says about whoever lives behind it. Pure, so it is
 * tested without a GPU; the stage draws and walks by what this says.
 *
 * A door faces into its room. On the back wall it looks toward +Z, on the left
 * toward +X, and on the open front and right sides back into the room.
 */
import type { AgentActivity } from "./doing";
import type { Room, RoomDoor } from "./scene";

/** How far inside a door you are put when you come through it: clear of its doorway, so you don't go straight back. */
export const ARRIVE_IN = 1.1;
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

/** Where you stand having just come through a door, and the way you face: into the room, radians as the walker keeps them. */
export function arrivalAt(
  room: Pick<Room, "width" | "depth">,
  door: Pick<RoomDoor, "wall" | "along">,
): { at: [number, number]; facing: number } {
  const { at, facing } = doorFrame(room, door);
  const [ix, iz] = inward(facing);
  return { at: [at[0] + ix * ARRIVE_IN, at[1] + iz * ARRIVE_IN], facing: (facing * Math.PI) / 180 };
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
 */
export function doorReached(
  room: Pick<Room, "width" | "depth" | "doors">,
  at: [number, number],
  step: [number, number],
): RoomDoor | undefined {
  const length = Math.hypot(step[0], step[1]);
  if (length < 1e-4) return undefined;
  for (const door of room.doors ?? []) {
    const p = fromDoor(room, door, at);
    if (Math.abs(p.across) > DOOR_HALF || p.in > DOOR_REACH || p.in < -0.3) continue;
    const [ix, iz] = inward(doorFrame(room, door).facing);
    // Mostly toward it: walking along the wall past a door isn't going through it.
    if (-(step[0] * ix + step[1] * iz) / length > 0.5) return door;
  }
  return undefined;
}

/** Whether a point is in a door's opening at all: someone just come through it hasn't left it yet. */
export function inDoorway(room: Pick<Room, "width" | "depth">, door: RoomDoor, at: [number, number]): boolean {
  const p = fromDoor(room, door, at);
  return Math.abs(p.across) <= DOOR_HALF && p.in <= DOOR_REACH;
}

/** The colour of the light by a home's door, by what its agent is doing, and how bright: dim when it is idle or asleep. */
export function doorLight(doing: AgentActivity["doing"] | undefined): { color: number; glow: number } {
  switch (doing) {
    case "working":
      return { color: 0x4cd07d, glow: 1.6 };
    case "thinking":
    case "talking":
      return { color: 0x6aa8ff, glow: 1.6 };
    case "waiting":
      return { color: 0xffb020, glow: 2 };
    case "stuck":
      return { color: 0xff5a5a, glow: 2 };
    case "asleep":
      return { color: 0x7a6fd0, glow: 0.35 };
    default:
      return { color: 0xd8dde6, glow: 0.5 };
  }
}
