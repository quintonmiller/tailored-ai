/**
 * Getting round a place in your own body: how fast you walk, run and fly,
 * which walk the body plays at a pace and how fast it plays it, and how the
 * camera keeps up and how much it takes in. Every speed a visitor moves at is
 * here, by name. Pure, so it is tested without a GPU; the stage moves you by
 * what this says.
 */

/** How a visitor gets around: walking their body, or flying the camera free. */
export type Travel = "walk" | "fly";

/** Metres a second you walk: brisk, so a room is crossed in a couple of seconds. Clicking the floor walks at it too. */
export const WALK_SPEED = 2.75;
/** Holding Shift goes this many times as fast, walking or flying. */
export const RUN_FACTOR = 2;
/** Metres a second the camera flies: faster again, for getting the measure of a place. */
export const FLY_SPEED = 6;
/** Radians a second your body turns toward where it is going: quick, so it never walks backwards for long. */
export const VISITOR_TURN = 10;
/** Seconds the camera takes to close a gap between it and you that walking didn't make, like the first framing. */
export const FOLLOW_SECONDS = 0.25;

/** Keys a visitor moves by: [right, forward, up]. */
export const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 1, 0],
  ArrowUp: [0, 1, 0],
  KeyS: [0, -1, 0],
  ArrowDown: [0, -1, 0],
  KeyA: [-1, 0, 0],
  ArrowLeft: [-1, 0, 0],
  KeyD: [1, 0, 0],
  ArrowRight: [1, 0, 0],
  KeyE: [0, 0, 1],
  KeyQ: [0, 0, -1],
};

/** Keys that make you run while held. */
export const RUN_KEYS: ReadonlySet<string> = new Set(["ShiftLeft", "ShiftRight"]);

/** What the held keys add up to: which way, and whether to run. Opposite keys cancel; unknown keys count for nothing. */
export function heldMove(held: Iterable<string>): { right: number; forward: number; up: number; running: boolean } {
  let [right, forward, up] = [0, 0, 0];
  let running = false;
  for (const key of held) {
    if (RUN_KEYS.has(key)) running = true;
    const m = MOVE_KEYS[key];
    if (!m) continue;
    right += m[0];
    forward += m[1];
    up += m[2];
  }
  return { right, forward, up, running };
}

/** How fast you go, in metres a second, walking or flying, with Shift held or not. */
export function travelSpeed(travel: Travel, running: boolean): number {
  return (travel === "fly" ? FLY_SPEED : WALK_SPEED) * (running ? RUN_FACTOR : 1);
}

/** A pace this many times a body's own walking speed is a run. Halfway between a walk and a Shift run. */
const RUN_ABOVE = (1 + RUN_FACTOR) / 2;
/** The walk cycle plays no slower or faster than this, so a stumble or a sprint never smears it. */
const RATE: [number, number] = [0.25, 4];

/**
 * Which walk the body plays at a pace, and how fast it plays it. `walking` is
 * the body's own walking speed; a pace well past it is a run, when there is a
 * run clip to play (`runs`). `made` is the pace each clip was made for: the
 * clip plays that much faster or slower, so the feet keep up with the ground
 * instead of skating. A clip whose pace isn't known plays as made.
 */
export function gait(
  pace: number,
  walking: number,
  made: { walk?: number; run?: number },
  runs = made.run !== undefined,
): { role: "walk" | "run"; rate: number } {
  const role = runs && pace > walking * RUN_ABOVE ? "run" : "walk";
  const madeFor = made[role];
  if (!madeFor || pace <= 0) return { role, rate: 1 };
  return { role, rate: Math.min(RATE[1], Math.max(RATE[0], pace / madeFor)) };
}

/**
 * How much of a place the camera following you takes in, walking: the metres
 * it sees either side of you, across the narrower way of the part of the stage
 * nothing covers. Close behind you, a good part of the room to start, and a
 * whole hall or the lobby at the widest. The wheel, or a pinch, moves between
 * them.
 */
export const REACH = { near: 1.4, start: 4.5, far: 12 };
/** Each notch of the wheel (100 pixels of scroll) takes in this many times as much, or as little. */
export const REACH_PER_NOTCH = 1.2;
/** Seconds the camera takes to settle at a new reach, or a new shape of stage: quick, and never a jump. */
export const ZOOM_SECONDS = 0.18;

/** The widest worth seeing round you in a room: the whole of it from its middle, with a little floor beyond. */
export function widestReach(room: { width: number; depth: number }): number {
  return Math.min(REACH.far, Math.max(REACH.start, Math.max(room.width, room.depth) / 2 + 1));
}

/** A reach kept between close behind you and the widest worth seeing. */
export function clampReach(reach: number, widest: number): number {
  return Math.min(Math.max(reach, REACH.near), Math.max(REACH.near, widest));
}

/** Pixels a wheel turned, whatever it counts in: some browsers count lines or pages. */
export function wheelPixels(e: { deltaY: number; deltaMode: number }): number {
  return e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
}

/** The reach after the wheel turns `pixels`: toward you (positive) takes in more, away takes in less. */
export function wheelReach(reach: number, pixels: number, widest: number): number {
  return clampReach(reach * REACH_PER_NOTCH ** (pixels / 100), widest);
}

/** The reach after a pinch: fingers spread from `before` apart to `after` come closer in, by as much. */
export function pinchReach(reach: number, before: number, after: number, widest: number): number {
  if (before <= 0 || after <= 0) return clampReach(reach, widest);
  return clampReach((reach * before) / after, widest);
}

/**
 * How far back the camera sits for a reach: `reach` metres either side of you
 * across the narrower way of what can be seen, `aspect` its width over its
 * height and `fov` the camera's vertical field of view in degrees. A strip
 * beside the chat backs off further than the whole stage would, so you see as
 * much round you either way.
 */
export function followDistance(reach: number, aspect: number, fov: number): number {
  const tanV = Math.tan((fov * Math.PI) / 360);
  return reach / Math.min(tanV, tanV * aspect);
}

/** `from` moved toward `to` for a frame `dt` seconds long, closing the gap in about `seconds`; there once near enough. */
export function ease(from: number, to: number, dt: number, seconds: number): number {
  if (Math.abs(to - from) < 1e-3) return to;
  return from + (to - from) * (1 - Math.exp(-Math.max(0, dt) / seconds));
}

type Vec = [number, number, number];

/**
 * How far the camera moves this frame to keep up with you: exactly as far as
 * you moved, so it never trails behind however fast you go, plus a share of
 * whatever gap walking didn't make (the first framing, a seat you settled
 * onto, the bob of each step), closed smoothly so it never jitters.
 * `aim` is where the camera looks now, `head` where it should, after `moved`.
 */
export function keepUp(aim: Vec, head: Vec, moved: Vec, dt: number, seconds = FOLLOW_SECONDS): Vec {
  const k = 1 - Math.exp(-Math.max(0, dt) / seconds);
  return [0, 1, 2].map((i) => moved[i] + (head[i] - aim[i] - moved[i]) * k) as Vec;
}
