/**
 * Fitting poses to the model's own body. A pose written for one figure puts
 * another's hands through its hips when the second is stockier: arms at rest
 * on a slim mannequin are inside a chunky robot. This measures the body and
 * says how far out the arms must swing to clear it.
 */
import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";

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
