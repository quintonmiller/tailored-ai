/**
 * The 3D half of the avatar: a small room, lit for the time of day, with a
 * VRM model standing in it and moving every frame by the pose {@link Motion}
 * computes. Drag to look around; the close-up view frames the head and torso.
 * Imported only when an avatar is configured, so three.js stays out of the
 * main bundle.
 *
 * VRM is the open format for humanoid avatars: a glTF file whose skeleton,
 * mouth shapes and blink follow one standard, so any VRM model works here
 * without per-model setup.
 */
import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type BodyState, Motion, POSE_BONES, type Pose } from "./motion";
import { type BuiltProp, buildProp, buildShell, disposeTree } from "./props";
import { DEFAULT_ROOM, type Lighting, lightingFor, ROOM_VIEW, type Room, roomDistance, spotById } from "./scene";

/** The whole room, or the avatar's head and torso. */
export type StageView = "room" | "close";

export interface Stage {
  setView(view: StageView): void;
  dispose(): void;
}

/** Read every frame: the turn's moment, and the voice's loudness right now (0–1). */
export type StageInput = () => { state: BodyState; loudness: () => number };

/** Seconds to move between views. */
const VIEW_SECONDS = 0.8;

interface Framing {
  target: THREE.Vector3;
  position: THREE.Vector3;
  azimuth: [number, number];
  polar: [number, number];
}

const rad = (degrees: number) => (degrees * Math.PI) / 180;

export async function createStage(
  host: HTMLElement,
  url: string,
  input: StageInput,
  opts: { reducedMotion?: boolean; view?: StageView; room?: Room; hour?: number } = {},
): Promise<Stage> {
  const room = opts.room ?? DEFAULT_ROOM;
  // Throws where the browser has no WebGL; the caller shows why.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

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
  // VRM 0.x models face the other way; this turns them to face +Z like 1.0 ones.
  VRMUtils.rotateVRM0(vrm);
  // Poses are written in the VRM 1.0 frame; a 0.x model's normalized bones
  // have their X and Z axes the other way round.
  const flip = vrm.meta.metaVersion === "0" ? -1 : 1;
  vrm.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });

  const scene = new THREE.Scene();
  scene.add(buildShell(room));
  const glows: Partial<Record<string, BuiltProp>> = {};
  let lampAt: THREE.Vector3 | undefined;
  for (const prop of room.props) {
    const built = buildProp(prop.kind);
    built.group.position.set(prop.at[0], prop.elevation ?? 0, prop.at[1]);
    built.group.rotation.y = rad(prop.facing);
    scene.add(built.group);
    if (built.glow) glows[prop.kind] = built;
    if (prop.kind === "lamp") lampAt = new THREE.Vector3(prop.at[0], 1.45, prop.at[1]);
  }

  // The body is a group around the model, so placing and turning it leaves
  // the model's own VRM 0.x turn alone.
  const spot = spotById(room, room.start) ?? room.spots[0];
  const body = new THREE.Group();
  body.add(vrm.scene);
  if (spot) {
    body.position.set(spot.at[0], 0, spot.at[1]);
    body.rotation.y = rad(spot.facing);
  }
  scene.add(body);

  const sky = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.position.set(-4, 5.5, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: 0.5, far: 16 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  const lamp = new THREE.PointLight(0xffc98a, 0, 5, 1.5);
  if (lampAt) lamp.position.copy(lampAt);
  scene.add(sky, sun, lamp);
  const light = (l: Lighting) => {
    sky.color.setHex(l.sky.color);
    sky.groundColor.setHex(l.sky.ground);
    sky.intensity = l.sky.intensity;
    sun.color.setHex(l.sun.color);
    sun.intensity = l.sun.intensity;
    lamp.intensity = l.lamp.on ? l.lamp.intensity : 0;
    const shade = glows.lamp?.glow;
    if (shade) shade.emissiveIntensity = l.lamp.on ? 0.9 : 0;
    const glass = glows.window?.glow;
    if (glass) {
      glass.color.setHex(l.window.color);
      glass.emissive.setHex(l.window.color);
      glass.emissiveIntensity = l.window.glow;
    }
  };
  const hourNow = () => opts.hour ?? new Date().getHours();
  let hour = hourNow();
  light(lightingFor(hour));

  // The avatar's own proportions, for the close-up.
  body.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(body);
  const hipsY =
    vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(new THREE.Vector3()).y ??
    bounds.min.y + (bounds.max.y - bounds.min.y) / 2;

  const camera = new THREE.PerspectiveCamera(ROOM_VIEW.fov, 1, 0.05, 60);
  const controls = new OrbitControls(camera, renderer.domElement);
  // Dragging turns the view. The wheel is left to scroll the page.
  Object.assign(controls, { enableZoom: false, enablePan: false, enableDamping: true, rotateSpeed: 0.6 });

  const framing = (view: StageView): Framing => {
    if (view === "close") {
      const top = bounds.max.y;
      const span = (top - hipsY) * 1.25;
      const vfov = rad(ROOM_VIEW.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const distance = Math.max(span / 2 / Math.tan(vfov / 2), (span * 0.9) / 2 / Math.tan(hfov / 2));
      const target = new THREE.Vector3(body.position.x, (top + hipsY) / 2, body.position.z);
      const facing = body.rotation.y;
      return {
        target,
        position: new THREE.Vector3().setFromSphericalCoords(distance, Math.PI / 2 - 0.08, facing).add(target),
        azimuth: [facing - 0.9, facing + 0.9],
        polar: [1.1, 1.75],
      };
    }
    const target = new THREE.Vector3(0, 0.65, -0.15);
    const distance = roomDistance(room, camera.aspect);
    return {
      target,
      position: new THREE.Vector3()
        .setFromSphericalCoords(distance, Math.PI / 2 - ROOM_VIEW.elevation, ROOM_VIEW.azimuth)
        .add(target),
      // Swinging past the open sides would put a wall between you and the room.
      azimuth: [-0.25, 1.25],
      polar: [0.55, 1.3],
    };
  };

  let view: StageView = opts.view ?? "room";
  let tween: { from: Framing; to: Framing; started: number } | null = null;
  const settle = (f: Framing) => {
    camera.position.copy(f.position);
    controls.target.copy(f.target);
    [controls.minAzimuthAngle, controls.maxAzimuthAngle] = f.azimuth;
    [controls.minPolarAngle, controls.maxPolarAngle] = f.polar;
    controls.enabled = true;
    controls.update();
  };

  host.appendChild(renderer.domElement);
  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (tween) return;
    // Keep the angle the person dragged to; only the distance follows the frame's shape.
    const fitted = framing(view);
    const offset = camera.position.clone().sub(controls.target);
    if (offset.lengthSq() === 0) settle(fitted);
    else camera.position.copy(controls.target).add(offset.setLength(fitted.position.distanceTo(fitted.target)));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  settle(framing(view));

  const gaze = new THREE.Object3D();
  scene.add(gaze);
  if (vrm.lookAt) vrm.lookAt.target = gaze;

  const motion = new Motion(opts);
  const started = performance.now();
  let last = started;
  renderer.setAnimationLoop((now: number) => {
    const t = (now - started) / 1000;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (tween) {
      const k = Math.min(1, (now - tween.started) / 1000 / VIEW_SECONDS);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      camera.position.lerpVectors(tween.from.position, tween.to.position, e);
      controls.target.lerpVectors(tween.from.target, tween.to.target, e);
      camera.lookAt(controls.target);
      if (k >= 1) {
        settle(tween.to);
        tween = null;
      }
    } else {
      controls.update();
    }
    if (opts.hour === undefined && hourNow() !== hour) {
      hour = hourNow();
      light(lightingFor(hour));
    }
    const { state, loudness } = input();
    const pose = motion.step(t, state, loudness());
    apply(vrm, pose, flip);
    // The eyes look at you, wherever you have turned the view to.
    const head = Math.max(0.05, bounds.max.y - hipsY) * 0.5;
    gaze.position.set(
      camera.position.x + pose.gaze[0] * head,
      camera.position.y + pose.gaze[1] * head,
      camera.position.z,
    );
    vrm.update(dt);
    renderer.render(scene, camera);
  });

  return {
    setView(next) {
      if (next === view && !tween) return;
      view = next;
      const to = framing(next);
      if (opts.reducedMotion) {
        tween = null;
        settle(to);
        return;
      }
      controls.enabled = false;
      tween = {
        from: {
          target: controls.target.clone(),
          position: camera.position.clone(),
          azimuth: [0, 0],
          polar: [0, 0],
        },
        to,
        started: performance.now(),
      };
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      VRMUtils.deepDispose(vrm.scene);
      disposeTree(scene);
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
