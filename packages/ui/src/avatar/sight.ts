/**
 * Seeing past the furniture: which tall things stand between the camera and
 * a body, so they can fade while they are in the way, and which walls the
 * camera has gone round behind. A palm at the front of a meeting room, a
 * bookshelf you walked behind, the back wall once you turn the view right
 * round: each fades to a ghost of itself until the view is clear again. Pure,
 * so it is tested without a GPU; the stage fades what this names.
 */

export type Vec3 = [number, number, number];

/**
 * Something solid in the room, by the corners of the box round it; and, for
 * something with open space in its box (a cart under its awning, a lamp on
 * its post), the boxes round each of its parts, which are what can hide a body.
 */
export interface Solid {
  min: Vec3;
  max: Vec3;
  parts?: Solid[];
}

/** How tall something has to be to hide a body, in metres: a plant, a lamp, a shelf. A table or a couch never fades. */
export const TALL = 1.1;
/** How much of something in the way still shows while it is faded: enough to see it is there. */
export const FADED = 0.22;
/** The same for a wall the camera has gone round behind: less, since the room is what you came to see. */
export const FADED_WALL = 0.08;

const inside = (p: Vec3, s: Solid) =>
  p[0] > s.min[0] && p[0] < s.max[0] && p[1] > s.min[1] && p[1] < s.max[1] && p[2] > s.min[2] && p[2] < s.max[2];

/**
 * Whether the straight line from `eye` to `to` passes through `solid` on its
 * way: through one of its parts, when it has them, not just the space between
 * them. Something `to` is inside, like the umbrella over a body, never hides it.
 */
export function blocks(solid: Solid, eye: Vec3, to: Vec3): boolean {
  if (inside(to, solid)) return false;
  if (!crosses(solid, eye, to)) return false;
  return !solid.parts?.length || solid.parts.some((p) => crosses(p, eye, to));
}

/** Whether the straight line from `eye` to `to` passes through a box. */
function crosses(solid: Solid, eye: Vec3, to: Vec3): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = to[i] - eye[i];
    if (Math.abs(d) < 1e-9) {
      if (eye[i] <= solid.min[i] || eye[i] >= solid.max[i]) return false;
      continue;
    }
    let a = (solid.min[i] - eye[i]) / d;
    let b = (solid.max[i] - eye[i]) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 >= t1) return false;
  }
  return true;
}

/** Which of `solids` stand between the eye and any of `targets` (a head, a chest), by their place in the list. */
export function blockers(solids: Solid[], eye: Vec3, targets: Vec3[]): Set<number> {
  const out = new Set<number>();
  for (const [i, s] of solids.entries()) if (targets.some((t) => blocks(s, eye, t))) out.add(i);
  return out;
}

/** The two walls that close a room, at its back and its left; the front and the right are open. */
export type Wall = "back" | "left";

/** The walls the camera has gone round behind, so they stand between it and the room. */
export function wallsBehind(room: { width: number; depth: number }, eye: Vec3): Set<Wall> {
  const out = new Set<Wall>();
  if (eye[2] < -room.depth / 2) out.add("back");
  if (eye[0] < -room.width / 2) out.add("left");
  return out;
}

/** The wall something hanging at `at` is on, by how near it is to each; none for something away from both. */
export function wallOf(room: { width: number; depth: number }, [x, z]: [number, number], near = 0.4): Wall | undefined {
  const back = z + room.depth / 2;
  const left = x + room.width / 2;
  if (back > near && left > near) return undefined;
  return back <= left ? "back" : "left";
}
