/**
 * One body in the room: a VRM model, how it walks, its pose every frame, and
 * the animation files it plays. The stage holds one for the agent it shows
 * and one for each other agent in the same room, so they all move the same
 * way: round the furniture, onto seats, with the same gestures.
 */
import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type ClipLibrary, type ClipRole, loadClipLibrary, rolesFor } from "./clips";
import { armClearance, bodyPoints } from "./fit";
import { Director, findPath, type Obstacle, route, turnBetween, Walker } from "./locomotion";
import { type BodyState, Motion, POSE_BONES, type Pose } from "./motion";
import { type Activity, type Room, type Spot, spotById } from "./scene";

const rad = (degrees: number) => (degrees * Math.PI) / 180;

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
  seated = 0;
  clips: ClipPlayer | undefined;
  /** The animation files have loaded, or failed to. */
  clipsSettled: boolean;
  private readonly stride: number;
  private readonly hipsNode: THREE.Object3D | null;
  private lastWalkAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

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
    } = {},
  ) {
    this.flip = vrm.meta.metaVersion === "0" ? -1 : 1;
    this.body.add(vrm.scene);
    if (start) {
      this.body.position.set(start.at[0], 0, start.at[1]);
      this.body.rotation.y = opts.facing ?? rad(start.facing);
    }
    // Its own proportions, measured standing: speed, stride and the close-up all follow them.
    this.body.updateMatrixWorld(true);
    this.bounds = new THREE.Box3().setFromObject(this.body);
    this.hipsY =
      vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(new THREE.Vector3()).y ??
      this.bounds.min.y + (this.bounds.max.y - this.bounds.min.y) / 2;
    this.torso = (this.bounds.max.y + this.hipsY) / 2;
    // A small robot pads along; a tall figure strides.
    this.walker = new Walker(
      { x: this.body.position.x, z: this.body.position.z, facing: this.body.rotation.y },
      Math.max(0.3, this.hipsY * 1.35),
    );
    this.stride = Math.max(0.15, this.hipsY * 1.1);
    this.radius = Math.min(0.3, Math.max(0.16, ((this.bounds.max.x - this.bounds.min.x) / 2) * 0.8));
    this.director = new Director(room, Math.random, !!opts.agentChooses);
    this.current = start?.id;
    this.currentAt = start?.at;
    this.motion = new Motion(opts);
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
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;
    // Animation files take over the base pose once they load; until then, and if they can't, code moves it.
    this.clipsSettled = !opts.animations?.length;
    if (opts.animations?.length) {
      loadClipLibrary(opts.animations, vrm)
        .then((library) => {
          if (this.disposed) return;
          const player = clipPlayer(library, vrm);
          if (!player) return;
          this.motion.armClearance = armClearance(vrm, points, (extra) => player.sample("idle", extra, this.flip));
          if (player.walkSpeed) this.walker.speed = player.walkSpeed;
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
    return this.walker.busy || this.pending ? undefined : this.current;
  }

  /** Walk to a spot, round the furniture; seated, it stands first. False when there is no such spot. */
  go(room: Room, id: string, obstacles: Obstacle[]): boolean {
    const to = spotById(room, id);
    if (!to) return false;
    this.director.sent();
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
    if (point) this.motion.gesture("point", clock);
  }

  /** A gesture: a nod or a head shake from the files when they have one, the rest by code. */
  gesture(name: string, clock: number) {
    if (!this.clips?.shot(name as ClipRole, clock)) this.motion.gesture(name, clock);
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
    const walked = this.pending ? 0 : this.walker.step(dt);
    const here = this.here;
    const spot = this.current ? spotById(room, this.current) : undefined;
    const activity = doing ? doing.activity : here ? spot?.activity : undefined;
    if (walked > 0) this.lastWalkAt = t;
    const pose = this.motion.step(t, input.state, input.loudness, {
      walked,
      stride: this.stride,
      ...(activity ? { activity } : {}),
      ...(this.clips ? { clips: this.clips.covers } : {}),
    });
    this.seated = pose.seated;
    if (this.clips) {
      // The files play the base: walking, sitting, arms folded at the window,
      // talking, or idle. The code-driven moves go on top.
      const role: ClipRole =
        t - this.lastWalkAt < 0.2
          ? "walk"
          : activity === "sit"
            ? input.state === "speaking"
              ? "sitTalk"
              : "sit"
            : activity === "look"
              ? "foldArms"
              : input.state === "speaking"
                ? "talk"
                : "idle";
      this.clips.update(role, t, dt);
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
      y += (spot.seat.height + 0.03 - (this.hipsNode?.position.y ?? this.hipsY)) * this.seated;
    }
    this.body.position.set(x, y, z);
    this.body.rotation.y = this.walker.place.facing;
    const size = Math.max(0.05, this.bounds.max.y - this.hipsY) * 0.5;
    this.gaze.position.set(eyesOn.x + pose.gaze[0] * size, eyesOn.y + pose.gaze[1] * size, eyesOn.z);
    this.vrm.update(dt);
    return { walked };
  }

  dispose() {
    this.disposed = true;
    this.clips?.dispose();
    this.body.removeFromParent();
    this.gaze.removeFromParent();
    VRMUtils.deepDispose(this.vrm.scene);
  }
}

/** Plays the animation files' base pose, crossfading between roles, with one-off clips over it. */
interface ClipPlayer {
  /** What the files cover, so the code-driven motion leaves it alone. */
  covers: { walk: boolean; activities: ("sit" | "look")[] };
  /** The walking speed the walk clip was made for, in metres per second, so the feet don't slide. */
  walkSpeed?: number;
  update(role: ClipRole, t: number, dt: number): void;
  /** Play a one-off over the base: true when the files have one for this role. */
  shot(role: ClipRole, t: number): boolean;
  /** Pose the model as a role looks partway through, arms swung out by `extra`, for fitting. */
  sample(role: ClipRole, extra: number, flip: number): void;
  dispose(): void;
}

const FADE = 0.35;

function clipPlayer(library: ClipLibrary, vrm: VRM): ClipPlayer | undefined {
  const roles = rolesFor(library.names());
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
  const walkSpeed = (clipFor("walk")?.userData as { speed?: number } | undefined)?.speed;
  return {
    covers: {
      walk: !!roles.walk,
      activities: [...(roles.sit ? (["sit"] as const) : []), ...(roles.foldArms ? (["look"] as const) : [])],
    },
    ...(walkSpeed && walkSpeed > 0.1 ? { walkSpeed } : {}),
    update(role, t, dt) {
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
      // Bones the files don't move keep only what goes on top: clear them each frame.
      for (const bone of POSE_BONES) vrm.humanoid.getNormalizedBoneNode(bone)?.quaternion.identity();
      mixer.update(dt);
    },
    shot(role, t) {
      if (!roles[role] || !["nod", "shake", "dance"].includes(role)) return false;
      const action = actionFor(role, false);
      if (!action) return false;
      fadeTo(action, oneOff?.action ?? base, 0.2);
      oneOff = { action, ends: t + action.getClip().duration - 0.3 };
      return true;
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
    for (const [bone, r] of Object.entries(pose.owned.bones)) {
      if (!r) continue;
      const node = vrm.humanoid.getNormalizedBoneNode(bone as (typeof POSE_BONES)[number]);
      node?.quaternion.slerp(q.setFromEuler(e.set(r[0] * flip, r[1], r[2] * flip)), pose.owned.weight);
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
