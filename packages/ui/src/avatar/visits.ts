/**
 * Agents who came to see someone: where each stands, round the one it came
 * to see, and who keeps whom company. An agent that messages another
 * directly goes to see it (the places plugin's `visit` record names who it
 * is `with`); the stage walks it to the spot this finds, keeps the two from
 * wandering off, and turns them to face each other. Pure, so it is tested
 * without a GPU.
 */
import { standsClear } from "./doors";
import type { Obstacle } from "./locomotion";
import type { Room } from "./scene";

/** How far from the one it came to see a visitor stands: near enough to talk, out of the way of its arms. */
export const STAND_OFF = 0.95;
/** How far apart two bodies standing round the same agent keep. */
export const SPACING = 0.8;
/** Further than this from the one it came to see, a visitor walks over to it again. */
export const FOLLOW_AT = 1.8;
/** Directions round the agent tried, evenly spaced. */
const ROUND = 16;
/** A body's half-width: how far inside the walls a spot has to be. */
const BODY = 0.3;

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Where a visitor stands to talk to someone at `target`, and the way it faces
 * (radians, as the walker keeps them): on the side it comes from (`from`; the
 * middle of the room when not given), or failing that the nearest way round
 * that is clear of the furniture, the walls and everyone in `others`, a step
 * further out once the near ring is full. So several visitors to one agent
 * stand round it rather than on top of each other. Somewhere is always found:
 * when no spot is clear of the others, the nearest one clear of the
 * furniture, and when even that fails, the one on the side it comes from.
 */
export function standBy(
  room: Pick<Room, "width" | "depth">,
  obstacles: Obstacle[],
  target: [number, number],
  opts: { from?: [number, number]; others?: [number, number][] } = {},
): { at: [number, number]; facing: number } {
  const [tx, tz] = target;
  const [fx, fz] = opts.from ?? [0, 0];
  // Standing on the middle of the room, there is no side to come from: beside it, then.
  const toward = Math.hypot(fx - tx, fz - tz) > 0.05 ? Math.atan2(fx - tx, fz - tz) : Math.PI / 2;
  const step = (2 * Math.PI) / ROUND;
  // The way it comes first, then either side of that, further and further round.
  const turns = [0, ...Array.from({ length: ROUND / 2 }, (_, i) => [i + 1, -(i + 1)]).flat()].slice(0, ROUND);
  const ring = (r: number) =>
    turns.map((k): [number, number] => {
      const a = toward + k * step;
      return [round(tx + Math.sin(a) * r), round(tz + Math.cos(a) * r)];
    });
  const clear = [...ring(STAND_OFF), ...ring(STAND_OFF + 0.45)].filter((p) => standsClear(room, obstacles, p));
  const others = opts.others ?? [];
  const spaced = clear.find((p) => others.every((o) => Math.hypot(o[0] - p[0], o[1] - p[1]) >= SPACING));
  const [x, z] = spaced ?? clear[0] ?? ring(STAND_OFF)[0];
  const at: [number, number] = [
    Math.max(-room.width / 2 + BODY, Math.min(room.width / 2 - BODY, x)),
    Math.max(-room.depth / 2 + BODY, Math.min(room.depth / 2 - BODY, z)),
  ];
  return { at, facing: Math.atan2(tx - at[0], tz - at[1]) };
}

/**
 * Who each body keeps company with, of those here: a visitor the one it came
 * to see, and the one it came to see its visitor, the latest to come when
 * several came. `visitors` are the bodies here, in the order they came, each
 * with who it came to see; `here` is everyone with a body here. A body that
 * came to see someone keeps to that one, whoever comes to see it meanwhile.
 */
export function keeping(visitors: [string, string | undefined][], here: ReadonlySet<string>): Map<string, string> {
  const came = new Map<string, string>();
  for (const [agent, partner] of visitors)
    if (partner && partner !== agent && here.has(partner)) came.set(agent, partner);
  const kept = new Map(came);
  // In the order they came, so the latest to come is the one faced.
  for (const [agent, partner] of came) if (!came.has(partner)) kept.set(partner, agent);
  return kept;
}
