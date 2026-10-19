/**
 * Animation files for any VRM avatar. A library (glTF, any humanoid rig)
 * is loaded once; each clip is retargeted onto the avatar the first time it
 * is played and kept.
 *
 * Retargeting works in world space, so rigs with different bone names,
 * lengths and rest poses all land the same way. Each source clip is sampled
 * on its own skeleton. Every mapped bone's rotation away from the library's
 * T-pose becomes the same rotation away from the avatar's T-pose, corrected
 * where a limb points a different way at rest. Bones the avatar has and the
 * library lacks, or the other way round, simply carry their parent's motion.
 */
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type Map = Partial<Record<VRMHumanBoneName, string>>;

const sides = (left: Map, right: (name: string) => string): Map => {
  const out: Map = { ...left };
  for (const [bone, name] of Object.entries(left)) {
    if (bone.startsWith("left") && name) out[`right${bone.slice(4)}` as VRMHumanBoneName] = right(name);
  }
  return out;
};

/** How common rigs spell the humanoid bones. Names are compared without case or punctuation. */
const RIGS: Record<string, Map> = {
  rigify: sides(
    {
      hips: "DEF-hips",
      spine: "DEF-spine.001",
      chest: "DEF-spine.002",
      upperChest: "DEF-spine.003",
      neck: "DEF-neck",
      head: "DEF-head",
      leftShoulder: "DEF-shoulder.L",
      leftUpperArm: "DEF-upper_arm.L",
      leftLowerArm: "DEF-forearm.L",
      leftHand: "DEF-hand.L",
      leftUpperLeg: "DEF-thigh.L",
      leftLowerLeg: "DEF-shin.L",
      leftFoot: "DEF-foot.L",
      leftToes: "DEF-toe.L",
    },
    (n) => n.replace(/\.L$/, ".R"),
  ),
  unreal: sides(
    {
      hips: "pelvis",
      spine: "spine_01",
      chest: "spine_02",
      upperChest: "spine_03",
      neck: "neck_01",
      head: "head",
      leftShoulder: "clavicle_l",
      leftUpperArm: "upperarm_l",
      leftLowerArm: "lowerarm_l",
      leftHand: "hand_l",
      leftUpperLeg: "thigh_l",
      leftLowerLeg: "calf_l",
      leftFoot: "foot_l",
      leftToes: "ball_l",
    },
    (n) => n.replace(/_l$/, "_r"),
  ),
  mixamo: sides(
    {
      hips: "mixamorig:Hips",
      spine: "mixamorig:Spine",
      chest: "mixamorig:Spine1",
      upperChest: "mixamorig:Spine2",
      neck: "mixamorig:Neck",
      head: "mixamorig:Head",
      leftShoulder: "mixamorig:LeftShoulder",
      leftUpperArm: "mixamorig:LeftArm",
      leftLowerArm: "mixamorig:LeftForeArm",
      leftHand: "mixamorig:LeftHand",
      leftUpperLeg: "mixamorig:LeftUpLeg",
      leftLowerLeg: "mixamorig:LeftLeg",
      leftFoot: "mixamorig:LeftFoot",
      leftToes: "mixamorig:LeftToeBase",
    },
    (n) => n.replace("Left", "Right"),
  ),
};

/** Loaders strip punctuation from node names ("DEF-spine.001" arrives as "DEF-spine001"); compare without it. */
export const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The rig whose names match the most nodes in this skeleton, as bone → node. */
export function mapRig(nodeNames: string[]): { rig: string; bones: Map } | undefined {
  const present = new Set(nodeNames.map(plain));
  let best: { rig: string; bones: Map; hits: number } | undefined;
  for (const [rig, bones] of Object.entries(RIGS)) {
    const hits = Object.values(bones).filter((n) => n && present.has(plain(n))).length;
    if (hits >= 8 && (!best || hits > best.hits)) best = { rig, bones, hits };
  }
  return best && { rig: best.rig, bones: best.bones };
}

/** Bones whose rest direction is taken toward this child, to correct for limbs pointing differently. */
const CHILD: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>> = {
  hips: "spine",
  spine: "chest",
  chest: "neck",
  upperChest: "neck",
  neck: "head",
  leftShoulder: "leftUpperArm",
  leftUpperArm: "leftLowerArm",
  leftLowerArm: "leftHand",
  rightShoulder: "rightUpperArm",
  rightUpperArm: "rightLowerArm",
  rightLowerArm: "rightHand",
  leftUpperLeg: "leftLowerLeg",
  leftLowerLeg: "leftFoot",
  leftFoot: "leftToes",
  rightUpperLeg: "rightLowerLeg",
  rightLowerLeg: "rightFoot",
  rightFoot: "rightToes",
};

const FPS = 30;

export interface ClipLibrary {
  /** Every clip name, across the files. */
  names(): string[];
  /** A clip retargeted onto the avatar, made the first time it is asked for. */
  clip(name: string): THREE.AnimationClip | undefined;
}

interface Source {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  nodes: Partial<Record<VRMHumanBoneName, THREE.Object3D>>;
  /** Turns the source's world into the frame poses are written in: facing +Z, up +Y, left arm along +X. */
  frame: THREE.Quaternion;
  rest: Partial<Record<VRMHumanBoneName, { q: THREE.Quaternion; p: THREE.Vector3 }>>;
  hipsHeight: number;
}

export async function loadClipLibrary(urls: string[], vrm: VRM): Promise<ClipLibrary> {
  const loader = new GLTFLoader();
  const sources: Source[] = [];
  for (const url of urls) {
    const gltf = await loader.loadAsync(url);
    const names: string[] = [];
    gltf.scene.traverse((o) => names.push(o.name));
    const mapped = mapRig(names);
    if (!mapped) continue;
    const byName = new globalThis.Map<string, THREE.Object3D>();
    gltf.scene.traverse((o) => byName.set(plain(o.name), o));
    const nodes: Source["nodes"] = {};
    for (const [bone, name] of Object.entries(mapped.bones))
      if (name && byName.has(plain(name))) nodes[bone as VRMHumanBoneName] = byName.get(plain(name));
    // The library's T-pose is the rest every clip is measured from; without one, the bind pose.
    const tpose = gltf.animations.find((c) => /t[-_ ]?pose/i.test(c.name));
    const mixer = new THREE.AnimationMixer(gltf.scene);
    if (tpose) {
      mixer.clipAction(tpose).play();
      mixer.setTime(0);
    }
    gltf.scene.updateMatrixWorld(true);
    const world = (b: VRMHumanBoneName) => nodes[b]?.getWorldPosition(new THREE.Vector3());
    const hips = world("hips");
    const head = world("head");
    const armFrom = world("leftUpperArm");
    const armTo = world("leftLowerArm");
    if (!hips || !head || !armFrom || !armTo) continue;
    const up = head.clone().sub(hips).normalize();
    const left = armTo.clone().sub(armFrom);
    left.addScaledVector(up, -left.dot(up)).normalize();
    const forward = new THREE.Vector3().crossVectors(left, up).normalize();
    const basis = new THREE.Matrix4().makeBasis(left, up, forward);
    const frame = new THREE.Quaternion().setFromRotationMatrix(basis).invert();
    const rest: Source["rest"] = {};
    for (const [bone, node] of Object.entries(nodes)) {
      if (!node) continue;
      rest[bone as VRMHumanBoneName] = {
        q: frame.clone().multiply(node.getWorldQuaternion(new THREE.Quaternion())),
        p: node.getWorldPosition(new THREE.Vector3()).applyQuaternion(frame),
      };
    }
    mixer.stopAllAction();
    const ground = Math.min(
      world("leftFoot")?.applyQuaternion(frame).y ?? 0,
      world("rightFoot")?.applyQuaternion(frame).y ?? 0,
    );
    sources.push({
      scene: gltf.scene,
      clips: gltf.animations.filter((c) => c !== tpose),
      nodes,
      frame,
      rest,
      hipsHeight: Math.max(0.05, (rest.hips?.p.y ?? 1) - ground),
    });
  }

  const target = avatarRest(vrm);
  const made = new globalThis.Map<string, THREE.AnimationClip | undefined>();
  return {
    names: () => sources.flatMap((s) => s.clips.map((c) => c.name)),
    clip(name) {
      if (made.has(name)) return made.get(name);
      const source = sources.find((s) => s.clips.some((c) => c.name === name));
      const clip = source
        ? bake(source, source.clips.find((c) => c.name === name) as THREE.AnimationClip, vrm, target)
        : undefined;
      made.set(name, clip);
      return clip;
    },
  };
}

interface AvatarRest {
  bones: VRMHumanBoneName[];
  /** Rest directions toward each bone's child, in the facing-+Z frame. */
  dirs: Partial<Record<VRMHumanBoneName, THREE.Vector3>>;
  /** The nearest mapped ancestor of each bone in the avatar's skeleton. */
  parent: Partial<Record<VRMHumanBoneName, VRMHumanBoneName>>;
  hipsRest: THREE.Vector3;
  hipsHeight: number;
  /** VRM 0.x normalized bones face -Z: poses are mirrored in X and Z for them. */
  mirror: boolean;
}

function avatarRest(vrm: VRM): AvatarRest {
  const mirror = vrm.meta.metaVersion === "0";
  vrm.humanoid.resetNormalizedPose();
  vrm.scene.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(vrm.scene.matrixWorld).invert();
  const at = (b: VRMHumanBoneName) => {
    const node = vrm.humanoid.getNormalizedBoneNode(b);
    if (!node) return undefined;
    const p = node.getWorldPosition(new THREE.Vector3()).applyMatrix4(toModel);
    return mirror ? p.set(-p.x, p.y, -p.z) : p;
  };
  const bones = Object.keys(vrm.humanoid.humanBones).filter((b) =>
    vrm.humanoid.getNormalizedBoneNode(b as VRMHumanBoneName),
  ) as VRMHumanBoneName[];
  const dirs: AvatarRest["dirs"] = {};
  for (const b of bones) {
    const child = CHILD[b];
    const from = at(b);
    const to = child ? at(child) : undefined;
    if (from && to && to.distanceTo(from) > 1e-4) dirs[b] = to.sub(from).normalize();
  }
  const nodeToBone = new globalThis.Map<THREE.Object3D, VRMHumanBoneName>();
  for (const b of bones) {
    const node = vrm.humanoid.getNormalizedBoneNode(b);
    if (node) nodeToBone.set(node, b);
  }
  const parent: AvatarRest["parent"] = {};
  for (const b of bones) {
    for (let o = vrm.humanoid.getNormalizedBoneNode(b)?.parent; o; o = o.parent) {
      const p = nodeToBone.get(o);
      if (p) {
        parent[b] = p;
        break;
      }
    }
  }
  const hips = vrm.humanoid.getNormalizedBoneNode("hips");
  const feet = Math.min(at("leftFoot")?.y ?? 0, at("rightFoot")?.y ?? 0);
  return {
    bones,
    dirs,
    parent,
    hipsRest: hips?.position.clone() ?? new THREE.Vector3(),
    hipsHeight: Math.max(0.05, (at("hips")?.y ?? 1) - feet),
    mirror,
  };
}

/** Sample a source clip on its own skeleton and write it as tracks on the avatar's normalized bones. */
function bake(source: Source, clip: THREE.AnimationClip, vrm: VRM, target: AvatarRest): THREE.AnimationClip {
  const mixer = new THREE.AnimationMixer(source.scene);
  const action = mixer.clipAction(clip);
  action.play();
  const bones = target.bones.filter((b) => source.nodes[b] && source.rest[b]);
  // Per bone: the rotation that turns the avatar's rest direction into the source's.
  const correct: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  for (const b of bones) {
    const child = CHILD[b];
    const vdir = target.dirs[b];
    const srest = source.rest[b]?.p;
    const schild = child ? source.rest[child]?.p : undefined;
    correct[b] =
      vdir && srest && schild
        ? new THREE.Quaternion().setFromUnitVectors(vdir, schild.clone().sub(srest).normalize())
        : new THREE.Quaternion();
  }
  const frames = Math.max(2, Math.ceil(clip.duration * FPS) + 1);
  const times = new Float32Array(frames);
  const values: Partial<Record<VRMHumanBoneName, Float32Array>> = {};
  for (const b of bones) values[b] = new Float32Array(frames * 4);
  const hipsValues = new Float32Array(frames * 3);
  const scale = target.hipsHeight / source.hipsHeight;
  const world: Partial<Record<VRMHumanBoneName, THREE.Quaternion>> = {};
  const q = new THREE.Quaternion();
  // How far a foot travels front to back, for the pace a walk was made for.
  let footFront = Number.NEGATIVE_INFINITY;
  let footBack = Number.POSITIVE_INFINITY;
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / FPS);
    times[f] = t;
    mixer.setTime(t);
    source.scene.updateMatrixWorld(true);
    // World rotation each avatar bone should have: the source's delta from rest, corrected.
    for (const b of bones) {
      const node = source.nodes[b] as THREE.Object3D;
      const rest = source.rest[b]?.q as THREE.Quaternion;
      const now = source.frame.clone().multiply(node.getWorldQuaternion(q));
      world[b] = now.multiply(rest.clone().invert()).multiply(correct[b] as THREE.Quaternion);
    }
    for (const b of bones) {
      // Up the avatar's own hierarchy to the nearest bone that has a world rotation.
      let p = target.parent[b];
      while (p && !world[p]) p = target.parent[p];
      const local = (p ? (world[p] as THREE.Quaternion).clone().invert() : new THREE.Quaternion()).multiply(
        world[b] as THREE.Quaternion,
      );
      const out = values[b] as Float32Array;
      out.set(target.mirror ? [-local.x, local.y, -local.z, local.w] : [local.x, local.y, local.z, local.w], f * 4);
    }
    const hips = source.nodes.hips?.getWorldPosition(new THREE.Vector3()).applyQuaternion(source.frame);
    const foot = source.nodes.leftFoot?.getWorldPosition(new THREE.Vector3()).applyQuaternion(source.frame);
    if (foot && hips) {
      footFront = Math.max(footFront, foot.z - hips.z);
      footBack = Math.min(footBack, foot.z - hips.z);
    }
    const delta = hips && source.rest.hips ? hips.sub(source.rest.hips.p).multiplyScalar(scale) : new THREE.Vector3();
    if (target.mirror) delta.set(-delta.x, delta.y, -delta.z);
    hipsValues.set([target.hipsRest.x + delta.x, target.hipsRest.y + delta.y, target.hipsRest.z + delta.z], f * 3);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(source.scene);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const b of bones) {
    const node = vrm.humanoid.getNormalizedBoneNode(b);
    if (node)
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values[b] as Float32Array));
  }
  const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
  if (hipsNode) tracks.push(new THREE.VectorKeyframeTrack(`${hipsNode.name}.position`, times, hipsValues));
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  // A foot is on the ground for about 60% of a walk cycle, moving back at the body's speed.
  if (Number.isFinite(footFront) && clip.duration > 0)
    out.userData = { speed: ((footFront - footBack) * scale) / (0.6 * clip.duration) };
  return out;
}

/** What the stage plays for each moment, found by name in the library. */
export type ClipRole = "idle" | "talk" | "walk" | "sit" | "sitTalk" | "foldArms" | "nod" | "shake" | "dance";

const ROLE_PATTERNS: Record<ClipRole, RegExp[]> = {
  idle: [/^idle(_loop)?$/i, /^idle/i],
  talk: [/^idle_talking(_loop)?$/i, /talk(?!ingphone)/i],
  walk: [/^walk(_loop)?$/i, /^walk(?!.*(carry|zombie|formal))/i],
  sit: [/^sitting_idle/i, /sit.*idle/i],
  sitTalk: [/^sitting_talking/i],
  foldArms: [/fold.?arms/i],
  // Not "Yes": in the common libraries that is a thumbs-up, with the head still.
  nod: [/^nod/i, /head.?nod/i],
  shake: [/^idle_no/i, /^no$/i, /head.?shake/i],
  dance: [/^dance/i],
};

/** The clip that plays each role, by the usual names; a role with none falls back to the code-driven motion. */
export function rolesFor(names: string[]): Partial<Record<ClipRole, string>> {
  const out: Partial<Record<ClipRole, string>> = {};
  for (const [role, patterns] of Object.entries(ROLE_PATTERNS) as [ClipRole, RegExp[]][]) {
    for (const p of patterns) {
      const hit = names.find((n) => p.test(n) && !/_rm$/i.test(n));
      if (hit) {
        out[role] = hit;
        break;
      }
    }
  }
  return out;
}
