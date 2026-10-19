/**
 * The 3D half of the avatar: a small room, lit for the time of day, with a
 * VRM model in it, moving every frame by the pose {@link Motion} computes.
 * It walks between the room's spots on its own while nobody is talking to
 * it, comes back to the middle when a session starts, and goes where you
 * click. Drag to look around; the close-up view follows the head and torso.
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
import { type ClipLibrary, type ClipRole, loadClipLibrary, rolesFor } from "./clips";
import { armClearance, bodyPoints } from "./fit";
import { Director, route, turnBetween, Walker } from "./locomotion";
import { type BodyState, Motion, POSE_BONES, type Pose } from "./motion";
import { type BuiltProp, buildProp, buildShell, disposeTree } from "./props";
import {
  DEFAULT_ROOM,
  type Lighting,
  lightingFor,
  lookTarget,
  nearestWithin,
  OPEN_SIDES,
  ROOM_VIEW,
  type Room,
  roomDistance,
  spotById,
  spotFor,
} from "./scene";

/** The whole room, or the avatar's head and torso. */
export type StageView = "room" | "close";

export interface Stage {
  setView(view: StageView): void;
  /** Say how much of the stage's right side is covered, so the camera frames what is left. */
  setInsets(insets: { right: number }): void;
  /** Walk to a spot in the room, by id. False when there is no such spot. */
  walkTo(spot: string): boolean;
  /**
   * Do what a cue from the agent says: a gesture, `go` to a place, or `look`
   * or `point` at something. One the room can't make sense of is ignored.
   */
  cue(cue: { name: string; target?: string }): void;
  dispose(): void;
}

/**
 * Read every frame: the turn's moment, the voice's loudness right now (0–1),
 * and whether a session is under way, which keeps the avatar from wandering.
 */
export type StageInput = () => { state: BodyState; loudness: () => number; engaged: boolean };

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
  opts: {
    reducedMotion?: boolean;
    view?: StageView;
    room?: Room;
    hour?: number;
    /** Animation libraries to play; the avatar moves by code until they load, and if they can't. */
    animations?: string[];
  } = {},
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
  // Everything a close-up camera must not sit inside or look through.
  const scenery: THREE.Object3D[] = [];
  const shell = buildShell(room);
  scene.add(shell);
  scenery.push(shell);
  const glows: Partial<Record<string, BuiltProp>> = {};
  // Furniture that leads somewhere when clicked.
  const clickable: THREE.Object3D[] = [];
  let lampAt: THREE.Vector3 | undefined;
  for (const prop of room.props) {
    const built = buildProp(prop.kind);
    built.group.position.set(prop.at[0], prop.elevation ?? 0, prop.at[1]);
    built.group.rotation.y = rad(prop.facing);
    scene.add(built.group);
    scenery.push(built.group);
    if (prop.spot) {
      built.group.userData.spot = prop.spot;
      clickable.push(built.group);
    }
    if (built.glow) glows[prop.kind] = built;
    if (prop.kind === "lamp") lampAt = new THREE.Vector3(prop.at[0], 1.45, prop.at[1]);
  }

  // The body is a group around the model, so placing and turning it leaves
  // the model's own VRM 0.x turn alone.
  const start = spotById(room, room.start) ?? room.spots[0];
  const body = new THREE.Group();
  body.add(vrm.scene);
  if (start) {
    body.position.set(start.at[0], 0, start.at[1]);
    body.rotation.y = rad(start.facing);
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
  // What the close-up frames, measured up from the body's feet.
  const torso = (bounds.max.y + hipsY) / 2;

  // Walking: speed and stride in proportion to the legs, so a small robot
  // pads along and a tall figure strides.
  const walker = new Walker(
    { x: body.position.x, z: body.position.z, facing: body.rotation.y },
    Math.max(0.3, hipsY * 1.35),
  );
  const stride = Math.max(0.15, hipsY * 1.1);
  const director = new Director(room);
  /** The spot it is at, or walking to. */
  let current: string | undefined = start?.id;
  /** A walk asked for while seated: it stands up first. */
  let pending: string | undefined;
  let seated = 0;
  const go = (id: string) => {
    const to = spotById(room, id);
    if (!to) return false;
    director.sent();
    if (seated > 0.05) {
      pending = id;
      return true;
    }
    pending = undefined;
    walker.go(route(room, walker.busy ? undefined : current, id), rad(to.facing));
    current = id;
    return true;
  };

  const camera = new THREE.PerspectiveCamera(ROOM_VIEW.fov, 1, 0.05, 60);
  const controls = new OrbitControls(camera, renderer.domElement);
  // Dragging turns the view. The wheel is left to scroll the page.
  Object.assign(controls, { enableZoom: false, enablePan: false, enableDamping: true, rotateSpeed: 0.6 });

  // A close-up from the preferred angle when the view is clear; otherwise the
  // nearest clear angle on the open side, then a little closer in. A shelf or
  // a wall between the camera and the avatar is never the shot.
  const sight = new THREE.Raycaster();
  const clearShot = (target: THREE.Vector3, distance: number, preferred: number) => {
    const angles = [preferred];
    for (let step = 0.15; step < OPEN_SIDES[1] - OPEN_SIDES[0]; step += 0.15)
      angles.push(preferred + step, preferred - step);
    const inRange = angles.filter((a) => a >= OPEN_SIDES[0] && a <= OPEN_SIDES[1]);
    for (const d of [distance, distance * 0.8, distance * 0.65]) {
      for (const a of inRange) {
        const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - 0.08, a);
        sight.set(target, dir);
        sight.far = d + 0.1;
        if (!sight.intersectObjects(scenery, true).length) return { azimuth: a, distance: d };
      }
    }
    return { azimuth: preferred, distance };
  };

  /** Pixels on the right of the stage covered by something laid over it, like a chat panel. */
  let insetRight = 0;
  /** The shape of the part of the stage that can be seen: framing fits the room into that. */
  const visibleAspect = () => Math.max(0.2, (host.clientWidth - insetRight) / Math.max(1, host.clientHeight));

  const framing = (view: StageView): Framing => {
    if (view === "close") {
      const top = bounds.max.y;
      const span = (top - hipsY) * 1.25;
      const vfov = rad(ROOM_VIEW.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * visibleAspect());
      const distance = Math.max(span / 2 / Math.tan(vfov / 2), (span * 0.9) / 2 / Math.tan(hfov / 2));
      const target = new THREE.Vector3(body.position.x, body.position.y + torso, body.position.z);
      // In front of its face when that side of the room is open; at a desk or
      // a shelf it faces a wall, so the camera takes the nearest open angle.
      const { azimuth, distance: near } = clearShot(target, distance, nearestWithin(body.rotation.y, OPEN_SIDES));
      return {
        target,
        position: new THREE.Vector3().setFromSphericalCoords(near, Math.PI / 2 - 0.08, azimuth).add(target),
        azimuth: OPEN_SIDES,
        polar: [1.1, 1.75],
      };
    }
    const target = new THREE.Vector3(0, 0.65, -0.15);
    const distance = roomDistance(room, visibleAspect());
    return {
      target,
      position: new THREE.Vector3()
        .setFromSphericalCoords(distance, Math.PI / 2 - ROOM_VIEW.elevation, ROOM_VIEW.azimuth)
        .add(target),
      azimuth: OPEN_SIDES,
      polar: [0.55, 1.3],
    };
  };

  let view: StageView = opts.view ?? "room";
  let tween: { from: Framing; to: Framing; started: number } | null = null;
  /** Ease the camera to a framing; with reduced motion, go straight there. */
  const moveCamera = (to: Framing) => {
    if (opts.reducedMotion) {
      tween = null;
      settle(to);
      return;
    }
    controls.enabled = false;
    tween = {
      from: { target: controls.target.clone(), position: camera.position.clone(), azimuth: [0, 0], polar: [0, 0] },
      to,
      started: performance.now(),
    };
  };
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
    // Shift the picture left by half the covered strip, so the scene is
    // centred in the part of the stage nothing is laid over.
    if (insetRight > 0 && insetRight < w) camera.setViewOffset(w, h, insetRight / 2, 0, w, h);
    else camera.clearViewOffset();
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

  // A click (not a drag) on furniture sends the avatar to its spot; the
  // pointer says so on hover.
  const canvas = renderer.domElement;
  const ray = new THREE.Raycaster();
  const spotAt = (e: PointerEvent): string | undefined => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    for (const hit of ray.intersectObjects(clickable, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent)
        if (typeof o.userData.spot === "string") return o.userData.spot;
    }
    return undefined;
  };
  let downAt: [number, number] | null = null;
  const onDown = (e: PointerEvent) => {
    downAt = [e.clientX, e.clientY];
  };
  const onUp = (e: PointerEvent) => {
    const moved = downAt ? Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) : Infinity;
    downAt = null;
    if (moved > 6) return;
    const id = spotAt(e);
    if (id) go(id);
  };
  const onHover = (e: PointerEvent) => {
    if (downAt || e.pointerType !== "mouse") return;
    canvas.style.cursor = spotAt(e) ? "pointer" : "";
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onHover);

  const motion = new Motion(opts);
  // Swing the arms out just far enough that the hands clear this body.
  const points = bodyPoints(vrm);
  const probe = new Motion({ reducedMotion: true });
  motion.armClearance = armClearance(vrm, points, (extra) => {
    vrm.humanoid.resetNormalizedPose();
    probe.armClearance = extra;
    apply(vrm, probe.step(0, "idle", 0), flip);
    vrm.update(0);
  });
  const hipsNode = vrm.humanoid.getNormalizedBoneNode("hips");

  // Animation files, when configured, take over the base pose once they load;
  // until then, and if they can't, the code-driven motion carries on.
  let clips: ClipPlayer | undefined;
  let disposed = false;
  if (opts.animations?.length) {
    loadClipLibrary(opts.animations, vrm)
      .then((library) => {
        if (disposed) return;
        const player = clipPlayer(library, vrm);
        if (!player) return;
        motion.armClearance = armClearance(vrm, points, (extra) => player.sample("idle", extra, flip));
        if (player.walkSpeed) walker.speed = player.walkSpeed;
        clips = player;
        host.dataset.motion = "clips";
      })
      .catch(() => {});
  }
  let lastWalkAt = Number.NEGATIVE_INFINITY;
  let wasBusy = false;
  let lastDragAt = Number.NEGATIVE_INFINITY;
  controls.addEventListener("start", () => {
    lastDragAt = clock;
  });
  // Which motion is playing, for anyone inspecting the page: "code" until animation files take over.
  host.dataset.motion = "code";
  const started = performance.now();
  let last = started;
  /** The stage's clock, in seconds, as of the last frame: when a cue's move starts. */
  let clock = 0;

  // Looking or pointing at something: the head turns toward it, and the whole
  // body turns first when it is too far round for a head, or to point.
  const aim = (target: string, point: boolean) => {
    const where = lookTarget(room, target);
    if (!where) return;
    const from = new THREE.Vector3(body.position.x, body.position.y + torso, body.position.z);
    const to = "viewer" in where ? camera.position.clone() : new THREE.Vector3(...where.at);
    const yaw = turnBetween(walker.place.facing, Math.atan2(to.x - from.x, to.z - from.z));
    const pitch = Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z));
    const free = seated < 0.05 && !walker.busy && !pending;
    if (free && (point || Math.abs(yaw) > 0.9)) {
      walker.go([], walker.place.facing + yaw);
      motion.look(0, pitch, clock);
    } else {
      motion.look(yaw, pitch, clock);
    }
    if (point) motion.gesture("point", clock);
  };

  renderer.setAnimationLoop((now: number) => {
    const t = (now - started) / 1000;
    clock = t;
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
    const { state, loudness, engaged } = input();
    const here = walker.busy || pending ? undefined : current;
    const next = director.decide(t, here, engaged);
    if (next) go(next);
    if (pending && seated <= 0.05) go(pending);
    const walked = pending ? 0 : walker.step(dt);
    // Arrived somewhere: the close-up finds its best angle again, unless the
    // person turned the view themselves a moment ago.
    if (wasBusy && !walker.busy && view === "close" && !tween && t - lastDragAt > 8) moveCamera(framing("close"));
    wasBusy = walker.busy;
    const spot = current ? spotById(room, current) : undefined;
    if (walked > 0) lastWalkAt = t;
    const pose = motion.step(t, state, loudness(), {
      walked,
      stride,
      ...(here && spot?.activity ? { activity: spot.activity } : {}),
      ...(clips ? { clips: clips.covers } : {}),
    });
    seated = pose.seated;
    if (clips) {
      // The files play the base: walking, sitting, arms folded at the window,
      // talking, or idle. The code-driven moves go on top.
      const role: ClipRole =
        t - lastWalkAt < 0.2
          ? "walk"
          : here && spot?.activity === "sit"
            ? state === "speaking"
              ? "sitTalk"
              : "sit"
            : here && spot?.activity === "look"
              ? "foldArms"
              : state === "speaking"
                ? "talk"
                : "idle";
      clips.update(role, t, dt);
      overlay(vrm, pose, flip);
    } else {
      apply(vrm, pose, flip);
    }
    // Settling onto a seat moves the body back onto it and to its height.
    let { x, z } = walker.place;
    let y = pose.lift;
    if (spot?.seat && seated > 0) {
      x += (spot.seat.at[0] - x) * seated;
      z += (spot.seat.at[1] - z) * seated;
      // From where the hips are now: a sitting clip lowers them itself.
      y += (spot.seat.height + 0.03 - (hipsNode?.position.y ?? hipsY)) * seated;
    }
    body.position.set(x, y, z);
    body.rotation.y = walker.place.facing;
    // The close-up keeps the torso in frame wherever the avatar goes, from
    // the angle the person last left the view at.
    if (view === "close" && !tween) {
      const follow = new THREE.Vector3(x, y + torso, z).sub(controls.target).multiplyScalar(1 - Math.exp(-dt / 0.25));
      controls.target.add(follow);
      camera.position.add(follow);
    }
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
      moveCamera(framing(next));
    },
    setInsets({ right }) {
      if (right === insetRight) return;
      insetRight = Math.max(0, right);
      resize();
    },
    walkTo: go,
    cue(c) {
      if (c.name === "go") {
        const spot = c.target ? spotFor(room, c.target) : undefined;
        if (spot) go(spot.id);
      } else if (c.name === "look" || c.name === "point") {
        if (c.target) aim(c.target, c.name === "point");
      } else {
        // A nod or a head shake from the files when there is one; the rest by code.
        if (!clips?.shot(c.name as ClipRole, clock)) motion.gesture(c.name, clock);
      }
    },
    dispose() {
      disposed = true;
      clips?.dispose();
      renderer.setAnimationLoop(null);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onHover);
      controls.dispose();
      VRMUtils.deepDispose(vrm.scene);
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
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
