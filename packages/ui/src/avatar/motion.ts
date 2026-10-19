/**
 * How the avatar moves on its own: it breathes, glances about, blinks, and
 * takes a pose for each moment of a spoken turn: leaning in while you talk,
 * looking up and away while it thinks, nodding along with its own voice. It
 * walks with a stride that follows the ground it covers, and once it stops
 * at a spot it does what the spot is for: sits, types, looks out, browses.
 *
 * Nothing here asks the model for anything. The moments come from the turn the
 * Talk page is already following, and the mouth from the loudness of the
 * audio, so the body costs no tokens and no latency.
 *
 * Pure (time in, pose out) so it is tested without a GPU; the stage only
 * copies the numbers onto the model.
 */
import type { Activity } from "./scene";

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
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
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
  /** How far down into a seat it has settled, 0–1; the stage moves the body onto the seat by this much. */
  seated: number;
  /** The bob of a walking step, in metres. */
  lift: number;
}

/** What the body is doing besides talking. */
export interface BodyInput {
  /** Metres walked since the last step; it drives the stride. */
  walked: number;
  /** Metres per step, from the figure's size. */
  stride: number;
  /** What it does where it stands, once it has stopped walking. */
  activity?: Activity;
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
  leftUpperLeg: [0, 0, 0],
  rightUpperLeg: [0, 0, 0],
  leftLowerLeg: [0, 0, 0],
  rightLowerLeg: [0, 0, 0],
};

type Offsets = Partial<Record<PoseBone, Rotation>>;

/** Each moment's offset from rest. */
const MOMENTS: Record<BodyState, { bones: Offsets; gaze: [number, number] }> = {
  idle: { bones: {}, gaze: [0, 0] },
  // Leaning in with the head a little on one side: attending to you.
  listening: { bones: { spine: [0.05, 0, 0], head: [0.05, 0, 0.09] }, gaze: [0, 0] },
  // Looking up and away, as people do when they reach for an answer.
  thinking: { bones: { spine: [-0.02, 0.04, 0], head: [-0.13, 0.24, -0.05] }, gaze: [0.35, 0.3] },
  speaking: { bones: { head: [0.02, 0, 0] }, gaze: [0, 0] },
};

/** What each activity does to the body, on top of rest. */
const ACTIVITIES: Record<Activity, Offsets> = {
  // Thighs level, shins down, leaning back a touch, hands toward the lap.
  sit: {
    leftUpperLeg: [-1.45, 0, 0],
    rightUpperLeg: [-1.45, 0, 0],
    leftLowerLeg: [1.4, 0, 0],
    rightLowerLeg: [1.4, 0, 0],
    spine: [-0.05, 0, 0],
    leftUpperArm: [-0.35, 0, 0.2],
    rightUpperArm: [-0.35, 0, -0.2],
  },
  // Arms out to the keyboard, elbows bent, looking down at the screen.
  type: {
    leftUpperArm: [-0.85, 0, 0.5],
    rightUpperArm: [-0.85, 0, -0.5],
    leftLowerArm: [0, -0.9, 0],
    rightLowerArm: [0, 0.9, 0],
    head: [0.18, 0, 0],
    spine: [0.06, 0, 0],
  },
  // Chin up a little, looking out.
  look: { head: [-0.07, 0.08, 0], spine: [-0.02, 0, 0] },
  // Head tilted to read the spines, one hand up to the shelf.
  browse: { head: [0.04, 0, 0.12], rightUpperArm: [-0.7, 0, -0.65], rightLowerArm: [0, 0.4, 0] },
};

/**
 * One-off moves the agent asks for with a cue, on top of everything else:
 * how long each lasts, and its offsets from rest at full strength, `u`
 * seconds in. Each eases in and out, so it starts and ends from whatever the
 * body was doing.
 */
const GESTURE_MOVES: Record<string, { seconds: number; pose: (u: number) => Offsets }> = {
  // Right arm up and out, the forearm swinging side to side.
  wave: {
    seconds: 1.8,
    pose: (u) => ({ rightUpperArm: [0, 0, -2.1], rightLowerArm: [0, 0, -0.5 + 0.4 * Math.sin(2 * Math.PI * 2.5 * u)] }),
  },
  // Two dips of the head.
  nod: { seconds: 1.0, pose: (u) => ({ head: [0.16 * Math.sin(Math.PI * 2 * u) ** 2, 0, 0] }) },
  shake: { seconds: 1.1, pose: (u) => ({ head: [0, 0.28 * Math.sin(2 * Math.PI * 2.5 * u), 0] }) },
  // Arms out from the sides, elbows bent, head tipped.
  shrug: {
    seconds: 1.1,
    pose: () => ({
      leftUpperArm: [0, 0, 0.45],
      rightUpperArm: [0, 0, -0.45],
      leftLowerArm: [0, -0.7, 0],
      rightLowerArm: [0, 0.7, 0],
      head: [0, 0, 0.12],
      spine: [-0.03, 0, 0],
    }),
  },
  // Hand to chin, eyes up and aside.
  think: {
    seconds: 2.2,
    pose: () => ({ rightUpperArm: [-0.9, 0, -0.75], rightLowerArm: [0, 1.5, 0], head: [-0.12, 0.18, 0.05] }),
  },
  bow: {
    seconds: 1.5,
    pose: () => ({
      spine: [0.45, 0, 0],
      head: [0.15, 0, 0],
      leftUpperArm: [-0.15, 0, 0],
      rightUpperArm: [-0.15, 0, 0],
    }),
  },
  // Right arm out straight ahead; the stage turns the body to face the target first.
  point: { seconds: 2.2, pose: () => ({ rightUpperArm: [-1.35, 0, -1.0], rightLowerArm: [0, -0.15, 0] }) },
};

/** Seconds a look at something is held. */
const LOOK_SECONDS = 2.5;

/** 0 to 1 and back over a move's length: eased in over a quarter second, out over a third. */
function envelope(u: number, seconds: number): number {
  if (u < 0 || u > seconds) return 0;
  const smooth = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return c * c * (3 - 2 * c);
  };
  return smooth(u / 0.25) * smooth((seconds - u) / 0.35);
}

/** Seconds for the body to settle into a new moment. */
const SETTLE_SECONDS = 0.35;
/** Starting and stopping a walk. */
const WALK_SECONDS = 0.12;
/** Sitting down, standing up, raising the hands to type. */
const ACTIVITY_SECONDS = 0.45;
/** A blink, start to finish. */
const BLINK_SECONDS = 0.16;
/** The mouth opens faster than it closes, as a jaw does. */
const MOUTH_OPEN_SECONDS = 0.03;
const MOUTH_CLOSE_SECONDS = 0.07;
/** With reduced motion asked for: the poses stay, the idle drift and the nodding mostly go. */
const REDUCED_DRIFT = 0.25;

const STATES = Object.keys(MOMENTS) as BodyState[];
const ACTIVITY_NAMES = Object.keys(ACTIVITIES) as Activity[];

export class Motion {
  private last: number | undefined;
  private readonly weights: Record<BodyState, number> = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  private readonly doing: Record<Activity, number> = { sit: 0, type: 0, look: 0, browse: 0 };
  private walking = 0;
  private gait = 0;
  private mouth = 0;
  private nextBlink: number | undefined;
  private blinkStart = Number.NEGATIVE_INFINITY;
  private moves: { name: string; at: number }[] = [];
  private gazeAt: { yaw: number; pitch: number; at: number } | undefined;
  private readonly drift: number;
  private readonly random: () => number;

  constructor(opts: { reducedMotion?: boolean; random?: () => number } = {}) {
    this.drift = opts.reducedMotion ? REDUCED_DRIFT : 1;
    this.random = opts.random ?? Math.random;
  }

  /** Make a gesture, starting at `at` seconds. False for one this body has no move for. */
  gesture(name: string, at: number): boolean {
    if (!GESTURE_MOVES[name]) return false;
    this.moves = [...this.moves.filter((m) => m.name !== name), { name, at }];
    return true;
  }

  /** Turn the head toward something for a moment: `yaw` to the figure's left, `pitch` up, in radians. */
  look(yaw: number, pitch: number, at: number) {
    this.gazeAt = { yaw: Math.max(-1, Math.min(1, yaw)), pitch: Math.max(-0.5, Math.min(0.5, pitch)), at };
  }

  /**
   * Advance to `t` seconds. `state` is the turn's moment, `loudness` the
   * voice's level now (0–1), `body` the walking and the activity.
   */
  step(t: number, state: BodyState, loudness: number, body: BodyInput = { walked: 0, stride: 1 }): Pose {
    const dt = this.last === undefined ? 0 : Math.max(0, t - this.last);
    this.last = t;
    const ease = (seconds: number) => 1 - Math.exp(-dt / seconds);

    // Every moment eases toward 1 (the current one) or 0, at the same rate, so
    // the weights keep summing to 1 and a change of moment is a blend.
    const settle = ease(SETTLE_SECONDS);
    for (const s of STATES) this.weights[s] += ((s === state ? 1 : 0) - this.weights[s]) * settle;

    const moving = body.walked > 1e-5;
    this.walking += ((moving ? 1 : 0) - this.walking) * ease(WALK_SECONDS);
    // Half a cycle per step, so each foot lands once a stride.
    this.gait += (body.walked / Math.max(0.05, body.stride)) * Math.PI;
    const act = ease(ACTIVITY_SECONDS);
    for (const a of ACTIVITY_NAMES) this.doing[a] += ((a === body.activity && !moving ? 1 : 0) - this.doing[a]) * act;

    const level = state === "speaking" ? clamp01(loudness) : 0;
    const tau = level > this.mouth ? MOUTH_OPEN_SECONDS : MOUTH_CLOSE_SECONDS;
    this.mouth += (level - this.mouth) * (dt > 0 ? ease(tau) : 0);

    const bones = {} as Record<PoseBone, Rotation>;
    for (const bone of POSE_BONES) {
      const r: Rotation = [...REST[bone]];
      const add = (offset: Rotation | undefined, weight: number) => {
        if (offset) for (let i = 0; i < 3; i++) r[i] += offset[i] * weight;
      };
      for (const s of STATES) add(MOMENTS[s].bones[bone], this.weights[s]);
      for (const a of ACTIVITY_NAMES) add(ACTIVITIES[a][bone], this.doing[a]);
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
    // Busy hands at the keyboard, and eyes along the shelf.
    bones.leftLowerArm[0] += 0.05 * Math.sin(t * 13) * this.doing.type;
    bones.rightLowerArm[0] += 0.05 * Math.sin(t * 13 + 1.7) * this.doing.type;
    bones.head[1] += 0.15 * Math.sin(t * 0.6) * this.doing.browse * d;

    // The walk: legs swing opposite each other, each knee bends as its leg
    // comes forward, arms swing against the legs, and the body bobs.
    const w = this.walking;
    const s = Math.sin(this.gait);
    const c = Math.cos(this.gait);
    bones.leftUpperLeg[0] -= 0.5 * s * w;
    bones.rightUpperLeg[0] += 0.5 * s * w;
    bones.leftLowerLeg[0] += 0.7 * Math.max(0, c) * w;
    bones.rightLowerLeg[0] += 0.7 * Math.max(0, -c) * w;
    bones.leftUpperArm[0] += 0.35 * s * w;
    bones.rightUpperArm[0] -= 0.35 * s * w;
    bones.spine[1] += 0.05 * s * w;
    bones.head[1] -= 0.03 * s * w;

    // Gestures and looks the agent asked for, layered on top.
    this.moves = this.moves.filter((m) => t - m.at <= GESTURE_MOVES[m.name].seconds);
    for (const m of this.moves) {
      const move = GESTURE_MOVES[m.name];
      const weight = envelope(t - m.at, move.seconds);
      const pose = move.pose(t - m.at);
      for (const bone of POSE_BONES) {
        const o = pose[bone];
        if (o) for (let i = 0; i < 3; i++) bones[bone][i] += o[i] * weight;
      }
    }
    if (this.gazeAt) {
      const weight = envelope(t - this.gazeAt.at, LOOK_SECONDS);
      bones.head[1] += this.gazeAt.yaw * weight;
      bones.head[0] -= this.gazeAt.pitch * weight;
      if (t - this.gazeAt.at > LOOK_SECONDS) this.gazeAt = undefined;
    }

    const gaze: [number, number] = [0, 0];
    for (const st of STATES) {
      gaze[0] += MOMENTS[st].gaze[0] * this.weights[st];
      gaze[1] += MOMENTS[st].gaze[1] * this.weights[st];
    }

    return {
      bones,
      expressions: { blink: this.blink(t), aa: clamp01(this.mouth * 1.1) },
      gaze,
      seated: this.doing.sit,
      lift: 0.012 * Math.abs(c) * w,
    };
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
