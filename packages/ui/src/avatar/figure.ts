/**
 * One body in the room: a VRM model, how it walks, its pose every frame, and
 * the animation files it plays. The stage holds one for the agent it shows
 * and one for each other agent in the same room, so they all move the same
 * way: round the furniture, onto seats, with the same gestures.
 */
import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { makesOwnGesture, type Tint } from "./body";
import { type ClipLibrary, type ClipRole, GESTURE_ROLES, loadClipLibrary, rolesFor } from "./clips";
import type { Hold } from "./doing";
import { buildPiece, wearColors } from "./dress";
import { type Arm, type ArmTurn, armClearance, bodyPoints, droopOf, earAt, measureWear, reach, wearBone } from "./fit";
import { Director, findPath, type Obstacle, type Pick, route, slide, turnBetween, Walker } from "./locomotion";
import { type BodyState, type Carriage, Motion, POSE_BONES, type Pose } from "./motion";
import { BUBBLE_PX, GAP_PX, type Over, SETTLE_SECONDS, SIGN_PX, type Stacked, TAG_PX, TAIL_WIDTH_PX } from "./overhead";
import { buildHeld, disposeHeld } from "./props";
import { type Activity, type Room, type Spot, spotById } from "./scene";
import { bubbleTail, disposeSprite, fitSprite, liftSprite, SignPost, speechBubble, tag } from "./signs";
import { tintModel } from "./tint";
import { ease, gait } from "./travel";
import { Turns } from "./turns";
import { type BodyFit, type V3, wearPieces, wearTop } from "./wear";

const rad = (degrees: number) => (degrees * Math.PI) / 180;
/** Seconds its pace takes to catch up with how fast it is really going: long enough to smooth a frame's hitch. */
const PACE_SECONDS = 0.12;

/** A VRM model, loaded and made ready to pose: facing +Z like a VRM 1.0 model, casting shadows. */
export async function loadModel(url: string): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) throw new Error("the file is not a VRM model");
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  VRMUtils.combineSkeletons(vrm.scene);
  // VRM 0.x models face the other way; this turns them to face +Z like 1.0 ones.
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return vrm;
}

/**
 * Where a held thing sits from the hand, in metres for a grown-up (scaled to
 * the body), and how it is turned, in the body's own frame: +Z ahead, +X to
 * its left.
 */
const GRIPS: Record<Hold, { at: [number, number, number]; turn: [number, number, number] }> = {
  // Up to the eyes, lens ahead, the hand on its right end.
  up: { at: [0.05, 0.01, 0.04], turn: [0, 0, 0] },
  // At the ear, screen to the head and tipped toward the mouth, held by its lower half; its back turned out to the
  // front, so it is seen from across the room as well as up close.
  ear: { at: [0.02, 0.07, 0.04], turn: [-1.755, -0.227, -0.692] },
  // In front of the chest, tilted up toward the eyes.
  chest: { at: [0.07, 0.03, 0.03], turn: [-0.4, 0, 0] },
  // Out ahead, the far end tipped down to look through.
  out: { at: [0, 0.01, 0.02], turn: [0.5, 0, 0] },
};
/** How far out from the side of the head a hand holding a phone there is, for a grown-up: the phone between them. */
const EAR_GAP = 0.035;
/** How much of the head's height a phone held to the ear spans, at least. */
const EAR_SPAN = 0.5;
/** Which way from the shoulder the elbow of an arm holding a phone to the ear points: out, down, a little forward. */
const EAR_ELBOW: V3 = [-1, -1, 0.35];

/**
 * The right arm as the model was made, measured in `frame` (the figure's
 * own) while the body stands as made. None for a model without the bones.
 */
function armAsMade(vrm: VRM, frame: THREE.Object3D): Arm | undefined {
  frame.updateMatrixWorld(true);
  const at = (bone: VRMHumanBoneName): V3 | undefined => {
    const node = vrm.humanoid.getNormalizedBoneNode(bone);
    return node ? (frame.worldToLocal(node.getWorldPosition(new THREE.Vector3())).toArray() as V3) : undefined;
  };
  const shoulder = at("rightUpperArm");
  const elbow = at("rightLowerArm");
  const hand = at("rightHand");
  return shoulder && elbow && hand ? { shoulder, elbow, hand } : undefined;
}

/**
 * The arm holding a phone to this body's ear, as the arm was made: the hand
 * brought as near the side of its head as it reaches (`reach`).
 */
function earTurn(arm: Arm, fit: BodyFit, gap: number): ArmTurn {
  // The elbow down and out to the side, a little forward; the palm to the head, which is to its left (+x), with the
  // phone between them.
  const { upper, lower } = reach(arm, earAt(fit, gap), { elbow: EAR_ELBOW, palm: [1, 0, 0] });
  return { upper, lower };
}

/** A microphone held up points at the mouth, not ahead. */
const MIC_UP: [number, number, number] = [-1.2, 0, 0];

/** What a figure is doing this frame: the turn's moment and the voice's loudness, for the one that speaks. */
export interface FigureInput {
  state: BodyState;
  loudness: number;
}

export class Figure {
  /** A group around the model, so placing and turning it leaves the model's own VRM 0.x turn alone. */
  readonly body = new THREE.Group();
  /** Poses are written in the VRM 1.0 frame; a 0.x model's normalized bones have X and Z the other way round. */
  readonly flip: number;
  readonly bounds: THREE.Box3;
  readonly hipsY: number;
  /** The middle of the head and torso, above the feet: what a close-up frames. */
  readonly torso: number;
  readonly walker: Walker;
  /** Room it needs to pass between things: half its width, near enough. */
  readonly radius: number;
  readonly director: Director;
  readonly motion: Motion;
  /** Where its eyes look. */
  readonly gaze = new THREE.Object3D();
  /** The spot it is at, or walking to. */
  current: string | undefined;
  /** Where that spot was when it set off, so a moved couch takes it along. */
  currentAt: [number, number] | undefined;
  /** A walk asked for while seated: it stands up first. */
  pending: string | undefined;
  /** A point on the floor it was sent to while seated: it stands up first, then goes. */
  private headed: [number, number] | undefined;
  /** Until when a gesture asked for is kept going, on the stage's clock: none once over, or for one made once. */
  private keptUntil: number | undefined;
  seated = 0;
  clips: ClipPlayer | undefined;
  /** The animation files have loaded, or failed to. */
  clipsSettled: boolean;
  private readonly stride: number;
  private readonly hipsNode: THREE.Object3D | null;
  private lastWalkAt = Number.NEGATIVE_INFINITY;
  private disposed = false;
  private readonly hand: THREE.Object3D | null;
  /** How big it is beside a grown-up, for what it holds. */
  private readonly size: number;
  private held: { kind: string; how: Hold; thing: THREE.Group } | undefined;
  private dozing = false;
  /** How far it was steered since the last frame, which drives its stride like a walk. */
  private steered = 0;
  /** How fast it is going, in metres a second, smoothed over a few frames: which walk plays, and how fast. */
  private pace = 0;
  /** Its walking speed was set for it, and is kept when a walk clip loads. */
  private readonly paceSet: boolean;
  /** Its own walking speed, before how it chose to walk speeds it up or slows it down. */
  private basePace: number;
  /** How it carries itself: its posture, idle style and walk (see `body.ts`). */
  private carriage: Carriage = {};
  /** How big it was made, against its model as made. */
  readonly scale: number;
  /** What it says, in turn: the line in its bubble, from when to when on the stage's clock, and those said after. */
  private readonly turns = new Turns<{ text: string; who?: string; how: { phone?: boolean; far?: boolean } }>();
  /** The line in its bubble, drawn: the bubble and its tail. */
  private line: { bubble: THREE.Sprite; tail: THREE.Sprite; from: number } | undefined;
  private shownTag: { sprite: THREE.Sprite | undefined; key: string } = { sprite: undefined, key: "" };
  /** The sign over its head. */
  readonly signs = new SignPost();
  /** The top of its head, standing: its tag, its sign and its bubble stand on it, lifted on the screen. */
  private readonly crownPoint = new THREE.Group();
  /** How far up the screen each of those stands now, in pixels, easing toward where the stage last stacked them. */
  private lifted: Stacked | undefined;
  /** Metres a screen pixel covers at its head, as of the last layout. */
  private perPixel = 0.005;
  /** The body measured for what it wears, standing as made; none for a model with no head to measure. */
  private readonly measured: ReturnType<typeof measureWear>;
  /** What it wears, by name, and what holds it: a group on each bone it is fixed to. */
  private worn: { key: string; groups: THREE.Group[] } = { key: "", groups: [] };
  /** Its colours for what it wears. */
  private readonly colors: ReturnType<typeof wearColors>;

  constructor(
    readonly vrm: VRM,
    room: Room,
    start: Spot | undefined,
    opts: {
      reducedMotion?: boolean;
      animations?: string[];
      /** Its agent chooses what it does when quiet, instead of wandering at random. */
      agentChooses?: boolean;
      /** Radians, instead of the spot's own facing: a selfie turned to the camera. */
      facing?: number;
      /** The animation files took over. */
      onClips?: () => void;
      /** How its colours are turned from the model's own, so it can be told from others in the same model. */
      tint?: Tint;
      /** How big it is, against its model as made: 1 as made. */
      size?: number;
      /** How it carries itself: its posture, idle style and walk. */
      carriage?: Carriage;
      /**
       * Metres a second it walks, instead of the pace its size or its walk
       * clip suggests: a visitor walks briskly whatever body they have, and
       * the clip plays faster to keep up.
       */
      pace?: number;
      /** Radians a second it turns, instead of an agent's unhurried turn. */
      turn?: number;
      /** What it wears, by name (see `wear.ts`). */
      wear?: string[];
      /** What it goes to next while it wanders, instead of a spot at random: something to do (see `idle.ts`). */
      pick?: (here: string, taken?: ReadonlySet<string>) => Pick | undefined;
      /**
       * It runs sometimes (you, holding Shift), so its run clip is made ready.
       * Agents never run: making theirs would retarget a clip per body that
       * never plays.
       */
      runs?: boolean;
    } = {},
  ) {
    this.flip = vrm.meta.metaVersion === "0" ? -1 : 1;
    if (opts.tint) tintModel(vrm.scene, opts.tint);
    // Made bigger or smaller before it is measured: its speed, stride, seat and what it wears all follow.
    this.scale = opts.size && opts.size > 0 ? opts.size : 1;
    vrm.scene.scale.setScalar(this.scale);
    this.body.add(vrm.scene);
    if (start) {
      this.body.position.set(start.at[0], 0, start.at[1]);
      this.body.rotation.y = opts.facing ?? rad(start.facing);
    }
    // Its own proportions, measured standing: speed, stride and the close-up all follow them.
    this.body.updateMatrixWorld(true);
    this.bounds = new THREE.Box3().setFromObject(this.body);
    // Measured for what it wears while it still stands as made: the poses below move it.
    this.measured = measureWear(vrm, this.body);
    this.colors = wearColors(opts.tint);
    this.hipsY =
      vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(new THREE.Vector3()).y ??
      this.bounds.min.y + (this.bounds.max.y - this.bounds.min.y) / 2;
    this.torso = (this.bounds.max.y + this.hipsY) / 2;
    // A small robot pads along; a tall figure strides.
    this.basePace = opts.pace ?? Math.max(0.3, this.hipsY * 1.35);
    this.walker = new Walker(
      { x: this.body.position.x, z: this.body.position.z, facing: this.body.rotation.y },
      this.basePace,
    );
    this.paceSet = opts.pace !== undefined;
    if (opts.turn) this.walker.turnSpeed = opts.turn;
    this.stride = Math.max(0.15, this.hipsY * 1.1);
    this.radius = Math.min(0.3, Math.max(0.16, ((this.bounds.max.x - this.bounds.min.x) / 2) * 0.8));
    this.director = new Director(room, Math.random, !!opts.agentChooses, opts.pick);
    this.current = start?.id;
    this.currentAt = start?.at;
    this.motion = new Motion(opts);
    if (opts.carriage) this.carry(opts.carriage);
    // A little larger than life, so what it holds reads from across the room.
    this.size = 1.3 * Math.min(1.25, Math.max(0.6, (this.bounds.max.y - this.bounds.min.y) / 1.6));
    // A phone to its own ear: the hand to the side of its own head, however big the head and short the arms; and how
    // far its arms hang as made, for raising an arm in a gesture. Measured standing as made, before anything poses it.
    const arm = armAsMade(vrm, this.body);
    if (arm && this.measured) this.motion.ear = earTurn(arm, this.measured.fit, EAR_GAP * this.size);
    if (arm) this.motion.armDroop = droopOf(arm);
    // Swing the arms out just far enough that the hands clear this body.
    const points = bodyPoints(vrm);
    const probe = new Motion({ reducedMotion: true });
    this.motion.armClearance = armClearance(vrm, points, (extra) => {
      vrm.humanoid.resetNormalizedPose();
      probe.armClearance = extra;
      apply(vrm, probe.step(0, "idle", 0), this.flip);
      vrm.update(0);
    });
    this.hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
    this.hand = vrm.humanoid.getNormalizedBoneNode("rightHand");
    this.crownPoint.position.y = this.bounds.max.y;
    this.crownPoint.add(this.signs.group);
    this.body.add(this.crownPoint);
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;
    this.dress(opts.wear);
    // Animation files take over the base pose once they load; until then, and if they can't, code moves it.
    this.clipsSettled = !opts.animations?.length;
    if (opts.animations?.length) {
      loadClipLibrary(opts.animations, vrm)
        .then((library) => {
          if (this.disposed) return;
          const player = clipPlayer(library, vrm, !!opts.runs, this.scale);
          if (!player) return;
          this.motion.armClearance = armClearance(vrm, points, (extra) => player.sample("idle", extra, this.flip));
          if (player.walkSpeed && !this.paceSet) {
            this.basePace = player.walkSpeed;
            this.carry(this.carriage);
          }
          this.clips = player;
          opts.onClips?.();
        })
        .catch(() => {})
        .finally(() => {
          this.clipsSettled = true;
        });
    }
  }

  /** The spot it is standing at, while it isn't walking anywhere. */
  get here(): string | undefined {
    return this.moving ? undefined : this.current;
  }

  /** Walking, turning, or getting up to go somewhere. */
  get moving(): boolean {
    return this.walker.busy || !!this.pending || !!this.headed;
  }

  /** On its way somewhere, or getting up to go: turning where it stands is not walking. */
  get walking(): boolean {
    return this.walker.way.length > 0 || !!this.pending || !!this.headed;
  }

  /** Walk to a spot, round the furniture; seated, it stands first. False when there is no such spot. */
  go(room: Room, id: string, obstacles: Obstacle[]): boolean {
    const to = spotById(room, id);
    if (!to) return false;
    this.director.sent();
    this.headed = undefined;
    if (this.seated > 0.05) {
      this.pending = id;
      return true;
    }
    this.pending = undefined;
    // With nothing in the room, the old way through the middle.
    const way = obstacles.length
      ? findPath(room, [this.walker.place.x, this.walker.place.z], to.at, obstacles, this.radius)
      : route(room, this.walker.busy ? undefined : this.current, id);
    this.walker.go(way, rad(to.facing));
    this.current = id;
    this.currentAt = to.at;
    return true;
  }

  /**
   * Walk under someone's control: `dx`, `dz` metres this frame, sliding round
   * furniture and kept on the floor, turned the way it is going. Any walk to
   * a spot is dropped, and a seat is left first.
   */
  steer(dx: number, dz: number, room: Room, obstacles: Obstacle[]) {
    if (!dx && !dz) return;
    this.pending = undefined;
    this.headed = undefined;
    this.current = undefined;
    const p = this.walker.place;
    const [x, z] = slide(room, [p.x, p.z], [dx, dz], obstacles, this.radius);
    const moved = Math.hypot(x - p.x, z - p.z);
    p.x = x;
    p.z = z;
    // Turn at walking pace toward where it is heading, with nothing left to walk.
    this.walker.go([], Math.atan2(dx, dz));
    this.steered += moved;
  }

  /** Stand somewhere at once, facing `facing` radians, at no spot: coming in through a door. */
  placeAt(at: [number, number], facing: number) {
    this.pending = undefined;
    this.headed = undefined;
    this.current = undefined;
    this.currentAt = undefined;
    this.walker.jump(at, facing);
    this.body.position.set(at[0], 0, at[1]);
    this.body.rotation.y = facing;
  }

  /** Walk to a point on the floor, round the furniture, and face the way it walked; seated, it stands first. */
  goTo(room: Room, to: [number, number], obstacles: Obstacle[]) {
    this.director.sent();
    this.pending = undefined;
    if (this.seated > 0.05) {
      // Still on its seat until it has stood: the seat holds it while it gets up.
      this.headed = to;
      return;
    }
    this.headed = undefined;
    this.current = undefined;
    const from: [number, number] = [this.walker.place.x, this.walker.place.z];
    const way = findPath(room, from, to, obstacles, this.radius);
    const last = way.at(-2) ?? from;
    const end = way.at(-1) ?? to;
    this.walker.go(way, Math.atan2(end[0] - last[0], end[1] - last[1]));
  }

  /**
   * Find a new way to where it was walking, round whatever is in the way now
   * (someone stepped into its path), and walk on, turning at the end as it
   * meant to. Nothing happens while it isn't walking anywhere.
   */
  reroute(room: Room, obstacles: Obstacle[]) {
    const end = this.walker.way.at(-1);
    if (!end || this.pending || this.headed) return;
    this.walker.reroute(
      findPath(room, [this.walker.place.x, this.walker.place.z], [end[0], end[1]], obstacles, this.radius),
    );
  }

  /** Where its eyes are, near enough: what others look at. */
  head(): THREE.Vector3 {
    return new THREE.Vector3(this.body.position.x, this.body.position.y + this.torso, this.body.position.z);
  }

  /** Look, or point, at a point: the head turns, and the whole body first when it is too far round, or to point. */
  aim(at: THREE.Vector3, point: boolean, clock: number) {
    const from = this.head();
    const yaw = turnBetween(this.walker.place.facing, Math.atan2(at.x - from.x, at.z - from.z));
    const pitch = Math.atan2(at.y - from.y, Math.hypot(at.x - from.x, at.z - from.z));
    const free = this.seated < 0.05 && !this.walker.busy && !this.pending;
    if (free && (point || Math.abs(yaw) > 0.9)) {
      this.walker.go([], this.walker.place.facing + yaw);
      this.motion.look(0, pitch, clock);
    } else {
      this.motion.look(yaw, pitch, clock);
    }
    if (point) this.gesture("point", clock);
  }

  /**
   * Face someone it is talking to: the whole body turns to them where it
   * stands, the eyes meeting theirs; seated, on its way somewhere, or kept
   * where it faces (`stay`: at something it is doing), the head turns as far
   * as it can.
   */
  face(at: THREE.Vector3, clock: number, stay = false) {
    const from = this.head();
    const yaw = turnBetween(this.walker.place.facing, Math.atan2(at.x - from.x, at.z - from.z));
    const pitch = Math.atan2(at.y - from.y, Math.hypot(at.x - from.x, at.z - from.z));
    if (!stay && this.seated < 0.05 && !this.walker.busy && !this.pending) {
      if (Math.abs(yaw) > 0.05) this.walker.go([], this.walker.place.facing + yaw);
      this.motion.look(0, pitch, clock);
    } else {
      this.motion.look(yaw, pitch, clock);
    }
  }

  /**
   * Say something: a bubble over its head from `from` (the stage's clock)
   * for long enough to read, in turn with whatever else it says: what it was
   * saying stays up until this is due, and this waits for anything said
   * before it (`turns.ts`). `who` names the speaker in the bubble, for a body
   * that wears a tag: the tag is put away while it speaks. Said down the
   * phone, the bubble shows a phone; the far side of a call, heard out of
   * this body's phone, is edged apart.
   */
  say(text: string, from: number, who?: string, how: { phone?: boolean; far?: boolean } = {}) {
    if (this.turns.add({ text, who, how }, from, Math.min(12, 3 + 0.06 * text.length))) this.utter();
  }

  /** Draw the line whose turn it is in the bubble, in place of the one there. */
  private utter() {
    this.hush();
    const now = this.turns.now;
    if (!now) return;
    const bubble = speechBubble(now.what.text, now.what.who, now.what.how);
    const tail = bubbleTail();
    bubble.visible = false;
    tail.visible = false;
    this.crownPoint.add(bubble, tail);
    this.line = { bubble, tail, from: now.from };
    // A new bubble appears where it goes, rather than gliding there from where the last one was.
    if (this.lifted) this.lifted = { ...this.lifted, bubble: Number.NaN, across: Number.NaN };
  }

  /** Whether it is saying something right now: its mouth moves while it is. */
  speaking(clock: number): boolean {
    return !!this.line && this.turns.speaking(clock);
  }

  private hush() {
    if (this.line) {
      disposeSprite(this.line.bubble);
      disposeSprite(this.line.tail);
    }
    this.line = undefined;
  }

  /**
   * Wear these things, by name, and nothing else: each fixed to the bone it
   * goes with, so it moves with the body whatever pose it is in. What floats
   * over the head stands over a hat.
   */
  dress(wear: string[] = []) {
    const key = wear.join(",");
    if (key === this.worn.key) return;
    this.undress();
    this.worn.key = key;
    const measured = this.measured;
    const pieces = measured ? wear.flatMap((w) => wearPieces(w, measured.fit)) : [];
    for (const bone of ["head", "chest", "hips"] as const) {
      const mine = pieces.filter((p) => p.bone === bone);
      const node = wearBone(this.vrm, bone);
      if (!mine.length || !node || !measured) continue;
      // Laid out in the body's frame as made: the group undoes where the bone stood then, so on the bone it all
      // starts where it was laid out, and from then on goes where the bone goes.
      const group = new THREE.Group();
      group.name = `wear:${bone}`;
      measured.rest[bone].clone().invert().decompose(group.position, group.quaternion, group.scale);
      for (const p of mine) group.add(buildPiece(p, this.colors));
      node.add(group);
      this.worn.groups.push(group);
    }
    const hat = wearTop(pieces);
    this.crownPoint.position.y = Math.max(this.bounds.max.y, hat + 0.02);
  }

  /** Take off whatever it wears. The shapes and colours are shared by every body, so nothing is let go. */
  private undress() {
    for (const group of this.worn.groups) group.removeFromParent();
    this.worn = { key: "", groups: [] };
  }

  /** Nod off, or wake up. */
  doze(asleep: boolean) {
    this.dozing = asleep;
    this.motion.doze(asleep);
  }

  /** Hold something, or nothing: the arm comes up and the thing is in its hand. */
  hold(kind: string | undefined, how: Hold | undefined) {
    const want = kind && how ? `${kind}:${how}` : "";
    const have = this.held ? `${this.held.kind}:${this.held.how}` : "";
    if (want === have) return;
    if (this.held) {
      this.held.thing.removeFromParent();
      disposeHeld(this.held.thing);
      this.held = undefined;
    }
    this.motion.hold(kind && how ? how : undefined);
    if (!kind || !how) return;
    const thing = buildHeld(kind);
    thing.scale.setScalar(this.size);
    // At the ear, at least half as long as the head is tall: a big head hides a phone sized for the body.
    const head = this.measured?.fit.head;
    if (how === "ear" && head) {
      const made = new THREE.Box3().setFromObject(thing).getSize(new THREE.Vector3());
      const long = Math.max(made.x, made.y, made.z) / this.size;
      if (long > 0) thing.scale.setScalar(Math.max(this.size, (EAR_SPAN * (head.max[1] - head.min[1])) / long));
    }
    const turn = kind === "microphone" && how === "up" ? MIC_UP : GRIPS[how].turn;
    thing.rotation.set(...turn);
    thing.visible = false;
    this.body.add(thing);
    this.held = { kind, how, thing };
  }

  /**
   * The tag over its head: its name, what it is doing, both, or neither, and
   * a line or two more when you come close, with a phone before what it is
   * doing while it is on one. Redrawn only when the words change.
   */
  label(name: string | undefined, status: string | undefined, more: string[] = [], phone = false) {
    const key = `${name ?? ""}\n${status ?? ""}\n${more.join("\n")}\n${phone}`;
    if (key === this.shownTag.key) return;
    if (this.shownTag.sprite) disposeSprite(this.shownTag.sprite);
    const sprite = tag({ ...(name ? { name } : {}), ...(status ? { status } : {}), more, phone });
    if (sprite) {
      this.crownPoint.add(sprite);
      // Where the last tag stood, until the stage lays this one out.
      fitSprite(sprite, this.perPixel, TAG_PX);
      if (this.lifted) liftSprite(sprite, this.lifted.tag, this.perPixel);
    }
    this.shownTag = { sprite, key };
  }

  /** The top of its head in the room, standing or sat: where what floats over it stands. */
  crown(): THREE.Vector3 {
    return this.crownPoint.getWorldPosition(new THREE.Vector3());
  }

  /**
   * Size what floats over its head for the screen, `perPixel` metres a
   * screen pixel there: its tag, its sign and, while it is speaking at
   * `clock`, its bubble. Returns their sizes on the screen, in pixels, and
   * when it started saying what is in the bubble.
   */
  fitOver(perPixel: number, clock: number): Over {
    this.perPixel = perPixel;
    const out: Over = {};
    // Speaking, the bubble says who it is: the tag is put away until it's done.
    if (this.line && this.speaking(clock)) {
      out.bubble = fitSprite(this.line.bubble, perPixel, BUBBLE_PX);
      out.said = this.line.from;
      return out;
    }
    if (this.shownTag.sprite) out.tag = fitSprite(this.shownTag.sprite, perPixel, TAG_PX);
    const sign = this.signs.fit(perPixel, SIGN_PX);
    if (sign !== undefined) out.sign = sign;
    return out;
  }

  /**
   * Stand what floats over its head where the stage stacked it (`at`, in
   * screen pixels up from the top of the head), easing there over `dt`
   * seconds so a tag that has to make way glides rather than jumps. Its
   * bubble draws over earlier ones by `order`.
   */
  placeOver(at: Stacked, dt: number, order: number) {
    const was = this.lifted;
    const go = (from: number | undefined, to: number) =>
      from === undefined || Number.isNaN(from) ? to : ease(from, to, dt, SETTLE_SECONDS);
    this.lifted = {
      tag: go(was?.tag, at.tag),
      sign: go(was?.sign, at.sign),
      bubble: go(was?.bubble, at.bubble),
      across: go(was?.across, at.across),
    };
    if (this.shownTag.sprite) liftSprite(this.shownTag.sprite, this.lifted.tag, this.perPixel);
    this.signs.place(this.lifted.sign);
    if (this.line) {
      const { bubble, tail } = this.line;
      liftSprite(bubble, this.lifted.bubble, this.perPixel, this.lifted.across);
      bubble.renderOrder = order;
      // Its tail just under it and over everyone's tags, so it can be followed down past a neighbour's to its own
      // speaker; under the newer bubbles below it.
      tail.renderOrder = order - 0.5;
      // The tail from the bubble down to just over the head, straight over the speaker wherever the bubble went.
      const long = this.lifted.bubble - GAP_PX;
      tail.scale.set(TAIL_WIDTH_PX * this.perPixel, Math.max(1, long) * this.perPixel, 1);
      tail.center.set(0.5, -GAP_PX / Math.max(1, long));
      tail.userData.long = long;
    }
  }

  /**
   * A gesture: from the files when they have one (a nod, a dance, a wave), by
   * code otherwise. Once, or kept going for `seconds`; a new one ends any
   * kept going before it. One the body makes by itself (`auto`: a wave to
   * someone walking up, a stretch on getting somewhere) is left out while a
   * gesture asked for is kept going, which lasts as long as it was asked to.
   */
  gesture(name: string, clock: number, seconds?: number, how: { auto?: boolean } = {}) {
    if (how.auto && !makesOwnGesture(this.keptUntil, clock)) return;
    const until = seconds !== undefined && seconds > 0 ? clock + seconds : undefined;
    this.motion.stopGestures(clock);
    this.clips?.stop(clock);
    this.keptUntil = until;
    if (!this.clips?.shot(name as ClipRole, clock, until)) this.motion.gesture(name, clock, until);
  }

  /** Stop any gesture kept going: wanted for something else now. */
  stopGesture(clock: number) {
    this.keptUntil = undefined;
    this.motion.stopGestures(clock);
    this.clips?.stop(clock);
  }

  /**
   * How it carries itself from now: its posture and idle style, and how it
   * walks, which speeds it up or slows it down from its own pace. A visitor's
   * own body, whose pace was set for it, keeps that pace.
   */
  carry(carriage: Carriage) {
    this.carriage = carriage;
    this.motion.carry(carriage);
    if (!this.paceSet) this.walker.speed = this.basePace * (carriage.walk?.speed ?? 1);
  }

  /**
   * One frame: walk on, pose, settle onto a seat, and look at `eyesOn`.
   * `doing` replaces what the spot says to do there, for a photo.
   */
  step(
    room: Room,
    obstacles: Obstacle[],
    t: number,
    dt: number,
    input: FigureInput,
    eyesOn: THREE.Vector3,
    doing?: { activity: Activity | undefined },
  ): { walked: number } {
    if (this.pending && this.seated <= 0.05) this.go(room, this.pending, obstacles);
    if (this.headed && this.seated <= 0.05) this.goTo(room, this.headed, obstacles);
    const walked = (this.pending || this.headed ? 0 : this.walker.step(dt)) + this.steered;
    this.steered = 0;
    const here = this.here;
    const spot = this.current ? spotById(room, this.current) : undefined;
    // Asleep, it does nothing where it is but sit: no typing in its sleep.
    const there = here && !(this.dozing && spot?.activity !== "sit") ? spot?.activity : undefined;
    const activity = doing ? doing.activity : there;
    if (walked > 0) this.lastWalkAt = t;
    if (dt > 0) this.pace += (walked / dt - this.pace) * (1 - Math.exp(-dt / PACE_SECONDS));
    // A walk of its own kind from the files, when it walks that way and they have one; its arms folded by them too.
    const styled = this.carriage.walk?.clip;
    const styledWalk = !!styled && !!this.clips?.covers[styled];
    const folds = this.carriage.posture === "arms folded" && !!this.clips?.covers.folded && !this.held;
    const pose = this.motion.step(t, input.state, input.loudness, {
      walked,
      stride: this.stride,
      ...(activity ? { activity } : {}),
      ...(this.clips ? { clips: { ...this.clips.covers, styledWalk, folded: folds } } : {}),
    });
    this.seated = pose.seated;
    if (this.clips) {
      // The files play the base: walking, sitting, arms folded at the window,
      // talking, or idle. The code-driven moves go on top.
      const stride = gait(
        this.pace,
        this.walker.speed,
        { walk: this.clips.walkSpeed, run: this.clips.runSpeed },
        this.clips.covers.run,
      );
      const walking = t - this.lastWalkAt < 0.2;
      const styledRole = walking && styled && styledWalk && stride.role === "walk" ? styled : undefined;
      const role: ClipRole =
        styledRole ??
        (walking
          ? stride.role
          : activity === "sit"
            ? input.state === "speaking"
              ? "sitTalk"
              : "sit"
            : activity === "look"
              ? "foldArms"
              : input.state === "speaking"
                ? "talk"
                : folds && !activity
                  ? "foldArms"
                  : "idle");
      const madeFor = styledRole ? this.clips.speeds[styledRole] : undefined;
      const rate = styledRole
        ? madeFor
          ? Math.min(4, Math.max(0.25, this.pace / madeFor))
          : 1
        : role === stride.role
          ? stride.rate
          : role === "idle"
            ? (this.carriage.pace ?? 1)
            : 1;
      this.clips.update(role, t, dt, rate);
      overlay(this.vrm, pose, this.flip);
    } else {
      apply(this.vrm, pose, this.flip);
    }
    // Settling onto a seat moves the body back onto it and to its height.
    let { x, z } = this.walker.place;
    let y = pose.lift;
    if (spot?.seat && this.seated > 0) {
      x += (spot.seat.at[0] - x) * this.seated;
      z += (spot.seat.at[1] - z) * this.seated;
      // From where the hips are now: a sitting clip lowers them itself.
      y +=
        (spot.seat.height + 0.03 - (this.hipsNode ? this.hipsNode.position.y * this.scale : this.hipsY)) * this.seated;
    }
    this.body.position.set(x, y, z);
    this.body.rotation.y = this.walker.place.facing;
    this.signs.update(t);
    // A bubble while it speaks, with the tag and the sign put away until it's done.
    if (this.line) {
      const on = this.speaking(t);
      this.line.bubble.visible = on;
      // Brought down over its speaker's head, it has no room for a tail.
      this.line.tail.visible = on && (this.line.tail.userData.long ?? Number.POSITIVE_INFINITY) > 4;
      this.signs.group.visible = !on;
      if (this.shownTag.sprite) this.shownTag.sprite.visible = !on;
      // Its time up, the next thing said has its turn, if there is one.
      if (this.turns.tick(t)) {
        this.utter();
        if (!this.line) {
          this.signs.group.visible = true;
          if (this.shownTag.sprite) this.shownTag.sprite.visible = true;
        }
      }
    }
    const size = Math.max(0.05, this.bounds.max.y - this.hipsY) * 0.5;
    this.gaze.position.set(eyesOn.x + pose.gaze[0] * size, eyesOn.y + pose.gaze[1] * size, eyesOn.z);
    this.vrm.update(dt);
    this.placeHeld();
    return { walked };
  }

  /** Put what it holds in its hand, wherever the hand has got to this frame. */
  private placeHeld() {
    if (!this.held || !this.hand) return;
    const { thing, how } = this.held;
    this.body.updateMatrixWorld(true);
    const at = this.body.worldToLocal(this.hand.getWorldPosition(new THREE.Vector3()));
    const grip = GRIPS[how].at;
    thing.position.set(at.x + grip[0] * this.size, at.y + grip[1] * this.size, at.z + grip[2] * this.size);
    thing.visible = true;
  }

  dispose() {
    this.disposed = true;
    this.hold(undefined, undefined);
    this.label(undefined, undefined);
    this.hush();
    this.signs.dispose();
    this.clips?.dispose();
    // Off first: what it wears is shared with every other body, and the model's own is let go below.
    this.undress();
    this.body.removeFromParent();
    this.gaze.removeFromParent();
    VRMUtils.deepDispose(this.vrm.scene);
  }
}

/** Plays the animation files' base pose, crossfading between roles, with one-off clips over it. */
interface ClipPlayer {
  /**
   * What the files cover, so the code-driven motion leaves it alone: the
   * walk, the run, the activities, arms folded, and the walks of other kinds.
   */
  covers: {
    walk: boolean;
    run: boolean;
    activities: ("sit" | "look")[];
    folded: boolean;
    sneak: boolean;
    march: boolean;
  };
  /** The walking speed the walk clip was made for, in metres per second, so the feet don't slide. */
  walkSpeed?: number;
  /** The same for the run clip, when there is one. */
  runSpeed?: number;
  /** The same for the walks of other kinds. */
  speeds: Partial<Record<"sneak" | "march", number>>;
  /** Play a role as the base; a walk or a run at `rate` times its own speed, to keep pace with the ground. */
  update(role: ClipRole, t: number, dt: number, rate?: number): void;
  /** Play a gesture over the base, once or round and round until `until`: true when the files have one for it. */
  shot(role: ClipRole, t: number, until?: number): boolean;
  /** Bring a gesture kept going to an end now. */
  stop(t: number): void;
  /** Pose the model as a role looks partway through, arms swung out by `extra`, for fitting. */
  sample(role: ClipRole, extra: number, flip: number): void;
  dispose(): void;
}

const FADE = 0.35;

/** `size` is how big the body was made: the paces the clips were made for are its model's as made. */
function clipPlayer(library: ClipLibrary, vrm: VRM, runs: boolean, size = 1): ClipPlayer | undefined {
  const roles = rolesFor(library.names());
  // A body that never runs has no run to play, so its run clip is never made.
  if (!runs) delete roles.run;
  if (!roles.idle) return undefined;
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const clipFor = (role: ClipRole) => {
    const name = roles[role] ?? roles.idle;
    return name ? library.clip(name) : undefined;
  };
  const actionFor = (role: ClipRole, loop: boolean) => {
    const clip = clipFor(role);
    if (!clip) return undefined;
    const action = mixer.clipAction(clip);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    return action;
  };
  let base: THREE.AnimationAction | undefined;
  let baseRole: ClipRole | undefined;
  let oneOff: { action: THREE.AnimationAction; ends: number } | undefined;
  const fadeTo = (next: THREE.AnimationAction, from: THREE.AnimationAction | undefined, seconds: number) => {
    next.reset().play();
    if (from && from !== next) next.crossFadeFrom(from, seconds, false);
    else next.fadeIn(seconds);
  };
  const madeFor = (role: ClipRole) => {
    const speed = (clipFor(role)?.userData as { speed?: number } | undefined)?.speed;
    return speed ? speed * size : undefined;
  };
  const walkSpeed = madeFor("walk");
  const runSpeed = roles.run ? madeFor("run") : undefined;
  const speeds: ClipPlayer["speeds"] = {};
  for (const role of ["sneak", "march"] as const) {
    const speed = roles[role] ? madeFor(role) : undefined;
    if (speed && speed > 0.05) speeds[role] = speed;
  }
  return {
    covers: {
      walk: !!roles.walk,
      run: !!roles.run,
      activities: [...(roles.sit ? (["sit"] as const) : []), ...(roles.foldArms ? (["look"] as const) : [])],
      folded: !!roles.foldArms,
      sneak: !!roles.sneak,
      march: !!roles.march,
    },
    ...(walkSpeed && walkSpeed > 0.1 ? { walkSpeed } : {}),
    ...(runSpeed && runSpeed > 0.1 ? { runSpeed } : {}),
    speeds,
    update(role, t, dt, rate = 1) {
      if (oneOff && t >= oneOff.ends) {
        if (base) fadeTo(base, oneOff.action, FADE);
        oneOff = undefined;
      }
      if (role !== baseRole) {
        const next = actionFor(role, true);
        if (next && next !== base) {
          if (!oneOff) fadeTo(next, base, FADE);
          base = next;
        }
        baseRole = role;
      }
      if (base) base.timeScale = rate;
      // Bones the files don't move keep only what goes on top: clear them each frame.
      for (const bone of POSE_BONES) vrm.humanoid.getNormalizedBoneNode(bone)?.quaternion.identity();
      mixer.update(dt);
    },
    shot(role, t, until) {
      if (!roles[role] || !GESTURE_ROLES.includes(role)) return false;
      const going = until !== undefined && until > t;
      const action = actionFor(role, going);
      if (!action) return false;
      fadeTo(action, oneOff?.action ?? base, 0.2);
      oneOff = { action, ends: going ? until : t + action.getClip().duration - 0.3 };
      return true;
    },
    stop(t) {
      if (oneOff && oneOff.ends > t + 0.3) oneOff.ends = t + 0.3;
    },
    sample(role, extra, flip) {
      const clip = clipFor(role);
      vrm.humanoid.resetNormalizedPose();
      if (clip) {
        // Left as it is: stopping a mixer can put the bones back as they were.
        const probe = new THREE.AnimationMixer(vrm.scene);
        probe.clipAction(clip).play();
        probe.setTime(clip.duration / 2);
      }
      for (const [bone, sign] of [
        ["leftUpperArm", 1],
        ["rightUpperArm", -1],
      ] as const) {
        const node = vrm.humanoid.getNormalizedBoneNode(bone);
        node?.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, sign * extra * flip)));
      }
      vrm.update(0);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(vrm.scene);
    },
  };
}

/**
 * Code-driven offsets on top of what the files posed, each bone turned a
 * little further in its own frame. Then any bones an arm gesture has taken
 * over are blended toward the gesture's own pose.
 */
function overlay(vrm: VRM, pose: Pose, flip: number) {
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const bone of POSE_BONES) {
    const [x, y, z] = pose.bones[bone];
    if (!x && !y && !z) continue;
    vrm.humanoid.getNormalizedBoneNode(bone)?.quaternion.multiply(q.setFromEuler(e.set(x * flip, y, z * flip)));
  }
  if (pose.owned) {
    const { bones, weights, weight } = pose.owned;
    for (const [bone, r] of Object.entries(bones)) {
      if (!r) continue;
      const node = vrm.humanoid.getNormalizedBoneNode(bone as (typeof POSE_BONES)[number]);
      node?.quaternion.slerp(
        q.setFromEuler(e.set(r[0] * flip, r[1], r[2] * flip)),
        weights[bone as (typeof POSE_BONES)[number]] ?? weight,
      );
    }
    // An arm taken over is posed from its shoulder at rest, as the code poses it: a shoulder the files have dropped
    // or rolled, as an idle often does on one side, would send the same arm somewhere else.
    for (const side of ["left", "right"] as const) {
      if (!bones[`${side}UpperArm`]) continue;
      vrm.humanoid
        .getNormalizedBoneNode(`${side}Shoulder`)
        ?.quaternion.slerp(q.identity(), weights[`${side}UpperArm`] ?? weight);
    }
  }
  vrm.expressionManager?.setValue("blink", pose.expressions.blink);
  vrm.expressionManager?.setValue("aa", pose.expressions.aa);
}

function apply(vrm: VRM, pose: Pose, flip: number) {
  for (const bone of POSE_BONES) {
    const node = vrm.humanoid.getNormalizedBoneNode(bone);
    const [x, y, z] = pose.bones[bone];
    node?.rotation.set(x * flip, y, z * flip);
  }
  vrm.expressionManager?.setValue("blink", pose.expressions.blink);
  vrm.expressionManager?.setValue("aa", pose.expressions.aa);
}
