/**
 * The 3D half of the avatar: a small room, lit for the time of day, with a
 * VRM model in it, moving every frame by the pose {@link Motion} computes.
 * It walks between the room's spots on its own while nobody is talking to
 * it, comes back to the middle when a session starts, and goes where you
 * click. Drag to look around; the close-up view follows the head and torso.
 * Other agents in the same room appear too, each with its own body, and
 * wander on their own. Every body shows what its agent is doing: a thing in
 * its hand, a sign over its head, a seat when it reads or sleeps. Imported
 * only when an avatar is configured, so three.js stays out of the main bundle.
 *
 * A stage can also be visited: the body on it is then yours, walked with the
 * arrow keys or WASD (or by clicking the floor), with the camera following;
 * or put away to fly the camera anywhere. Agents look up as you come near.
 *
 * VRM is the open format for humanoid avatars: a glTF file whose skeleton,
 * mouth shapes and blink follow one standard, so any VRM model works here
 * without per-model setup.
 */
import { type VRM, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type BoardTask, drawBoard } from "./boards";
import type { Cue } from "./cues";
import { type AgentActivity, type Behavior, behaviorFor, heldFor, hueFor, sameBehavior, stationSpot } from "./doing";
import { Figure, loadModel } from "./figure";
import type { Obstacle } from "./locomotion";
import type { BodyState } from "./motion";
import { buildProp, buildShell, disposeTree } from "./props";
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
  type Spot,
  spotById,
  spotFor,
} from "./scene";

/** Something an agent said, and when it said it (an ISO time; a reply can be timed to follow). */
export interface Line {
  text: string;
  at: string;
}

/** A line older than this when it arrives was said before anyone was looking: no bubble. */
const STALE_LINE_MS = 15_000;

/** The whole room, or the avatar's head and torso. */
export type StageView = "room" | "close";

/** How a visitor gets around: walking their body, or flying the camera free. */
export type Travel = "walk" | "fly";

/** Keys a visitor moves by: [right, forward, up]. */
const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 1, 0],
  ArrowUp: [0, 1, 0],
  KeyS: [0, -1, 0],
  ArrowDown: [0, -1, 0],
  KeyA: [-1, 0, 0],
  ArrowLeft: [-1, 0, 0],
  KeyD: [1, 0, 0],
  ArrowRight: [1, 0, 0],
  KeyE: [0, 0, 1],
  KeyQ: [0, 0, -1],
};
/** Metres a second the flying camera moves. */
const FLY_SPEED = 2.2;
/** How near an agent you have to be for it to notice you, and how far to go before it forgets. */
const NOTICE_AT = 1.5;
const FORGET_AT = 2.4;
/** How near a visitor has to be to hear what an agent says. */
const HEAR_AT = 3.5;

/** Another agent in the same room: who, what to call it, and its body. */
export interface Companion {
  agent: string;
  /** What the agent you are talking to calls it: "the planner". */
  name: string;
  url: string;
  animations: string[];
}

export interface Stage {
  setView(view: StageView): void;
  /** Say how much of the stage's right side is covered, so the camera frames what is left. */
  setInsets(insets: { right: number }): void;
  /** Walk to a spot in the room, by id. False when there is no such spot. */
  walkTo(spot: string): boolean;
  /**
   * Do what a cue from the agent says: a gesture, `go` to a place, or `look`
   * or `point` at something, or someone else in the room. One the room can't
   * make sense of is ignored.
   */
  cue(cue: { name: string; target?: string }): void;
  /** Show the room as it is now: what is new appears, what is gone goes, and the avatar stays where it can. */
  setRoom(room: Room): void;
  /** Who else is in the room: new arrivals appear at a free spot, and those who left go. */
  setCompany(company: Companion[]): void;
  /** What each agent is doing, by agent: every body in the room shows its own. */
  setActivities(activities: Record<string, AgentActivity>): void;
  /** The last thing each agent said, by agent: a new line shows in a bubble over its head. */
  setSpeech(speech: Record<string, Line>): void;
  /** A visitor walks their body, or flies the camera. */
  setTravel(travel: Travel): void;
  /** The tasks every board in the room shows. */
  setTasks(tasks: BoardTask[]): void;
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

/**
 * When a gesture looks most like itself, in seconds from its start: the photo
 * is posed at exactly this moment. A wave's hand swings in and out, so the
 * moment is when it is furthest out, not wherever a frame happens to land.
 */
const PEAK: Record<string, number> = { wave: 0.9, nod: 0.75, shake: 0.3 };

/** Things that hang on a wall, so they are never in the way of a walk. */
const WALL_KINDS = new Set(["window", "picture", "clock", "shelf"]);

const bare = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .trim();

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
    /**
     * Ask the agent what it does with a quiet moment: where it is, as the room
     * names it, and the local hour. Without one, it wanders at random.
     */
    chooseIdle?: (here: string | undefined, hour: number) => Promise<Cue[]>;
    /**
     * Hold still for a photo: no wandering, at this spot (its start otherwise),
     * striking this gesture. A selfie that isn't sitting turns to the camera.
     */
    still?: { spot?: string; gesture?: string };
    /** Called once, when a still stage is worth photographing. */
    onReady?: () => void;
    /** Who else is in the room from the start. */
    company?: Companion[];
    /** The agent this stage shows, for its activity and its colour. */
    agent?: string;
    /** Someone clicked an agent's body (or its tag): which agent, and where on the page. */
    onPick?: (agent: string, at: { x: number; y: number }) => void;
    /** The body here is the visitor's own, moved by keys and clicks, not an agent's. */
    visitor?: boolean;
    /** The agent the visitor is standing next to, when it changes; undefined when none is. */
    onNear?: (agent: string | undefined) => void;
    /** Something made to be used was clicked: a kiosk, a task board. Its action. */
    onUse?: (action: string) => void;
    /** A visitor is within earshot of an agent as it starts saying something: who, what, and how near (0–1, 1 beside it). */
    onLine?: (agent: string, text: string, nearness: number) => void;
  } = {},
): Promise<Stage> {
  let room = opts.room ?? DEFAULT_ROOM;
  // Throws where the browser has no WebGL; the caller shows why.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  let vrm: VRM;
  try {
    vrm = await loadModel(url);
  } catch (err) {
    renderer.dispose();
    throw err;
  }

  const scene = new THREE.Scene();
  // Everything a close-up camera must not sit inside or look through.
  const scenery: THREE.Object3D[] = [];
  // Furniture that leads somewhere when clicked.
  const clickable: THREE.Object3D[] = [];
  // What glows, by kind: lamp shades, window glass, screens, flames.
  let glows: { kind: string; glow: THREE.MeshStandardMaterial }[] = [];
  // Lamps light the room after dark; a fire lights it always. At most a few, for the frame rate.
  const warm: { light: THREE.PointLight; fire: boolean }[] = [];
  let furniture = new THREE.Group();
  // What stands on the floor in the way: walks go round these.
  let obstacles: Obstacle[] = [];
  // Boards on the walls, each drawn with the tasks; and what they show.
  let boards: { label: string; screen: NonNullable<ReturnType<typeof buildProp>["screen"]> }[] = [];
  let tasks: BoardTask[] = [];
  const drawBoards = () => {
    for (const b of boards) {
      drawBoard(b.screen.canvas, b.label, tasks);
      b.screen.texture.needsUpdate = true;
    }
  };
  // Things that just appeared, growing into place.
  const appearing: { group: THREE.Group; started: number; scale: number }[] = [];

  /** Build the room's shell and furniture; `fresh` names props to grow in, as just added. */
  const furnish = (fresh: Set<string> = new Set()) => {
    furniture = new THREE.Group();
    scenery.length = 0;
    clickable.length = 0;
    glows = [];
    boards = [];
    const shell = buildShell(room);
    furniture.add(shell);
    scenery.push(shell);
    const lights: { at: THREE.Vector3; fire: boolean }[] = [];
    obstacles = [];
    for (const prop of room.props) {
      const built = buildProp(prop.kind, { color: prop.color, size: prop.size, label: prop.label });
      if (built.screen) boards.push({ label: prop.label ?? "Tasks", screen: built.screen });
      built.group.position.set(prop.at[0], prop.elevation ?? 0, prop.at[1]);
      built.group.rotation.y = rad(prop.facing);
      const scale = prop.size ? 1 : (prop.scale ?? 1);
      built.group.scale.setScalar(scale);
      // Its outline on the floor, measured from what was built, before it grows in.
      if (!prop.on && !WALL_KINDS.has(prop.kind) && prop.kind !== "rug") {
        const box = new THREE.Box3().setFromObject(built.group);
        obstacles.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
      }
      furniture.add(built.group);
      scenery.push(built.group);
      if (prop.spot) built.group.userData.spot = prop.spot;
      if (prop.action) built.group.userData.action = prop.action;
      if (prop.spot || prop.action) clickable.push(built.group);
      if (built.glow) glows.push({ kind: prop.kind, glow: built.glow });
      if (prop.kind === "lamp")
        lights.push({ at: new THREE.Vector3(prop.at[0], 1.45 * scale, prop.at[1]), fire: false });
      if (prop.kind === "fireplace") {
        const front = new THREE.Vector3(Math.sin(rad(prop.facing)), 0, Math.cos(rad(prop.facing))).multiplyScalar(0.45);
        lights.push({ at: new THREE.Vector3(prop.at[0], 0.4, prop.at[1]).add(front), fire: true });
      }
      if (fresh.has(prop.id) && !opts.reducedMotion) {
        built.group.scale.setScalar(scale * 0.01);
        appearing.push({ group: built.group, started: performance.now(), scale });
      }
    }
    scene.add(furniture);
    drawBoards();
    for (const w of warm) scene.remove(w.light);
    warm.length = 0;
    for (const l of lights.slice(0, 4)) {
      const light = new THREE.PointLight(l.fire ? 0xff9a50 : 0xffc98a, 0, 5, 1.5);
      light.position.copy(l.at);
      scene.add(light);
      warm.push({ light, fire: l.fire });
    }
  };
  furnish();

  const start =
    (opts.still?.spot ? spotById(room, opts.still.spot) : undefined) ?? spotById(room, room.start) ?? room.spots[0];
  // A photo holds still. A selfie faces the camera, sitting down if the spot is a seat.
  const selfie = !!opts.still && opts.view === "close";
  const stillActivity = opts.still && !(selfie && start?.activity !== "sit") ? start?.activity : undefined;
  const me = new Figure(vrm, room, start, {
    reducedMotion: opts.reducedMotion,
    animations: opts.animations,
    agentChooses: !!opts.chooseIdle,
    ...(selfie && start && start.activity !== "sit" ? { facing: 0.5 } : {}),
    hue: hueFor(opts.agent ?? "default"),
    // Which motion is playing, for anyone inspecting the page: "code" until animation files take over.
    onClips: () => {
      host.dataset.motion = "clips";
    },
  });
  scene.add(me.body, me.gaze);
  host.dataset.motion = "code";

  const self = opts.agent || "default";
  // Other agents in the room, by agent; and those still loading.
  const companions = new Map<string, Figure & { name?: string }>();
  // What each agent is doing, and what each body is showing of it.
  let activities: Record<string, AgentActivity> = {};
  const shows = new Map<Figure, { behavior: Behavior; doing?: string; checked: number; faced: number }>();
  // The last line of each agent's that has been shown, by its time, so a line shows once.
  const heard = new Map<string, string>();
  // Lines about to be said, for a visitor to hear when they start.
  let voices: { agent: string; text: string; at: number }[] = [];
  const arriving = new Set<string>();
  let wanted: Companion[] = [];

  /** Spots someone stands at or is walking to, except `who`. */
  const taken = (who?: Figure): Set<string> => {
    const out = new Set<string>();
    for (const f of [me, ...companions.values()]) if (f !== who && f.current) out.add(f.current);
    return out;
  };
  /** A spot nobody has, other than the middle, which the agent you talk to comes back to. */
  const freeSpot = (who?: Figure): Spot | undefined => {
    const busy = taken(who);
    const open = room.spots.filter((s) => !busy.has(s.id));
    const away = open.filter((s) => s.id !== room.start);
    const pool = away.length ? away : open;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  /** The agent you talk to goes somewhere; anyone already there makes room. */
  const go = (id: string) => {
    for (const c of companions.values()) {
      if (c.current !== id) continue;
      const elsewhere = freeSpot(c);
      if (elsewhere && elsewhere.id !== id) c.go(room, elsewhere.id, obstacles);
    }
    return me.go(room, id, obstacles);
  };

  const sky = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.position.set(-4, 5.5, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: 0.5, far: 16 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sky, sun);
  /** The shadows cover the whole room, however big it has been made. */
  const fitShadows = () => {
    const half = Math.max(room.width, room.depth) / 2 + 0.6;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half });
    sun.shadow.camera.updateProjectionMatrix();
  };
  fitShadows();
  let lit: Lighting | undefined;
  const light = (l: Lighting) => {
    lit = l;
    sky.color.setHex(l.sky.color);
    sky.groundColor.setHex(l.sky.ground);
    sky.intensity = l.sky.intensity;
    sun.color.setHex(l.sun.color);
    sun.intensity = l.sun.intensity;
    for (const w of warm) w.light.intensity = w.fire ? (l.lamp.on ? 1.8 : 0.9) : l.lamp.on ? l.lamp.intensity : 0;
    for (const { kind, glow } of glows) {
      if (kind === "lamp") glow.emissiveIntensity = l.lamp.on ? 0.9 : 0;
      else if (kind === "window") {
        glow.color.setHex(l.window.color);
        glow.emissive.setHex(l.window.color);
        glow.emissiveIntensity = l.window.glow;
      } else if (kind === "fireplace" || kind === "candle") glow.emissiveIntensity = 1.4;
      else if (kind === "tv") glow.emissiveIntensity = 0.55;
      else if (kind === "aquarium") glow.emissiveIntensity = l.lamp.on ? 0.5 : 0.15;
    }
  };
  const hourNow = () => opts.hour ?? new Date().getHours();
  let hour = hourNow();
  light(lightingFor(hour));

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
      const top = me.bounds.max.y;
      const span = (top - me.hipsY) * 1.25;
      const vfov = rad(ROOM_VIEW.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * visibleAspect());
      // A selfie stands back a little further than the chat page's close-up, so the room shows behind.
      const distance =
        Math.max(span / 2 / Math.tan(vfov / 2), (span * 0.9) / 2 / Math.tan(hfov / 2)) * (selfie ? 1.5 : 1);
      const target = me.head();
      // In front of its face when that side of the room is open; at a desk or
      // a shelf it faces a wall, so the camera takes the nearest open angle.
      const { azimuth, distance: near } = clearShot(target, distance, nearestWithin(me.body.rotation.y, OPEN_SIDES));
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
    // A visitor can look all the way round, and from nearly overhead to the floor.
    if (opts.visitor) {
      [controls.minAzimuthAngle, controls.maxAzimuthAngle] = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
      [controls.minPolarAngle, controls.maxPolarAngle] = [0.15, 1.5];
    }
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
  /** What the thing under the pointer does when clicked, if it is made to be used. */
  const actionAt = (e: PointerEvent): string | undefined => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    for (const hit of ray.intersectObjects(clickable, true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent)
        if (typeof o.userData.action === "string") return o.userData.action;
    }
    return undefined;
  };
  /** Where on the floor the pointer is, for a visitor to walk to. */
  const floorAt = (e: PointerEvent): [number, number] | undefined => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!hit || Math.abs(hit.x) > room.width / 2 || Math.abs(hit.z) > room.depth / 2) return undefined;
    return [hit.x, hit.z];
  };

  /** The agent whose body (or tag, or sign) is under the pointer, if any. */
  const agentAt = (e: PointerEvent): string | undefined => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    const bodies = new Map<THREE.Object3D, string>([[me.body, self]]);
    for (const [agent, c] of companions) bodies.set(c.body, agent);
    for (const hit of ray.intersectObjects([...bodies.keys()], true)) {
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const agent = bodies.get(o);
        if (agent) return agent;
      }
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
    // An agent first: a body stands in front of the furniture it is at.
    const who = opts.onPick ? agentAt(e) : undefined;
    if (who) {
      opts.onPick?.(who, { x: e.clientX, y: e.clientY });
      return;
    }
    const action = opts.onUse ? actionAt(e) : undefined;
    if (action) {
      opts.onUse?.(action);
      return;
    }
    const id = spotAt(e);
    if (id) go(id);
    else if (opts.visitor && travel === "walk") {
      const to = floorAt(e);
      if (to) me.goTo(room, to, obstacles);
    }
  };
  const onHover = (e: PointerEvent) => {
    if (downAt || e.pointerType !== "mouse") return;
    canvas.style.cursor = (opts.onPick && agentAt(e)) || spotAt(e) || (opts.onUse && actionAt(e)) ? "pointer" : "";
  };
  // A visitor's keys: held keys move them every frame, unless they are typing.
  let travel: Travel = "walk";
  const held = new Set<string>();
  const typing = (e: KeyboardEvent) =>
    (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");
  const onKeyDown = (e: KeyboardEvent) => {
    if (!opts.visitor || !(e.code in MOVE_KEYS) || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    held.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => held.delete(e.code);
  const onBlur = () => held.clear();
  if (opts.visitor) {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    // Free to look all the way round, and in and out with the wheel.
    controls.enableZoom = true;
  }
  // Agents who have noticed the visitor, until the visitor walks away.
  const noticed = new Set<string>();
  let near: string | undefined;
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onHover);

  let disposed = false;
  let asking = false;
  let readyFired = false;
  let settleFrom: number | undefined;
  let gestureAt: number | undefined;
  let wasBusy = false;
  let lastDragAt = Number.NEGATIVE_INFINITY;
  controls.addEventListener("start", () => {
    lastDragAt = clock;
  });
  const started = performance.now();
  let last = started;
  /** The stage's clock, in seconds, as of the last frame: when a cue's move starts. */
  let clock = 0;

  /** Someone else in the room, by what the agent calls them. */
  const companionNamed = (target: string): Figure | undefined => {
    const t = bare(target);
    for (const [agent, c] of companions) if (bare(c.name ?? agent) === t || bare(agent) === t) return c;
    return undefined;
  };

  function handleCue(c: { name: string; target?: string }) {
    if (c.name === "go") {
      const spot = c.target ? spotFor(room, c.target) : undefined;
      if (spot) go(spot.id);
    } else if (c.name === "look" || c.name === "point") {
      if (!c.target) return;
      const who = companionNamed(c.target);
      if (who) {
        me.aim(who.head(), c.name === "point", clock);
        return;
      }
      const where = lookTarget(room, c.target);
      if (!where) return;
      me.aim("viewer" in where ? camera.position.clone() : new THREE.Vector3(...where.at), c.name === "point", clock);
    } else {
      me.gesture(c.name, clock);
    }
  }

  /** A mouth moving as if to words, with no voice to follow: syllables and the gaps between them. */
  const chatter = (t: number) => Math.max(0, Math.sin(t * 11) * Math.sin(t * 3.3 + 1) + 0.15);

  /** Show what an agent said, once, over its head: now, or when a reply is timed to follow. */
  const hear = (agent: string, line: Line | undefined) => {
    const f = figureOf(agent);
    if (!f || !line || heard.get(agent) === line.at) return;
    heard.set(agent, line.at);
    const delay = Date.parse(line.at) - Date.now();
    if (!Number.isFinite(delay) || delay < -STALE_LINE_MS) return;
    const at = clock + Math.max(0, delay) / 1000;
    f.say(line.text, at);
    if (opts.visitor && opts.onLine && f !== me) voices.push({ agent, text: line.text, at });
  };
  /** Each frame, lines that have just started: heard if the visitor is near enough. */
  const sayAloud = (t: number) => {
    if (!voices.length) return;
    const due = voices.filter((v) => v.at <= t);
    voices = voices.filter((v) => v.at > t);
    for (const v of due) {
      const f = companions.get(v.agent);
      if (!f) continue;
      const d = Math.hypot(f.walker.place.x - me.walker.place.x, f.walker.place.z - me.walker.place.z);
      if (travel === "walk" && d <= HEAR_AT) opts.onLine?.(v.agent, v.text, 1 - d / HEAR_AT);
    }
  };
  let speech: Record<string, Line> = {};

  /** The body an agent has in this room, if it has one here. */
  const figureOf = (agent: string): Figure | undefined => (agent === self ? me : companions.get(agent));

  /** Show on a body what its agent is doing now: its sign, its tag, how it sleeps; a gesture as it starts. */
  function show(agent: string, f: Figure & { name?: string }) {
    const activity = opts.still ? undefined : activities[agent];
    const behavior = behaviorFor(activity);
    const was = shows.get(f);
    const status = behavior.label
      ? behavior.detail
        ? `${behavior.label} · ${behavior.detail}`
        : behavior.label
      : undefined;
    // The agent you talk to needs no name; the others always show theirs.
    f.label(f === me ? (opts.visitor ? "you" : undefined) : f.name, status);
    if (was && sameBehavior(was.behavior, behavior)) return;
    shows.set(f, {
      behavior,
      doing: activity?.doing,
      checked: Number.NEGATIVE_INFINITY,
      faced: Number.NEGATIVE_INFINITY,
    });
    f.signs.set(behavior.sign, clock);
    f.doze(!!behavior.asleep);
    if (behavior.gesture && was?.doing !== activity?.doing) f.gesture(behavior.gesture, clock);
  }

  /**
   * Each frame, what a body's activity asks of where it is: hold its thing
   * (not a laptop, at a desk — it types there), go to a seat or a desk when
   * one is free and nothing else has it walking, and turn to whoever it is
   * talking to when they are here.
   */
  const attend = (f: Figure, t: number, free: boolean) => {
    const s = shows.get(f);
    const b = s?.behavior;
    const spot = f.here ? spotById(room, f.here) : undefined;
    const partner = b?.face ? figureOf(b.face) : undefined;
    const held = heldFor(b, { spotActivity: spot?.activity, partnerHere: !!partner && partner !== f });
    f.hold(held.prop, held.hold);
    if (!s || !b) return;
    if (b.station && free && t - s.checked > 1.5 && !f.walker.busy && !f.pending) {
      s.checked = t;
      const to = stationSpot(
        b.station,
        room.spots,
        { x: f.walker.place.x, z: f.walker.place.z, spotActivity: spot?.activity },
        taken(f),
      );
      if (to) {
        if (f === me) go(to.id);
        else f.go(room, to.id, obstacles);
      }
    }
    if (partner && partner !== f && t - s.faced > 3 && !f.walker.busy) {
      s.faced = t;
      f.aim(partner.head(), false, clock);
    }
  };

  /** Bring the company in line with who should be here. */
  const meet = (company: Companion[]) => {
    wanted = company;
    const ids = new Set(company.map((c) => c.agent));
    for (const [agent, fig] of companions) {
      if (ids.has(agent)) continue;
      fig.dispose();
      companions.delete(agent);
    }
    for (const c of company) {
      const fig = companions.get(c.agent);
      if (fig) {
        fig.name = c.name;
        show(c.agent, fig);
        continue;
      }
      if (arriving.has(c.agent)) continue;
      arriving.add(c.agent);
      loadModel(c.url)
        .then((model) => {
          arriving.delete(c.agent);
          const still = wanted.find((w) => w.agent === c.agent);
          if (disposed || !still) {
            VRMUtils.deepDispose(model.scene);
            return;
          }
          const figure = new Figure(model, room, freeSpot(), {
            reducedMotion: opts.reducedMotion,
            animations: still.animations,
            hue: hueFor(c.agent),
          }) as Figure & { name?: string };
          figure.name = still.name;
          scene.add(figure.body, figure.gaze);
          companions.set(c.agent, figure);
          show(c.agent, figure);
          // What it said before its body arrived is old news.
          if (speech[c.agent]) heard.set(c.agent, speech[c.agent].at);
        })
        .catch(() => {
          arriving.delete(c.agent);
        });
    }
  };
  meet(opts.company ?? []);
  show(self, me);

  /** The room changed under a figure: its spot gone, or moved with its furniture. */
  const reseat = (f: Figure, home: () => string | undefined) => {
    f.director.setRoom(room);
    if (f.pending && !spotById(room, f.pending)) f.pending = undefined;
    const spot = f.current ? spotById(room, f.current) : undefined;
    if (!spot) {
      f.current = undefined;
      const to = home();
      if (to) f.go(room, to, obstacles);
    } else if (f.currentAt && Math.hypot(spot.at[0] - f.currentAt[0], spot.at[1] - f.currentAt[1]) > 0.05) {
      // A walk from a spot to itself goes nowhere: from here, as if between spots.
      f.current = undefined;
      f.go(room, spot.id, obstacles);
    }
  };

  /** The camera's heading on the floor, and its right, for keys that move relative to the view. */
  const heading = () => {
    const fwd = controls.target.clone().sub(camera.position);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    return { fwd, right: new THREE.Vector3(-fwd.z, 0, fwd.x) };
  };

  /** One frame of a visit: move by the held keys, and keep the camera with you. */
  function visit(dt: number) {
    const [r, f, u] = [...held].reduce(
      (acc, k) => {
        const m = MOVE_KEYS[k];
        return [acc[0] + m[0], acc[1] + m[1], acc[2] + m[2]];
      },
      [0, 0, 0],
    );
    if (travel === "walk") {
      if (r || f) {
        const { fwd, right } = heading();
        const v = fwd
          .multiplyScalar(f)
          .add(right.multiplyScalar(r))
          .normalize()
          .multiplyScalar(me.walker.speed * dt);
        me.steer(v.x, v.z, room, obstacles);
      }
      // The camera keeps the same angle on you, wherever you walk.
      if (!tween) {
        const follow = me
          .head()
          .sub(controls.target)
          .multiplyScalar(1 - Math.exp(-dt / 0.2));
        controls.target.add(follow);
        camera.position.add(follow);
      }
    } else if (r || f || u) {
      const look = controls.target.clone().sub(camera.position).normalize();
      const right = new THREE.Vector3().crossVectors(look, camera.up).normalize();
      const v = look
        .multiplyScalar(f)
        .add(right.multiplyScalar(r))
        .add(new THREE.Vector3(0, u, 0))
        .multiplyScalar(FLY_SPEED * dt);
      camera.position.add(v);
      controls.target.add(v);
    }
  }

  /** Agents look up as the visitor comes near, and wave if they are free; the nearest is reported. */
  function noticeVisitor(t: number) {
    let nearest: { agent: string; d: number } | undefined;
    for (const [agent, c] of companions) {
      const d = Math.hypot(c.walker.place.x - me.walker.place.x, c.walker.place.z - me.walker.place.z);
      if (travel === "walk" && d < NOTICE_AT && (!nearest || d < nearest.d)) nearest = { agent, d };
      if (travel === "walk" && d < NOTICE_AT && !noticed.has(agent)) {
        noticed.add(agent);
        if (!c.walker.busy) {
          c.aim(me.head(), false, t);
          if (!shows.get(c)?.behavior.stays) c.gesture("wave", t);
        }
      } else if (d > FORGET_AT) noticed.delete(agent);
    }
    if (nearest?.agent !== near) {
      near = nearest?.agent;
      opts.onNear?.(near);
    }
  }

  renderer.setAnimationLoop((now: number) => {
    // A photo's frame, once ready, holds: the screenshot is of that moment, not a later one.
    if (readyFired && opts.still) {
      renderer.render(scene, camera);
      return;
    }
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
    // A photo's frame is posed at the gesture's best moment exactly, however late this frame came.
    const peak = PEAK[opts.still?.gesture ?? ""] ?? 0.7;
    const shoot = !!opts.still && !readyFired && gestureAt !== undefined && t - gestureAt >= peak;
    const poseAt = shoot && gestureAt !== undefined ? gestureAt + peak : t;
    const here = me.here;
    const mine = shows.get(me)?.behavior;
    const next =
      asking || opts.still || opts.visitor || mine?.stays ? undefined : me.director.decide(t, here, engaged, taken(me));
    if (typeof next === "string") go(next);
    else if (next && opts.chooseIdle) {
      // The agent picks what it does with the quiet; if it can't be asked, a random spot.
      asking = true;
      const at = here ? spotById(room, here)?.name : undefined;
      opts
        .chooseIdle(at, new Date().getHours())
        .then((cues) => {
          if (!disposed) for (const c of cues) handleCue(c);
        })
        .catch(() => {
          const pick = freeSpot(me);
          if (pick && !disposed) go(pick.id);
        })
        .finally(() => {
          asking = false;
          me.director.sent();
        });
    }
    if (!opts.still && !opts.visitor) attend(me, t, !engaged);
    if (opts.visitor) visit(dt);
    me.step(
      room,
      obstacles,
      poseAt,
      dt,
      // Thinking or speaking somewhere else — a Discord message, a room — shows here too, when the page has no turn of its own.
      state === "idle" && me.speaking(t)
        ? { state: "speaking", loudness: chatter(t) }
        : { state: state === "idle" && mine?.thinking ? "thinking" : state, loudness: loudness() },
      camera.position,
      opts.still ? { activity: stillActivity } : undefined,
    );
    // Arrived somewhere: the close-up finds its best angle again, unless the
    // person turned the view themselves a moment ago.
    if (wasBusy && !me.walker.busy && view === "close" && !tween && t - lastDragAt > 8) moveCamera(framing("close"));
    wasBusy = me.walker.busy;
    // The close-up keeps the torso in frame wherever the avatar goes, from
    // the angle the person last left the view at.
    if (view === "close" && !tween) {
      const follow = me
        .head()
        .sub(controls.target)
        .multiplyScalar(1 - Math.exp(-dt / 0.25));
      controls.target.add(follow);
      camera.position.add(follow);
    }
    // The others wander on their own, and keep an eye on the agent you are talking to.
    const meHead = me.head();
    for (const c of companions.values()) {
      const theirs = shows.get(c)?.behavior;
      if (!opts.still) {
        const move = theirs?.stays ? undefined : c.director.decide(t, c.here, false, taken(c));
        if (typeof move === "string") c.go(room, move, obstacles);
        attend(c, t, true);
      }
      const talking = c.speaking(t);
      c.step(
        room,
        obstacles,
        poseAt,
        dt,
        { state: talking ? "speaking" : theirs?.thinking ? "thinking" : "idle", loudness: talking ? chatter(t) : 0 },
        meHead,
      );
    }
    if (opts.visitor) {
      noticeVisitor(t);
      sayAloud(t);
    }
    for (const w of warm)
      if (w.fire && lit)
        w.light.intensity = (lit.lamp.on ? 1.8 : 0.9) * (0.85 + 0.15 * Math.sin(t * 9) * Math.sin(t * 3.7));
    for (let i = appearing.length - 1; i >= 0; i--) {
      const a = appearing[i];
      const k = Math.min(1, (now - a.started) / 450);
      // A little overshoot, so it pops in rather than inflates.
      const e = 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;
      a.group.scale.setScalar(a.scale * Math.max(0.01, e));
      if (k >= 1) appearing.splice(i, 1);
    }
    if (opts.still && !readyFired) {
      // Everyone in the picture, settled: animation files that never answer don't hold it forever.
      const settled = [me, ...companions.values()].every((f) => f.clipsSettled) && arriving.size === 0;
      if (settleFrom === undefined && (settled || t > 15)) settleFrom = t;
      // Time to sit down and settle; then the gesture, caught near its peak.
      if (settleFrom !== undefined && t - settleFrom > 1.6) {
        if (opts.still.gesture && gestureAt === undefined) {
          handleCue({ name: opts.still.gesture });
          gestureAt = t;
        } else if (!opts.still.gesture || shoot) {
          readyFired = true;
          opts.onReady?.();
        }
      }
    }
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
    cue: handleCue,
    setRoom(next) {
      if (next === room) return;
      const before = new Set(room.props.map((p) => p.id));
      const resized = next.width !== room.width || next.depth !== room.depth || next.height !== room.height;
      scene.remove(furniture);
      disposeTree(furniture);
      appearing.length = 0;
      room = next;
      furnish(new Set(next.props.filter((p) => !before.has(p.id)).map((p) => p.id)));
      if (lit) light(lit);
      fitShadows();
      reseat(me, () => (spotById(room, room.start) ? room.start : undefined));
      for (const c of companions.values()) reseat(c, () => freeSpot(c)?.id);
      if (resized && !tween) moveCamera(framing(view));
    },
    setCompany: meet,
    setActivities(next) {
      activities = next;
      show(self, me);
      for (const [agent, c] of companions) show(agent, c);
    },
    setTasks(next) {
      tasks = next;
      drawBoards();
    },
    setTravel(next) {
      if (!opts.visitor || next === travel) return;
      travel = next;
      held.clear();
      me.body.visible = next === "walk";
      if (next === "fly") {
        // Turn about a point just ahead, so dragging feels like turning your head.
        const look = controls.target.clone().sub(camera.position).normalize();
        controls.target.copy(camera.position).add(look.multiplyScalar(1.2));
        controls.minAzimuthAngle = Number.NEGATIVE_INFINITY;
        controls.maxAzimuthAngle = Number.POSITIVE_INFINITY;
        controls.minPolarAngle = 0.05;
        controls.maxPolarAngle = Math.PI - 0.05;
        if (near) {
          near = undefined;
          opts.onNear?.(undefined);
        }
      } else {
        moveCamera(framing("room"));
      }
    },
    setSpeech(next) {
      speech = next;
      for (const [agent, line] of Object.entries(next)) hear(agent, line);
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onHover);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      controls.dispose();
      me.dispose();
      for (const c of companions.values()) c.dispose();
      companions.clear();
      shows.clear();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
