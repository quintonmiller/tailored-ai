/**
 * How the avatar moves on its own: it breathes, glances about, blinks, and
 * takes a pose for each moment of a spoken turn: leaning in while you talk,
 * looking up and away while it thinks, nodding along with its own voice.
 *
 * Nothing here asks the model for anything. The moments come from the turn the
 * Talk page is already following, and the mouth from the loudness of the
 * audio, so the body costs no tokens and no latency.
 *
 * Pure (time in, pose out) so it is tested without a GPU; the stage only
 * copies the numbers onto the model.
 */

/** The moment of a spoken turn the body is showing. The Talk page's own phases. */
export type BodyState = "idle" | "listening" | "thinking" | "speaking";

export const POSE_BONES = [
  "spine",
  "chest",
  "neck",
  "head",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
] as const;
export type PoseBone = (typeof POSE_BONES)[number];

/** Euler rotation in radians, in the VRM 1.0 frame: the model faces +Z, its left arm points along +X. */
export type Rotation = [x: number, y: number, z: number];

export interface Pose {
  /** Every bone in {@link POSE_BONES}, always, so nothing keeps a stale rotation. */
  bones: Record<PoseBone, Rotation>;
  /** Expression weights, 0–1: the eyes closing, and the mouth opening on an "ah". */
  expressions: { blink: number; aa: number };
  /** Where the eyes point, as an offset from the viewer: right and up, roughly in head heights. */
  gaze: [x: number, y: number];
}

/** Standing at ease: arms down from the T-pose every model is rigged in. */
const REST: Record<PoseBone, Rotation> = {
  spine: [0, 0, 0],
  chest: [0, 0, 0],
  neck: [0, 0, 0],
  head: [0.02, 0, 0],
  leftUpperArm: [0, 0, -1.2],
  rightUpperArm: [0, 0, 1.2],
  leftLowerArm: [0, -0.15, 0],
  rightLowerArm: [0, 0.15, 0],
};

/** Each moment's offset from rest. */
const MOMENTS: Record<BodyState, { bones: Partial<Record<PoseBone, Rotation>>; gaze: [number, number] }> = {
  idle: { bones: {}, gaze: [0, 0] },
  // Leaning in with the head a little on one side: attending to you.
  listening: { bones: { spine: [0.05, 0, 0], head: [0.05, 0, 0.09] }, gaze: [0, 0] },
  // Looking up and away, as people do when they reach for an answer.
  thinking: { bones: { spine: [-0.02, 0.04, 0], head: [-0.13, 0.24, -0.05] }, gaze: [0.35, 0.3] },
  speaking: { bones: { head: [0.02, 0, 0] }, gaze: [0, 0] },
};

/** Seconds for the body to settle into a new moment. */
const SETTLE_SECONDS = 0.35;
/** A blink, start to finish. */
const BLINK_SECONDS = 0.16;
/** The mouth opens faster than it closes, as a jaw does. */
const MOUTH_OPEN_SECONDS = 0.03;
const MOUTH_CLOSE_SECONDS = 0.07;
/** With reduced motion asked for: the poses stay, the idle drift and the nodding mostly go. */
const REDUCED_DRIFT = 0.25;

const STATES = Object.keys(MOMENTS) as BodyState[];

export class Motion {
  private last: number | undefined;
  private readonly weights: Record<BodyState, number> = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  private mouth = 0;
  private nextBlink: number | undefined;
  private blinkStart = Number.NEGATIVE_INFINITY;
  private readonly drift: number;
  private readonly random: () => number;

  constructor(opts: { reducedMotion?: boolean; random?: () => number } = {}) {
    this.drift = opts.reducedMotion ? REDUCED_DRIFT : 1;
    this.random = opts.random ?? Math.random;
  }

  /** Advance to `t` seconds. `state` is the turn's moment, `loudness` the voice's level now, 0–1. */
  step(t: number, state: BodyState, loudness: number): Pose {
    const dt = this.last === undefined ? 0 : Math.max(0, t - this.last);
    this.last = t;

    // Every moment eases toward 1 (the current one) or 0, at the same rate, so
    // the weights keep summing to 1 and a change of moment is a blend.
    const settle = 1 - Math.exp(-dt / SETTLE_SECONDS);
    for (const s of STATES) this.weights[s] += ((s === state ? 1 : 0) - this.weights[s]) * settle;

    const level = state === "speaking" ? clamp01(loudness) : 0;
    const tau = level > this.mouth ? MOUTH_OPEN_SECONDS : MOUTH_CLOSE_SECONDS;
    this.mouth += (level - this.mouth) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 0);

    const bones = {} as Record<PoseBone, Rotation>;
    for (const bone of POSE_BONES) {
      const r: Rotation = [...REST[bone]];
      for (const s of STATES) {
        const offset = MOMENTS[s].bones[bone];
        if (offset) for (let i = 0; i < 3; i++) r[i] += offset[i] * this.weights[s];
      }
      bones[bone] = r;
    }

    // Idle life, on periods that don't line up, so it never visibly loops.
    const d = this.drift;
    const breath = Math.sin((2 * Math.PI * t) / 4.2);
    bones.chest[0] += 0.015 * breath * d;
    bones.leftUpperArm[2] -= 0.02 * breath * d;
    bones.rightUpperArm[2] += 0.02 * breath * d;
    bones.spine[2] += 0.01 * Math.sin((2 * Math.PI * t) / 7.3) * d;
    bones.head[1] += (0.04 * Math.sin((2 * Math.PI * t) / 9.1) + 0.02 * Math.sin((2 * Math.PI * t) / 3.7)) * d;
    bones.head[0] += 0.015 * Math.sin((2 * Math.PI * t) / 6.1) * d;
    // Nodding along with its own voice: down on the loud syllables.
    bones.head[0] += 0.05 * this.mouth * d;
    bones.head[1] += 0.02 * Math.sin(2 * Math.PI * 0.9 * t) * this.weights.speaking * d;

    const gaze: [number, number] = [0, 0];
    for (const s of STATES) {
      gaze[0] += MOMENTS[s].gaze[0] * this.weights[s];
      gaze[1] += MOMENTS[s].gaze[1] * this.weights[s];
    }

    return { bones, expressions: { blink: this.blink(t), aa: clamp01(this.mouth * 1.1) }, gaze };
  }

  /** Every two to six seconds, a quick close and open. */
  private blink(t: number): number {
    if (this.nextBlink === undefined) this.nextBlink = t + 1 + this.random() * 3;
    if (t >= this.nextBlink) {
      this.blinkStart = t;
      this.nextBlink = t + 2 + this.random() * 4;
    }
    const phase = (t - this.blinkStart) / BLINK_SECONDS;
    return phase < 0 || phase > 1 ? 0 : 1 - Math.abs(2 * phase - 1);
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
