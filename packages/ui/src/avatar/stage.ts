/**
 * The 3D half of the avatar: loads a VRM model with three.js and moves it
 * every frame by the pose {@link Motion} computes. Imported only when an
 * avatar is configured, so three.js stays out of the main bundle.
 *
 * VRM is the open format for humanoid avatars: a glTF file whose skeleton,
 * mouth shapes and blink follow one standard, so any VRM model works here
 * without per-model setup.
 */
import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type BodyState, Motion, POSE_BONES, type Pose } from "./motion";

export interface Stage {
  dispose(): void;
}

/** Read every frame: the turn's moment, and the voice's loudness right now (0–1). */
export type StageInput = () => { state: BodyState; loudness: () => number };

const FOV_DEGREES = 30;

export async function createStage(
  host: HTMLElement,
  url: string,
  input: StageInput,
  opts: { reducedMotion?: boolean } = {},
): Promise<Stage> {
  // Throws where the browser has no WebGL; the caller shows why.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_DEGREES, 1, 0.05, 50);
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1.5, 2);
  scene.add(light, new THREE.AmbientLight(0xffffff, 0.4));

  let vrm: VRM;
  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const loaded = gltf.userData.vrm as VRM | undefined;
    if (!loaded) throw new Error("the file is not a VRM model");
    vrm = loaded;
  } catch (err) {
    renderer.dispose();
    throw err;
  }
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  VRMUtils.combineSkeletons(vrm.scene);
  // VRM 0.x models face the other way; this turns them to face the camera like 1.0 ones.
  VRMUtils.rotateVRM0(vrm);
  scene.add(vrm.scene);
  // Poses are written in the VRM 1.0 frame; a 0.x model's normalized bones
  // have their X and Z axes the other way round.
  const flip = vrm.meta.metaVersion === "0" ? -1 : 1;

  const view = frame(camera, vrm);
  const gaze = new THREE.Object3D();
  scene.add(gaze);
  if (vrm.lookAt) vrm.lookAt.target = gaze;

  host.appendChild(renderer.domElement);
  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const motion = new Motion(opts);
  const started = performance.now();
  let last = started;
  renderer.setAnimationLoop((now: number) => {
    const t = (now - started) / 1000;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const { state, loudness } = input();
    const pose = motion.step(t, state, loudness());
    apply(vrm, pose, flip);
    gaze.position.set(
      camera.position.x + pose.gaze[0] * view.head,
      camera.position.y + pose.gaze[1] * view.head,
      camera.position.z,
    );
    vrm.update(dt);
    renderer.render(scene, camera);
  });

  return {
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
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

/**
 * Point the camera at the head and torso, from the model's own
 * proportions, so a tall figure and a squat one both fill the frame.
 * Returns the head's size, the unit the gaze offsets are in.
 */
function frame(camera: THREE.PerspectiveCamera, vrm: VRM): { head: number } {
  vrm.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const at = (bone: "hips" | "head") =>
    vrm.humanoid.getNormalizedBoneNode(bone)?.getWorldPosition(new THREE.Vector3()).y;
  const top = box.max.y;
  const hips = at("hips") ?? box.min.y + (top - box.min.y) * 0.5;
  const head = at("head") ?? top - (top - hips) * 0.3;
  const bottom = hips;
  const center = (top + bottom) / 2;
  const span = (top - bottom) * 1.2;
  const distance = span / 2 / Math.tan(THREE.MathUtils.degToRad(FOV_DEGREES / 2));
  camera.position.set(0, center + span * 0.05, distance);
  camera.lookAt(0, center, 0);
  return { head: Math.max(0.05, top - head) };
}
