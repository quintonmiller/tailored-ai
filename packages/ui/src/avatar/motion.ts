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
import * as THREE from "three";
import type { Idle, Posture, WalkStyle } from "./body";
import type { Hold } from "./doing";
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
  /**
   * With animation files playing: bones an arm gesture, a hold or folded arms
   * take over, posed in full rather than as offsets, and how far each is
   * taken (0–1, `weights`; `weight` is the most of them). The stage blends
   * from the files' pose to these, so a wave is a wave and not a wave
   * stacked on whatever the arm was doing.
   */
  owned?: {
    bones: Partial<Record<PoseBone, Rotation>>;
    weights: Partial<Record<PoseBone, number>>;
    weight: number;
  };
}

/** What the body is doing besides talking. */
export interface BodyInput {
  /** Metres walked since the last step; it drives the stride. */
  walked: number;
  /** Metres per step, from the figure's size. */
  stride: number;
  /** What it does where it stands, once it has stopped walking. */
  activity?: Activity;
  /**
   * Set when animation files play the base pose. The pose returned is then
   * only what goes on top of them: the moments of the turn, gestures, looks,
   * and the activities the files don't cover. No rest pose, walk cycle or
   * breathing, which the files have.
   */
  clips?: { walk: boolean; activities: Activity[]; folded?: boolean; styledWalk?: boolean };
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
 * Moves the agent asks for, with a cue or its `body` tool, on top of
 * everything else: how long each lasts, and its offsets from rest at full
 * strength, `u` seconds in. Each eases in and out, so it starts and ends from
 * whatever the body was doing. Kept going for a while, a move with a `cycle`
 * goes round it again and again; one without holds its pose. `lift` raises
 * the whole body, for a hop.
 */
interface Move {
  seconds: number;
  pose: (u: number) => Offsets;
  owns?: PoseBone[];
  cycle?: number;
  lift?: (u: number) => number;
}
const ARMS: PoseBone[] = ["leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm"];
const RIGHT_ARM: PoseBone[] = ["rightUpperArm", "rightLowerArm"];
const wave = (u: number, cycle: number) => Math.sin((2 * Math.PI * u) / cycle);

const GESTURE_MOVES: Record<string, Move> = {
  // Right arm up and out, the forearm swinging side to side.
  wave: {
    seconds: 1.8,
    cycle: 0.4,
    owns: RIGHT_ARM,
    pose: (u) => ({ rightUpperArm: [0, 0, -2.1], rightLowerArm: [0, 0, -0.5 + 0.4 * Math.sin(2 * Math.PI * 2.5 * u)] }),
  },
  // Two dips of the head.
  nod: { seconds: 1.0, cycle: 0.5, pose: (u) => ({ head: [0.16 * Math.sin(Math.PI * 2 * u) ** 2, 0, 0] }) },
  shake: { seconds: 1.1, cycle: 0.4, pose: (u) => ({ head: [0, 0.28 * Math.sin(2 * Math.PI * 2.5 * u), 0] }) },
  // Arms out from the sides, elbows bent, head tipped.
  shrug: {
    seconds: 1.1,
    owns: ARMS,
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
    owns: RIGHT_ARM,
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
  // Both arms up over the head and a lean back, looking up: a stretch after sitting a while.
  stretch: {
    seconds: 2.8,
    owns: ARMS,
    pose: () => ({
      leftUpperArm: [0, 0, 2.55],
      rightUpperArm: [0, 0, -2.55],
      leftLowerArm: [0, -0.3, 0],
      rightLowerArm: [0, 0.3, 0],
      spine: [-0.08, 0, 0],
      head: [-0.2, 0, 0],
    }),
  },
  // Talking with the hands: the right forearm up, palm out, turning as a point is made; the head tips along.
  chat: {
    seconds: 1.6,
    owns: ["rightUpperArm", "rightLowerArm"],
    pose: (u) => ({
      rightUpperArm: [-0.35, 0, -0.95],
      rightLowerArm: [0, 1.15 + 0.25 * Math.sin(2 * Math.PI * 1.5 * u), 0],
      head: [0, 0.06 * Math.sin(2 * Math.PI * u), 0.04],
    }),
  },
  // Right arm out straight ahead; the stage turns the body to face the target first.
  point: {
    seconds: 2.2,
    owns: RIGHT_ARM,
    pose: () => ({ rightUpperArm: [-1.35, 0, -1.0], rightLowerArm: [0, -0.15, 0] }),
  },
  // Both arms flung up in a V, pumping, chin up, a little bounce.
  cheer: {
    seconds: 2.0,
    cycle: 0.5,
    owns: ARMS,
    pose: (u) => {
      const pump = 0.18 * Math.max(0, wave(u, 0.5));
      return {
        leftUpperArm: [0, 0, 2.2 + pump],
        rightUpperArm: [0, 0, -2.2 - pump],
        leftLowerArm: [0, -0.35 + pump, 0],
        rightLowerArm: [0, 0.35 - pump, 0],
        head: [-0.18, 0, 0],
        spine: [-0.06, 0, 0],
      };
    },
    lift: (u) => 0.03 * Math.max(0, wave(u, 0.5)),
  },
  // Arms out in front, the forearms swinging in until the hands meet before the chest, again and again.
  clap: {
    seconds: 2.0,
    cycle: 0.42,
    owns: ARMS,
    pose: (u) => {
      const open = (1 + wave(u, 0.42)) / 2;
      return {
        leftUpperArm: [0, -1.2, 0.95],
        rightUpperArm: [0, 1.2, -0.95],
        leftLowerArm: [0, -1.3 + 0.5 * open, 0],
        rightLowerArm: [0, 1.3 - 0.5 * open, 0],
        head: [0.04, 0, 0],
      };
    },
  },
  // A sway from side to side to a beat, elbows out and forearms up, pumping one arm then the other, knees bobbing.
  dance: {
    seconds: 3.6,
    cycle: 0.9,
    owns: ARMS,
    pose: (u) => {
      const beat = wave(u, 0.9);
      const bob = Math.abs(wave(u, 0.9));
      return {
        spine: [0.04, 0.16 * beat, 0.1 * beat],
        chest: [0, 0.1 * beat, 0],
        head: [0.06 * bob, -0.1 * beat, 0.12 * beat],
        leftUpperArm: [-0.25, 0, 1.0 + 0.35 * beat],
        rightUpperArm: [-0.25, 0, -1.0 + 0.35 * beat],
        leftLowerArm: [0, -0.3, 1.3],
        rightLowerArm: [0, 0.3, -1.3],
        leftUpperLeg: [-0.18 * bob, 0, 0],
        rightUpperLeg: [-0.18 * bob, 0, 0],
        leftLowerLeg: [0.36 * bob, 0, 0],
        rightLowerLeg: [0.36 * bob, 0, 0],
      };
    },
    lift: (u) => -0.035 * Math.abs(wave(u, 0.9)),
  },
  // Right hand to the brow, standing straight.
  salute: {
    seconds: 1.8,
    owns: RIGHT_ARM,
    pose: () => ({
      rightUpperArm: [0, 0.55, -1.1],
      rightLowerArm: [0, 0.55, -2.15],
      spine: [-0.04, 0, 0],
      head: [-0.05, 0, 0],
    }),
  },
  // Down into a crouch, up off the floor with the arms swinging up, and down again.
  jump: {
    seconds: 1.1,
    cycle: 1.1,
    owns: ARMS,
    pose: (u) => {
      const crouch = u < 0.3 ? Math.sin((Math.PI * u) / 0.3) : u > 0.8 ? Math.sin((Math.PI * (u - 0.8)) / 0.3) : 0;
      const up = u >= 0.3 && u <= 0.8 ? Math.sin((Math.PI * (u - 0.3)) / 0.5) : 0;
      return {
        leftUpperLeg: [-0.7 * crouch, 0, 0],
        rightUpperLeg: [-0.7 * crouch, 0, 0],
        leftLowerLeg: [1.2 * crouch, 0, 0],
        rightLowerLeg: [1.2 * crouch, 0, 0],
        spine: [0.25 * crouch - 0.05 * up, 0, 0],
        leftUpperArm: [-0.6 * crouch, 0, 0.3 + 1.6 * up],
        rightUpperArm: [-0.6 * crouch, 0, -0.3 - 1.6 * up],
        head: [-0.1 * up, 0, 0],
      };
    },
    lift: (u) => {
      const crouch = u < 0.3 ? Math.sin((Math.PI * u) / 0.3) : u > 0.8 ? Math.sin((Math.PI * (u - 0.8)) / 0.3) : 0;
      const up = u >= 0.3 && u <= 0.8 ? Math.sin((Math.PI * (u - 0.3)) / 0.5) : 0;
      return 0.22 * up - 0.12 * crouch;
    },
  },
  // Head back and shoulders shaking, a hand to the belly.
  laugh: {
    seconds: 2.0,
    cycle: 0.26,
    owns: RIGHT_ARM,
    pose: (u) => {
      const shake = wave(u, 0.26);
      return {
        head: [-0.22 + 0.05 * shake, 0, 0.05],
        neck: [-0.05, 0, 0],
        spine: [-0.1 + 0.03 * shake, 0, 0],
        chest: [0.03 * shake, 0, 0],
        leftUpperArm: [0, 0, 0.06 * shake],
        rightUpperArm: [-0.55, 0, 0.15],
        rightLowerArm: [0, 1.45, 0],
      };
    },
  },
};

/** The gestures there are a move for. */
export const MOVES = Object.keys(GESTURE_MOVES);

/**
 * How each posture holds the body, on top of whatever else it is doing: the
 * back, the shoulders and the head; arms folded across the chest only while
 * it stands with nothing else to do with them.
 */
const POSTURE_OFFSETS: Record<Posture, Offsets> = {
  upright: { spine: [-0.04, 0, 0], chest: [-0.04, 0, 0], head: [-0.05, 0, 0] },
  slouched: { spine: [0.13, 0, 0], chest: [0.07, 0, 0], neck: [0.03, 0, 0], head: [0, 0, 0] },
  proud: {
    spine: [-0.07, 0, 0],
    chest: [-0.1, 0, 0],
    head: [-0.14, 0, 0],
    leftUpperArm: [0, 0, 0.1],
    rightUpperArm: [0, 0, -0.1],
  },
  shy: { spine: [0.09, 0, 0], head: [0.24, 0, 0.12], leftUpperArm: [0, 0, -0.08], rightUpperArm: [0, 0, 0.08] },
  "arms folded": { spine: [-0.02, 0, 0], head: [-0.03, 0, 0] },
};
/** Arms folded across the chest, posed from rest in full. */
const FOLDED: Offsets = {
  leftUpperArm: [-0.8, 0, -0.1],
  rightUpperArm: [-0.8, 0, 0.1],
  leftLowerArm: [0, -1.95, 0],
  rightLowerArm: [0, 1.95, 0],
};
/** What an idle style does to how it stands: sleepy droops, focused leans in a little. */
const IDLE_OFFSETS: Partial<Record<Idle, Offsets>> = {
  sleepy: { head: [0.06, 0, 0.1], spine: [0.03, 0, 0] },
  focused: { head: [0.07, 0, 0], spine: [0.03, 0, 0] },
  lively: { chest: [-0.03, 0, 0], head: [-0.03, 0, 0] },
};

/** How a body carries itself, as the stage hands it over: see `body.ts`. */
export interface Carriage {
  idle?: Idle;
  posture?: Posture;
  /** How much it fidgets, 1 as before. */
  drift?: number;
  /** How fast its idle animation plays, 1 as made. */
  pace?: number;
  walk?: WalkStyle;
}

/**
 * Holding something in the right hand, posed from rest in full: up to the
 * eyes (a camera), at the ear (a phone call), in front of the chest (a book,
 * a tablet), or out ahead (a magnifier). The head looks at what it holds.
 */
const HOLDS: Record<Hold, { arm: Offsets; head: Rotation }> = {
  // The arm down first (z), then swung forward (x); the elbow bends it up (lower y).
  up: { arm: { rightUpperArm: [-1.35, 0, 0.25], rightLowerArm: [0, 1.55, 0] }, head: [0, 0, 0] },
  // Out to the side and twisted, as the hand-to-chin gesture is, so the elbow folds up toward the head.
  ear: { arm: { rightUpperArm: [-1.2, 0, -0.9], rightLowerArm: [0, 2.15, 0] }, head: [0, 0, -0.08] },
  chest: { arm: { rightUpperArm: [-0.85, 0, 0.2], rightLowerArm: [0, 1.5, 0] }, head: [0.28, 0, 0] },
  out: { arm: { rightUpperArm: [-1.45, 0, 0.25], rightLowerArm: [0, 0.3, 0] }, head: [0.22, 0, 0] },
};
const HOLD_BONES = ["rightUpperArm", "rightLowerArm"] as const;

/** Asleep: chin down, a little slumped. */
const ASLEEP: Offsets = { head: [0.42, 0, 0.12], neck: [0.08, 0, 0], spine: [0.08, 0, 0] };

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
/** Nodding off, and waking. */
const SLEEP_SECONDS = 1.2;
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
  private moves: { name: string; at: number; until?: number }[] = [];
  private carriage: Carriage = {};
  private holding: Hold | undefined;
  /** The hold last shown, kept while it fades out. */
  private held: Hold | undefined;
  private holdWeight = 0;
  private sleeping = false;
  private sleep = 0;
  /**
   * Extra outward swing for the upper arms, in radians, so the hands clear a
   * body wider than the arms were posed for. Measured per model by the stage.
   */
  armClearance = 0;
  /**
   * How far below level this model's arms hang as made, in radians (`droopOf`
   * in fit.ts). Gestures are written for a model made in a T-pose; on one
   * made in an A-pose, an arm a gesture takes over is turned as the T-pose's
   * would be (`asMade`), so a wave is up, a stretch overhead and a clap's
   * hands meet before the chest. None for a T-pose.
   */
  armDroop = 0;
  /**
   * The arm holding a phone to this body's own ear, measured by the stage
   * (`reach` in fit.ts): the upper and lower arm turned in full, from the arm
   * as made. A big head on short arms needs a pose of its own; without one,
   * the pose drawn for a grown-up.
   */
  ear: { upper: Rotation; lower: Rotation } | undefined;
  private gazeAt: { yaw: number; pitch: number; at: number } | undefined;
  private readonly drift: number;
  private readonly random: () => number;

  constructor(opts: { reducedMotion?: boolean; random?: () => number } = {}) {
    this.drift = opts.reducedMotion ? REDUCED_DRIFT : 1;
    this.random = opts.random ?? Math.random;
  }

  /**
   * Make a gesture, starting at `at` seconds: once, or kept going until
   * `until` seconds. False for one this body has no move for.
   */
  gesture(name: string, at: number, until?: number): boolean {
    if (!GESTURE_MOVES[name]) return false;
    const going = until !== undefined && until > at + GESTURE_MOVES[name].seconds ? { until } : {};
    this.moves = [...this.moves.filter((m) => m.name !== name), { name, at, ...going }];
    return true;
  }

  /** Stop every gesture kept going: another one asked for, or the body is wanted for something else. */
  stopGestures(at: number) {
    this.moves = this.moves.map((m) => (m.until !== undefined && m.until > at + 0.35 ? { ...m, until: at + 0.35 } : m));
  }

  /** How it carries itself from now: its posture, how much it fidgets, how it walks. */
  carry(carriage: Carriage) {
    this.carriage = carriage;
  }

  /** Hold something in the right hand, or nothing. */
  hold(how: Hold | undefined) {
    this.holding = how;
    if (how) this.held = how;
  }

  /** Nod off, or wake up. */
  doze(asleep: boolean) {
    this.sleeping = asleep;
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

    this.holdWeight += ((this.holding ? 1 : 0) - this.holdWeight) * act;
    this.sleep += ((this.sleeping ? 1 : 0) - this.sleep) * ease(SLEEP_SECONDS);

    const level = state === "speaking" ? clamp01(loudness) : 0;
    const tau = level > this.mouth ? MOUTH_OPEN_SECONDS : MOUTH_CLOSE_SECONDS;
    this.mouth += (level - this.mouth) * (dt > 0 ? ease(tau) : 0);

    const clips = body.clips;
    const bones = {} as Record<PoseBone, Rotation>;
    for (const bone of POSE_BONES) {
      const r: Rotation = clips ? [0, 0, 0] : [...REST[bone]];
      const add = (offset: Rotation | undefined, weight: number) => {
        if (offset) for (let i = 0; i < 3; i++) r[i] += offset[i] * weight;
      };
      for (const s of STATES) add(MOMENTS[s].bones[bone], this.weights[s]);
      for (const a of ACTIVITY_NAMES) if (!clips?.activities.includes(a)) add(ACTIVITIES[a][bone], this.doing[a]);
      bones[bone] = r;
    }
    bones.leftUpperArm[2] += this.armClearance;
    bones.rightUpperArm[2] -= this.armClearance;

    // How it carries itself: its posture, and how its idle style has it stand.
    const { posture, idle, walk: style } = this.carriage;
    for (const offsets of [posture ? POSTURE_OFFSETS[posture] : undefined, idle ? IDLE_OFFSETS[idle] : undefined])
      for (const [bone, o] of Object.entries(offsets ?? {}) as [PoseBone, Rotation][])
        for (let i = 0; i < 3; i++) bones[bone][i] += o[i];

    // Idle life, on periods that don't line up, so it never visibly loops.
    const d = this.drift * (this.carriage.drift ?? 1);
    if (!clips) {
      const breath = Math.sin((2 * Math.PI * t) / 4.2);
      bones.chest[0] += 0.015 * breath * d;
      bones.leftUpperArm[2] -= 0.02 * breath * d;
      bones.rightUpperArm[2] += 0.02 * breath * d;
      bones.spine[2] += 0.01 * Math.sin((2 * Math.PI * t) / 7.3) * d;
    }
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
    const w = clips?.walk ? 0 : this.walking;
    const s = Math.sin(this.gait);
    const c = Math.cos(this.gait);
    // A march lifts the knees; a sneak goes on bent ones.
    const stride = style?.clip === "march" ? 1.35 : 1;
    const swing = style?.swing ?? 1;
    bones.leftUpperLeg[0] -= 0.5 * stride * s * w;
    bones.rightUpperLeg[0] += 0.5 * stride * s * w;
    bones.leftLowerLeg[0] += 0.7 * Math.max(0, c) * w;
    bones.rightLowerLeg[0] += 0.7 * Math.max(0, -c) * w;
    bones.leftUpperArm[0] += 0.35 * swing * s * w;
    bones.rightUpperArm[0] -= 0.35 * swing * s * w;
    bones.spine[1] += 0.05 * s * w;
    bones.head[1] -= 0.03 * s * w;
    const crouch = style?.clip === "sneak" && !clips?.styledWalk ? this.walking : 0;
    if (crouch) {
      for (const leg of ["leftUpperLeg", "rightUpperLeg"] as const) bones[leg][0] -= 0.45 * crouch;
      for (const leg of ["leftLowerLeg", "rightLowerLeg"] as const) bones[leg][0] += 0.8 * crouch;
    }
    // Its way of walking, over the files' walk too: leaning into it (a sneak clip leans by itself), the shoulders
    // swaying, and a bob in each step.
    if (style) {
      bones.spine[0] += style.lean * this.walking * (clips?.styledWalk ? 0 : 1);
      bones.spine[2] += style.sway * s * this.walking;
      bones.chest[1] += style.sway * 0.8 * s * this.walking;
    }
    let lift = 0.012 * Math.abs(c) * w + (style?.bob ?? 0) * Math.abs(c) * this.walking - 0.08 * crouch;

    // Gestures and looks the agent asked for, layered on top: once, or round and round until they are over.
    const length = (m: { name: string; at: number; until?: number }) =>
      (m.until ?? m.at + GESTURE_MOVES[m.name].seconds) - m.at;
    this.moves = this.moves.filter((m) => t - m.at <= length(m));
    // The bones a gesture takes over, each posed in full from rest, and how far the gesture has it now.
    const gestured: Layers = {};
    for (const m of this.moves) {
      const move = GESTURE_MOVES[m.name];
      const weight = envelope(t - m.at, length(m));
      const u = m.until !== undefined && move.cycle ? (t - m.at) % move.cycle : t - m.at;
      const pose = move.pose(u);
      if (move.lift) lift += move.lift(u) * weight;
      // The bones a move takes over, posed in full from rest: a wave is a wave, and a dance a dance, whatever the
      // arms were doing at a desk or holding something.
      const takes = move.owns ?? [];
      for (const bone of POSE_BONES) {
        const o = pose[bone];
        if (!o) continue;
        if (takes.includes(bone)) {
          const full = gestured[bone]?.[0] ?? [...REST[bone]];
          for (let i = 0; i < 3; i++) full[i] += o[i];
          gestured[bone] = [full, Math.max(gestured[bone]?.[1] ?? 0, weight)];
        } else {
          for (let i = 0; i < 3; i++) bones[bone][i] += o[i] * weight;
        }
      }
    }
    // What the arms do when no gesture has them: hold something, or fold. Over code each is an offset, as anything
    // else is, and a gesture blends over it; over the files each is posed in full, how far it has the arm its own.
    const under: Layers = {};
    const hold = this.held && this.holdWeight > 0.001 ? HOLDS[this.held] : undefined;
    if (hold) {
      const arm = this.held === "ear" && this.ear ? this.fromRest(this.ear) : hold.arm;
      for (const bone of HOLD_BONES) {
        const o = arm[bone];
        if (!o) continue;
        if (clips) under[bone] = [[REST[bone][0] + o[0], REST[bone][1] + o[1], REST[bone][2] + o[2]], this.holdWeight];
        else for (let i = 0; i < 3; i++) bones[bone][i] += o[i] * this.holdWeight;
      }
      for (let i = 0; i < 3; i++) bones.head[i] += hold.head[i] * this.holdWeight;
    }
    // Arms folded, while they have nothing else to do: no walking, sitting, typing or holding. A gesture takes them
    // from folded and gives them back.
    if (posture === "arms folded" && !clips?.folded) {
      const busy = Math.max(this.walking, this.holdWeight, ...ACTIVITY_NAMES.map((a) => this.doing[a]));
      const free = 1 - busy;
      if (free > 0.001) {
        for (const [bone, o] of Object.entries(FOLDED) as [PoseBone, Rotation][]) {
          if (clips)
            under[bone] = layer(
              [[REST[bone][0] + o[0], REST[bone][1] + o[1], REST[bone][2] + o[2]], free],
              under[bone],
            );
          else for (let i = 0; i < 3; i++) bones[bone][i] += o[i] * free;
        }
      }
    }
    if (this.sleep > 0.001) {
      for (const [bone, o] of Object.entries(ASLEEP) as [PoseBone, Rotation][])
        for (let i = 0; i < 3; i++) bones[bone][i] += o[i] * this.sleep;
    }
    // The upper arms swing out for a wide body whatever has them; a gesture's arm is turned as made (see `asMade`).
    for (const layers of [gestured, under]) {
      if (layers.leftUpperArm) layers.leftUpperArm[0][2] += this.armClearance;
      if (layers.rightUpperArm) layers.rightUpperArm[0][2] -= this.armClearance;
    }
    if (this.armDroop)
      for (const [bone, l] of Object.entries(gestured) as [PoseBone, [Rotation, number]][])
        if (/Arm$/.test(bone)) l[0] = asMade(l[0], bone, this.armDroop);
    if (this.gazeAt) {
      const weight = envelope(t - this.gazeAt.at, LOOK_SECONDS);
      bones.head[1] += this.gazeAt.yaw * weight;
      bones.head[0] -= this.gazeAt.pitch * weight;
      if (t - this.gazeAt.at > LOOK_SECONDS) this.gazeAt = undefined;
    }

    // Without files, a gesture's bones are blended to here, from whatever code had them doing, holding or folded
    // included, as far as the gesture has them.
    if (!clips)
      for (const [bone, [r, w]] of Object.entries(gestured) as [PoseBone, [Rotation, number]][])
        for (let i = 0; i < 3; i++) bones[bone][i] += (r[i] - bones[bone][i]) * w;
    // With files, each bone taken over is posed as what has it: a gesture over a hold or folded arms, as far as each.
    const owned: Partial<Record<PoseBone, Rotation>> = {};
    const weights: Partial<Record<PoseBone, number>> = {};
    let ownWeight = 0;
    if (clips)
      for (const bone of POSE_BONES) {
        const l = layer(under[bone], gestured[bone]);
        if (!l || l[1] <= 0) continue;
        owned[bone] = l[0];
        weights[bone] = l[1];
        ownWeight = Math.max(ownWeight, l[1]);
      }

    const gaze: [number, number] = [0, 0];
    for (const st of STATES) {
      gaze[0] += MOMENTS[st].gaze[0] * this.weights[st];
      gaze[1] += MOMENTS[st].gaze[1] * this.weights[st];
    }

    return {
      bones,
      expressions: { blink: Math.max(this.blink(t), this.sleep), aa: clamp01(this.mouth * 1.1) },
      gaze,
      seated: this.doing.sit,
      lift,
      ...(clips && ownWeight > 0 ? { owned: { bones: owned, weights, weight: ownWeight } } : {}),
    };
  }

  /**
   * An arm turned in full, as offsets from rest: what a hold adds, given that
   * the upper arm's outward swing for a wide body (`armClearance`) is taken
   * off it after, held or not.
   */
  private fromRest(turn: { upper: Rotation; lower: Rotation }): Offsets {
    const off = (to: Rotation, rest: Rotation): Rotation => [to[0] - rest[0], to[1] - rest[1], to[2] - rest[2]];
    const upper = off(turn.upper, REST.rightUpperArm);
    upper[2] += this.armClearance;
    return { rightUpperArm: upper, rightLowerArm: off(turn.lower, REST.rightLowerArm) };
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

/** Bones posed in full, each with how far its pose has it (0–1). */
type Layers = Partial<Record<PoseBone, [Rotation, number]>>;

/**
 * A pose over another, as far as the top one has the bone: what is left of
 * the one under shows through, and the two together have the bone as far as
 * either does. Either may be missing.
 */
export function layer(
  under: [Rotation, number] | undefined,
  over: [Rotation, number] | undefined,
): [Rotation, number] | undefined {
  if (!over || over[1] <= 0) return under;
  if (!under || under[1] <= 0) return over;
  const [u, uw] = under;
  const [o, ow] = over;
  const w = 1 - (1 - uw) * (1 - ow);
  const k = ow / w;
  return [[u[0] + (o[0] - u[0]) * k, u[1] + (o[1] - u[1]) * k, u[2] + (o[2] - u[2]) * k], w];
}

const qPose = new THREE.Quaternion();
const qRaise = new THREE.Quaternion();
const qBack = new THREE.Quaternion();
const eTurn = new THREE.Euler();
const Z = new THREE.Vector3(0, 0, 1);

/**
 * An arm's turn written for a model made in a T-pose, for one whose arms
 * hang `droop` radians below level as made. The upper arm is first raised to
 * level, then turned as written; the forearm turns as written in the frame
 * the raise left it in, so it bends the way it would on a T-pose, not about
 * an axis tipped down with the arm.
 */
export function asMade(turn: Rotation, bone: PoseBone, droop: number): Rotation {
  // The left arm is raised turning about +z, the right about -z.
  qRaise.setFromAxisAngle(Z, bone.startsWith("left") ? droop : -droop);
  qPose.setFromEuler(eTurn.set(turn[0], turn[1], turn[2]));
  if (bone.endsWith("UpperArm")) qPose.multiply(qRaise);
  else qPose.premultiply(qBack.copy(qRaise).invert()).multiply(qRaise);
  eTurn.setFromQuaternion(qPose);
  return [eTurn.x, eTurn.y, eTurn.z];
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
