/**
 * Standing in front of someone: where your body goes when you go straight to
 * an agent from a list, face to face with it, clear of the furniture. Pure,
 * so it is tested without a GPU; the stage puts you where this says.
 */
import { standsClear } from "./doors";
import type { Obstacle } from "./locomotion";
import type { Room } from "./scene";

/** Metres between you and the agent: near enough that it notices you (the stage's 1.5), not in its face. */
export const GREET_GAP = 1.3;

/**
 * Which side of an agent to stand on, as a way from it (radians): toward the
 * camera, which looks in through the room's `open` sides, so you see its
 * face; at whichever edge of those is the nearer turn from the way it faces,
 * so you stand off to one side of the camera's line and neither of you hides
 * the other.
 */
export function sideFor(facing: number, [lo, hi]: [number, number]): number {
  const turn = (to: number) => Math.abs(Math.atan2(Math.sin(to - facing), Math.cos(to - facing)));
  return turn(lo) <= turn(hi) ? lo : hi;
}

/**
 * Where to stand to face an agent standing at `at`, and the way to face: on
 * its `side` (radians, the way from it, 0 toward +Z: see `sideFor`), when
 * the floor there is clear; otherwise the nearest clear point
 * round it, a twelfth of a turn at a time either way; then a little nearer,
 * then a little further. Nowhere clear at all, on that side anyway.
 */
export function faceToFace(
  room: Pick<Room, "width" | "depth">,
  obstacles: Obstacle[],
  at: [number, number],
  side: number,
  gap = GREET_GAP,
): { at: [number, number]; facing: number } {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const point = (turn: number, d: number): [number, number] => {
    const a = side + turn;
    return [round(at[0] + Math.sin(a) * d), round(at[1] + Math.cos(a) * d)];
  };
  const toward = (p: [number, number]) => Math.atan2(at[0] - p[0], at[1] - p[1]);
  const turns = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6].map((k) => (k * Math.PI) / 6);
  for (const d of [gap, gap * 0.8, gap * 1.35])
    for (const turn of turns) {
      const p = point(turn, d);
      if (standsClear(room, obstacles, p)) return { at: p, facing: toward(p) };
    }
  const p = point(0, gap * 0.8);
  return { at: p, facing: toward(p) };
}
