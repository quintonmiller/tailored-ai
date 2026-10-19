/**
 * Fitting poses to the model's own body. A pose written for one figure puts
 * another's hands through its hips when the second is stockier: arms at rest
 * on a slim mannequin are inside a chunky robot. This measures the body and
 * says how far out the arms must swing to clear it.
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
