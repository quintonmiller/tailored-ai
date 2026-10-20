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
/** Outdoors you walk this many times as fast, so a street takes a few seconds and the far side of town a minute. */
export const OUTDOOR_PACE = 1.6;
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

/** How fast you go, in metres a second, walking or flying, with Shift held or not, indoors or out. */
export function travelSpeed(travel: Travel, running: boolean, outdoors = false): number {
  const pace = travel === "fly" ? FLY_SPEED : WALK_SPEED * (outdoors ? OUTDOOR_PACE : 1);
  return pace * (running ? RUN_FACTOR : 1);
}

/** How long a moment's flying a notch of the wheel is worth, in seconds: the wheel flies you along the way you look. */
export const FLY_NOTCH_SECONDS = 0.4;

/**
 * How far a turn of the wheel flies you, in metres along the way you look: a
 * notch (100 pixels) is `FLY_NOTCH_SECONDS` of flying; rolled toward you (a
 * positive `pixels`), back, as the wheel zooms out walking; away, forward.
 */
export function flyWheelStep(pixels: number): number {
  return -(pixels / 100) * FLY_SPEED * FLY_NOTCH_SECONDS;
}

/**
 * How far a pinch flies you, in metres along the way you look, as the
 * fingers go from `apart` to `now` pixels apart: spread, forward, and
 * closed, back, as a pinch zooms walking; 100 pixels of it a notch of the
 * wheel (`flyWheelStep`).
 */
export function flyPinchStep(apart: number, now: number): number {
  return flyWheelStep(apart - now);
}

/**
 * The lowest the flying camera goes, in metres over the floor or the ground:
 * low enough to look under a table, never down through the floor.
 */
export const FLY_FLOOR = 0.4;
/** Indoors the flying camera keeps this far in from the walls and down from the ceiling, so it never looks through one. */
export const FLY_INSET = 0.25;
/** Outdoors it flies no higher than this, in metres: the whole town below, never lost in the sky. */
export const FLY_SKY = 60;
/** Outdoors it flies no further than this past the town's edges, in metres. */
export const FLY_BEYOND = 10;

/** The box the flying camera stays in: its least and most x, y and z, in metres. */
export interface FlyBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Where you can fly. In a room, inside it: between the floor and the ceiling
 * and within its walls, open sides and all, so you look round the room from
 * anywhere in it and never lose it. Outdoors, over the town, from just above
 * the ground to `FLY_SKY`, a little past its edges.
 */
export function flyBounds(room: { width: number; depth: number; height: number; town?: unknown }): FlyBounds {
  if (room.town) {
    const [x, z] = [room.width / 2 + FLY_BEYOND, room.depth / 2 + FLY_BEYOND];
    return { min: [-x, FLY_FLOOR, -z], max: [x, FLY_SKY, z] };
  }
  const x = Math.max(0, room.width / 2 - FLY_INSET);
  const z = Math.max(0, room.depth / 2 - FLY_INSET);
  const top = Math.max(FLY_FLOOR, room.height - FLY_INSET);
  return { min: [-x, FLY_FLOOR, -z], max: [x, top, z] };
}

/** A point brought into the bounds the shortest way: each of x, y and z kept between its least and most. */
export function keptIn(p: [number, number, number], b: FlyBounds): [number, number, number] {
  return [0, 1, 2].map((i) => Math.min(b.max[i], Math.max(b.min[i], p[i]))) as [number, number, number];
}

/**
 * Where the camera takes off from, indoors, when you start flying: at your
 * head, a step back along the way the camera looks (`heading`, on the floor),
 * inside the room. From there it looks the same way, a little down, so the
 * room is in front of you as it was.
 */
export function takeOff(
  head: [number, number, number],
  heading: [number, number],
  b: FlyBounds,
): [number, number, number] {
  const back = 1.2;
  return keptIn([head[0] - heading[0] * back, head[1] + 0.3, head[2] - heading[1] * back], b);
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
 * nothing covers. Close behind you, a good part of the room to start, and the
 * whole lobby at the widest; outdoors, a street or two to start, and a good
 * part of the town at the widest. The wheel, or a pinch, moves between them.
 */
export const REACH = { near: 1.4, start: 4.5, far: 12, outdoors: 36, outdoorStart: 11 };
/** Each notch of the wheel (100 pixels of scroll) takes in this many times as much, or as little. */
export const REACH_PER_NOTCH = 1.2;
/** Seconds the camera takes to settle at a new reach, or a new shape of stage: quick, and never a jump. */
export const ZOOM_SECONDS = 0.18;

/**
 * The widest worth seeing round you in a room: the whole of it from its
 * middle, with a little floor beyond. Outdoors, a good part of the town.
 */
export function widestReach(room: { width: number; depth: number; town?: unknown }): number {
  if (room.town) return REACH.outdoors;
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
 * height and `fov` the camera's vertical field of view in degrees; `tall` the
 * share of the stage's height that can be seen, with a phone's chat over the
 * rest. A strip beside the chat or above it backs off further than the whole
 * stage would, so you see as much round you either way.
 */
export function followDistance(reach: number, aspect: number, fov: number, tall = 1): number {
  const tanV = Math.tan((fov * Math.PI) / 360) * tall;
  return reach / Math.min(tanV, tanV * aspect);
}

/** The reach that sits the camera `distance` back: `followDistance` the other way round. */
export function reachAt(distance: number, aspect: number, fov: number, tall = 1): number {
  const tanV = Math.tan((fov * Math.PI) / 360) * tall;
  return distance * Math.min(tanV, tanV * aspect);
}

/** Metres you walk from where you came into a room before the camera, showing the room, comes back round to you. */
export const ARRIVAL_WALKED = 0.6;
/**
 * Under this share of the stage's height, what can be seen is a short strip
 * (a phone's, over its chat), where the reach you walk at takes in the whole
 * room as a sliver: the shot on the way in comes in closer there, as well as
 * backing off where it has to.
 */
export const SHORT_STRIP = 0.5;

/**
 * The shot of a room the camera shows on the way in, as rules: it holds
 * while you stand where you came in (`at`), fitted again whenever what can be
 * seen changes or someone comes in, taking in `reach` while that is not the
 * reach you zoomed to. It is over once you walk off from there or zoom, and
 * then it eases back to your own reach. The stage keeps where it looks.
 */
export class Arrival {
  /** Where you came in, while the shot holds. */
  at: [number, number] | undefined;
  /** How much round you it takes in, when that isn't your own reach. */
  reach: number | undefined;

  /** Come into a room at `at`. */
  begin(at: [number, number]) {
    this.at = [at[0], at[1]];
    this.reach = undefined;
  }

  get holds(): boolean {
    return this.at !== undefined;
  }

  /**
   * Fitted to what can be seen now: the shot `needs` that reach, against
   * `yours`. It backs off to show what it has to; in a short strip (`tall`,
   * the share of the stage's height seen) it comes in as near as it needs
   * too, never nearer than close behind you. Over, it fits nothing.
   */
  fit(needs: number, yours: number, tall: number, widest: number) {
    this.reach = undefined;
    if (!this.at) return;
    if (needs > yours || tall < SHORT_STRIP) this.reach = clampReach(needs, widest);
  }

  /** You are at `p`: walked off from where you came in, the shot is over. */
  moved(p: [number, number]) {
    if (this.at && Math.hypot(p[0] - this.at[0], p[1] - this.at[1]) > ARRIVAL_WALKED) this.at = undefined;
  }

  /** You zoomed, by the wheel or a pinch: the shot is over, and the reach is yours at once. */
  zoomed() {
    this.at = undefined;
    this.reach = undefined;
  }

  /** Over at once: you flew off, or were brought to stand before someone. */
  drop() {
    this.at = undefined;
    this.reach = undefined;
  }

  /** Over, a frame `dt` seconds long eases what it takes in back to `yours`, in about `seconds`: at once for none. */
  settle(yours: number, dt: number, seconds: number) {
    if (this.at || this.reach === undefined) return;
    this.reach = seconds > 0 ? ease(this.reach, yours, dt, seconds) : yours;
    if (Math.abs(this.reach - yours) < 0.02) this.reach = undefined;
  }
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
