/**
 * Fitting poses to the model's own body. A pose written for one figure puts
 * another's hands through its hips when the second is stockier: arms at rest
 * on a slim mannequin are inside a chunky robot. This measures the body and
 * says how far out the arms must swing to clear it, and how to turn an arm to
 * bring the hand to a place on it: the side of its own head, for a phone.
 */
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { type BodyFit, type BodyPoints, type Bone, fitFrom, type V3 } from "./wear";

const ARM_BONES: VRMHumanBoneName[] = [
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
];

/** The body's points, without the arms, in the model's own space: what a hand must stay outside of. */
export function bodyPoints(vrm: VRM): THREE.Vector3[] {
  const arm = new Set<THREE.Object3D>();
  for (const b of ARM_BONES) {
    const node = vrm.humanoid.getRawBoneNode(b);
    node?.traverse((o) => arm.add(o));
  }
  vrm.scene.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(vrm.scene.matrixWorld).invert();
  const points: THREE.Vector3[] = [];
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getAttribute("skinIndex");
    const weight = mesh.geometry.getAttribute("skinWeight");
    if (!pos || !index || !weight) return;
    // Every few vertices is plenty for a silhouette, and keeps a dense model cheap.
    const step = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += step) {
      let top = 0;
      for (let k = 1; k < 4; k++) if (weight.getComponent(i, k) > weight.getComponent(i, top)) top = k;
      const bone = mesh.skeleton.bones[index.getComponent(i, top)];
      if (!bone || arm.has(bone)) continue;
      const p = mesh.getVertexPosition(i, new THREE.Vector3());
      points.push(mesh.localToWorld(p).applyMatrix4(toModel));
    }
  });
  return points;
}

/** How far the body reaches out to each side at a height: the half-width a hand must clear. */
function halfWidthAt(points: THREE.Vector3[], y: number, band: number): number {
  let w = 0;
  for (const p of points) if (Math.abs(p.y - y) < band) w = Math.max(w, Math.abs(p.x));
  return w;
}

/**
 * The extra outward swing (radians) the upper arms need for the hands and
 * forearms to clear the body, in whatever pose `pose(extra)` puts the model.
 * `pose` must set the normalized bones with the arms swung out by `extra`
 * and leave the model updated. Zero when the pose already clears.
 */
export function armClearance(vrm: VRM, points: THREE.Vector3[], pose: (extra: number) => void): number {
  if (!points.length) return 0;
  const toModel = new THREE.Matrix4();
  const at = (b: VRMHumanBoneName) => {
    const node = vrm.humanoid.getRawBoneNode(b);
    return node ? node.getWorldPosition(new THREE.Vector3()).applyMatrix4(toModel) : undefined;
  };
  for (let extra = 0; extra <= 0.9; extra += 0.04) {
    pose(extra);
    vrm.scene.updateMatrixWorld(true);
    toModel.copy(vrm.scene.matrixWorld).invert();
    let clear = true;
    for (const side of ["left", "right"] as const) {
      const elbow = at(`${side}LowerArm`);
      const hand = at(`${side}Hand`);
      if (!elbow || !hand) continue;
      const forearm = elbow.distanceTo(hand);
      const band = Math.max(0.02, forearm * 0.15);
      // The hand's own bulk, and halfway down the forearm, must both be outside the body.
      const margin = forearm * 0.3;
      const mid = elbow.clone().lerp(hand, 0.5);
      for (const p of [hand, mid]) {
        if (Math.abs(p.x) < halfWidthAt(points, p.y, band) + margin) clear = false;
      }
    }
    if (clear) return extra;
  }
  return 0.9;
}

/** The right arm as the model was made: where the shoulder, the elbow and the wrist stand, in the body's own frame. */
export interface Arm {
  shoulder: V3;
  elbow: V3;
  hand: V3;
}

/** The most an arm is taken to hang below level as made: past this, it is a model posed some other way. */
const DROOP_MOST = 0.9;

/**
 * How far below level the upper arm hangs as the model was made, in radians:
 * none for a T-pose, more for an A-pose. Poses are written for a T-pose, so
 * an arm a gesture raises is raised this much more, to end up where it was
 * meant to (`armDroop` in `motion.ts`).
 */
export function droopOf(arm: Arm): number {
  const down = arm.shoulder[1] - arm.elbow[1];
  const out = Math.hypot(arm.elbow[0] - arm.shoulder[0], arm.elbow[2] - arm.shoulder[2]);
  if (out < 1e-6) return down > 0 ? DROOP_MOST : 0;
  return Math.min(DROOP_MOST, Math.max(0, Math.atan2(down, out)));
}

/**
 * How the right arm is turned, in full: the upper arm and the lower, each as
 * Euler angles (x, y, z) from the arm as made, in the body's own frame, as a
 * pose gives them.
 */
export interface ArmTurn {
  upper: V3;
  lower: V3;
}

/**
 * Where the elbow and the hand end up with the arm turned so: the upper arm
 * turns the whole arm about the shoulder, and the lower arm turns the forearm
 * about the elbow, after it.
 */
export function handAt(arm: Arm, turn: ArmTurn): { elbow: THREE.Vector3; hand: THREE.Vector3 } {
  const upper = new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn.upper));
  const lower = new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn.lower)).premultiply(upper);
  const shoulder = new THREE.Vector3(...arm.shoulder);
  const elbow = new THREE.Vector3(...arm.elbow).sub(shoulder).applyQuaternion(upper).add(shoulder);
  const forearm = new THREE.Vector3(...arm.hand).sub(new THREE.Vector3(...arm.elbow)).applyQuaternion(lower);
  return { elbow, hand: elbow.clone().add(forearm) };
}

/**
 * How to turn the right arm to bring its hand to `target`, or as near as it
 * reaches: two bones solved exactly, the elbow bent just enough for the
 * shoulder-to-hand distance and pointing as near `elbow` (a direction from
 * the shoulder) as that allows, each bone turned the shortest way from as
 * made. Then the forearm turned about its own length, which leaves the hand
 * where it is, until the palm faces `palm` as near as it can: a palm faces
 * down when the arm is out as made. `miss` is how far short the hand stays,
 * in metres.
 */
export function reach(arm: Arm, target: V3, opts: { elbow: V3; palm?: V3 }): ArmTurn & { miss: number } {
  const shoulder = new THREE.Vector3(...arm.shoulder);
  const madeUpper = new THREE.Vector3(...arm.elbow).sub(shoulder);
  const madeFore = new THREE.Vector3(...arm.hand).sub(new THREE.Vector3(...arm.elbow));
  const [a, b] = [madeUpper.length(), madeFore.length()];
  const goal = new THREE.Vector3(...target).sub(shoulder);
  const way = goal.lengthSq() > 1e-12 ? goal.clone().normalize() : new THREE.Vector3(0, -1, 0);
  // Never quite straight, nor folded flat: a solution either side of its limits.
  const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, goal.length()));
  // The elbow is on a circle round the line to the hand: `along` it from the shoulder, `out` from the line.
  const along = (a * a - b * b + d * d) / (2 * d);
  const out = Math.sqrt(Math.max(0, a * a - along * along));
  const pole = new THREE.Vector3(...opts.elbow);
  pole.sub(way.clone().multiplyScalar(pole.dot(way)));
  if (pole.lengthSq() < 1e-8) pole.set(0, -1, 0).sub(way.clone().multiplyScalar(-way.y));
  pole.normalize();
  const elbow = way.clone().multiplyScalar(along).add(pole.multiplyScalar(out));
  const hand = way.clone().multiplyScalar(d);
  const upper = new THREE.Quaternion().setFromUnitVectors(madeUpper.clone().normalize(), elbow.clone().normalize());
  // The forearm's way in the upper arm's own frame, turned the shortest way from as made.
  const fore = hand.clone().sub(elbow).normalize().applyQuaternion(upper.clone().invert());
  let lower = new THREE.Quaternion().setFromUnitVectors(madeFore.clone().normalize(), fore);
  if (opts.palm) lower = twisted(madeFore.normalize(), upper, lower, new THREE.Vector3(...opts.palm).normalize());
  const euler = (q: THREE.Quaternion): V3 => {
    const e = new THREE.Euler().setFromQuaternion(q);
    return [e.x, e.y, e.z];
  };
  const turn: ArmTurn = { upper: euler(upper), lower: euler(lower) };
  return { ...turn, miss: handAt(arm, turn).hand.distanceTo(new THREE.Vector3(...target)) };
}

/** Turns of the forearm about its own length tried, to face the palm: every way round. */
const TWISTS = 48;

/**
 * The lower arm turned further about the forearm's own length (`along`, as
 * made), for the palm to face `toward` as near as it can. Facing down as made,
 * square to the forearm.
 */
function twisted(
  along: THREE.Vector3,
  upper: THREE.Quaternion,
  lower: THREE.Quaternion,
  toward: THREE.Vector3,
): THREE.Quaternion {
  const down = new THREE.Vector3(0, -1, 0);
  const face = down.sub(along.clone().multiplyScalar(down.dot(along))).normalize();
  const turnedBy = (angle: number) => lower.clone().multiply(new THREE.Quaternion().setFromAxisAngle(along, angle));
  let best = { angle: 0, dot: Number.NEGATIVE_INFINITY };
  for (let i = 0; i < TWISTS; i++) {
    const angle = -Math.PI + (i * 2 * Math.PI) / TWISTS;
    const dot = face
      .clone()
      .applyQuaternion(upper.clone().multiply(turnedBy(angle)))
      .dot(toward);
    if (dot > best.dot) best = { angle, dot };
  }
  return turnedBy(best.angle);
}

/**
 * Where the hand goes to hold a phone to the ear, in the body's own frame:
 * at the right side of the head (−x), `gap` out from it for the phone between
 * them, below the eyes, where the hand holds a phone whose top is at the ear,
 * and a little in front of the middle of the head, as ears are. From the head as measured, so it is a big head's side
 * on a robot and a small one's on a person.
 */
export function earAt(fit: Pick<BodyFit, "head" | "face">, gap: number): V3 {
  const { min, max } = fit.head;
  const tall = max[1] - min[1];
  return [min[0] - gap, Math.max(min[1], fit.face.y - 0.22 * tall), min[2] + (max[2] - min[2]) * 0.55];
}

/**
 * The humanoid bones each part worn on is measured from, and what hangs off
 * them (a tail, a skirt, ears). Not hair: long hair hangs off the head to the
 * waist, and would make a head of the whole back. What hangs off the head
 * counts only for a model whose head has hardly any skin of its own.
 */
const PARTS: Record<keyof BodyPoints, VRMHumanBoneName[]> = {
  head: ["head", "leftEye", "rightEye", "jaw"],
  neck: ["neck"],
  chest: ["spine", "chest", "upperChest"],
  hips: ["hips"],
};

/** The bone each of those parts is fixed to: the highest of the chest's that the model has. */
const BONES: Record<Bone, VRMHumanBoneName[]> = {
  head: ["head"],
  chest: ["upperChest", "chest", "spine"],
  hips: ["hips"],
};

/**
 * The body measured for what it wears, in `frame`'s space (the figure's own),
 * standing as the model was made, which is how a model is when it has just
 * loaded: its head, face, neck, chest and hips from the points on its skin
 * each bone moves, and where each bone things are fixed to stands, to fix
 * them there later in whatever pose the body is in. Nothing for a model with
 * no head to measure.
 */
export function measureWear(
  vrm: VRM,
  frame: THREE.Object3D,
): { fit: BodyFit; rest: Record<Bone, THREE.Matrix4> } | undefined {
  frame.updateMatrixWorld(true);
  const toFrame = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  const partOf = new Map<THREE.Object3D, keyof BodyPoints>();
  for (const [part, names] of Object.entries(PARTS) as [keyof BodyPoints, VRMHumanBoneName[]][])
    for (const name of names) {
      const node = vrm.humanoid.getRawBoneNode(name);
      if (node) partOf.set(node, part);
    }
  const humanoid = new Set(
    Object.keys(vrm.humanoid.humanBones).flatMap((name) => {
      const node = vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName);
      return node ? [node] : [];
    }),
  );
  // Each skeleton bone's part: its own, or the nearest humanoid bone's above it; none for an arm or a leg. What hangs
  // off the head is kept apart, as `hair`.
  const found = new Map<THREE.Object3D, keyof BodyPoints | "hair" | null>();
  const part = (bone: THREE.Object3D): keyof BodyPoints | "hair" | null => {
    const known = found.get(bone);
    if (known !== undefined) return known;
    let at: THREE.Object3D | null = bone;
    while (at && !humanoid.has(at)) at = at.parent;
    const own = at ? (partOf.get(at) ?? null) : null;
    const result = own === "head" && at !== bone ? "hair" : own;
    found.set(bone, result);
    return result;
  };
  const points: BodyPoints = { head: [], neck: [], chest: [], hips: [] };
  const hair: V3[] = [];
  const v = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const index = mesh.geometry.getAttribute("skinIndex");
    const weight = mesh.geometry.getAttribute("skinWeight");
    const pos = mesh.geometry.getAttribute("position");
    if (!pos || !index || !weight) return;
    // Every few vertices is plenty for a box, and keeps a dense model cheap.
    const step = Math.max(1, Math.floor(pos.count / 8000));
    for (let i = 0; i < pos.count; i += step) {
      let top = 0;
      for (let k = 1; k < 4; k++) if (weight.getComponent(i, k) > weight.getComponent(i, top)) top = k;
      const bone = mesh.skeleton.bones[index.getComponent(i, top)];
      const which = bone ? part(bone) : null;
      if (!which) continue;
      mesh.getVertexPosition(i, v);
      mesh.localToWorld(v).applyMatrix4(toFrame);
      (which === "hair" ? hair : points[which]).push([v.x, v.y, v.z]);
    }
  });
  if (points.head.length < 30) points.head.push(...hair);
  // Where the eyes are, when the model says: its eye bones, or else how far its eyes are from its head bone.
  const head = vrm.humanoid.getRawBoneNode("head");
  const eyeBones = (["leftEye", "rightEye"] as const).flatMap((b) => {
    const node = vrm.humanoid.getRawBoneNode(b);
    return node ? [node.getWorldPosition(new THREE.Vector3()).applyMatrix4(toFrame)] : [];
  });
  let eyes: V3 | undefined;
  const offset = vrm.lookAt?.offsetFromHeadBone;
  if (eyeBones.length) {
    const at = eyeBones.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(eyeBones.length);
    eyes = [at.x, at.y, at.z];
  } else if (head && offset && offset.lengthSq() > 1e-6) {
    const at = head.localToWorld(offset.clone()).applyMatrix4(toFrame);
    eyes = [at.x, at.y, at.z];
  }
  const fit = fitFrom(points, eyes);
  if (!fit) return undefined;
  const rest = {} as Record<Bone, THREE.Matrix4>;
  for (const [bone, names] of Object.entries(BONES) as [Bone, VRMHumanBoneName[]][]) {
    const node = names.map((n) => vrm.humanoid.getRawBoneNode(n)).find((n) => !!n);
    if (!node) return undefined;
    rest[bone] = new THREE.Matrix4().multiplyMatrices(toFrame, node.matrixWorld);
  }
  return { fit, rest };
}

/** The raw bone each part worn on is fixed to. */
export function wearBone(vrm: VRM, bone: Bone): THREE.Object3D | null {
  for (const name of BONES[bone]) {
    const node = vrm.humanoid.getRawBoneNode(name);
    if (node) return node;
  }
  return null;
}
