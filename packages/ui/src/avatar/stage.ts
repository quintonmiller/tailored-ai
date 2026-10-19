/**
 * The 3D half of the avatar: a small room, lit for the time of day, with a
 * VRM model in it, moving every frame by the pose {@link Motion} computes.
 * It walks between the room's spots on its own while nobody is talking to
 * it, comes back to the middle when a session starts, and goes where you
 * click. Drag to look around; the close-up view follows the head and torso.
 * Other agents in the same room appear too, each with its own body, and
 * wander on their own. Imported only when an avatar is configured, so
 * three.js stays out of the main bundle.
 *
 * VRM is the open format for humanoid avatars: a glTF file whose skeleton,
 * mouth shapes and blink follow one standard, so any VRM model works here
 * without per-model setup.
 */
import { type VRM, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Cue } from "./cues";
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

/** The whole room, or the avatar's head and torso. */
export type StageView = "room" | "close";

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

/** A small label that floats over a companion's head, so you can tell who is who. */
function nameTag(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = "600 44px system-ui, sans-serif";
  if (ctx) ctx.font = font;
  const width = Math.ceil((ctx?.measureText(name).width ?? name.length * 24) + 48);
  canvas.width = width;
  canvas.height = 72;
  if (ctx) {
    ctx.font = font;
    ctx.fillStyle = "rgba(20, 22, 32, 0.72)";
    ctx.beginPath();
    ctx.roundRect(0, 0, width, 72, 36);
    ctx.fill();
    ctx.fillStyle = "#f2f4fa";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, width / 2, 38);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set((0.16 * width) / 72, 0.16, 1);
  sprite.renderOrder = 10;
  return sprite;
}

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
  // Things that just appeared, growing into place.
  const appearing: { group: THREE.Group; started: number; scale: number }[] = [];

  /** Build the room's shell and furniture; `fresh` names props to grow in, as just added. */
  const furnish = (fresh: Set<string> = new Set()) => {
    furniture = new THREE.Group();
    scenery.length = 0;
    clickable.length = 0;
    glows = [];
    const shell = buildShell(room);
    furniture.add(shell);
    scenery.push(shell);
    const lights: { at: THREE.Vector3; fire: boolean }[] = [];
    obstacles = [];
    for (const prop of room.props) {
      const built = buildProp(prop.kind, { color: prop.color, size: prop.size });
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
      if (prop.spot) {
        built.group.userData.spot = prop.spot;
        clickable.push(built.group);
      }
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
    // Which motion is playing, for anyone inspecting the page: "code" until animation files take over.
    onClips: () => {
      host.dataset.motion = "clips";
    },
  });
  scene.add(me.body, me.gaze);
  host.dataset.motion = "code";

  // Other agents in the room, by agent; and those still loading.
  const companions = new Map<string, Figure & { name?: string }>();
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
          }) as Figure & { name?: string };
          figure.name = still.name;
          const tag = nameTag(still.name);
          tag.position.y = figure.bounds.max.y + 0.14;
          figure.body.add(tag);
          scene.add(figure.body, figure.gaze);
          companions.set(c.agent, figure);
        })
        .catch(() => {
          arriving.delete(c.agent);
        });
    }
  };
  meet(opts.company ?? []);

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
    const next = asking || opts.still ? undefined : me.director.decide(t, here, engaged, taken(me));
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
    me.step(
      room,
      obstacles,
      poseAt,
      dt,
      { state, loudness: loudness() },
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
      if (!opts.still) {
        const move = c.director.decide(t, c.here, false, taken(c));
        if (typeof move === "string") c.go(room, move, obstacles);
      }
      c.step(room, obstacles, poseAt, dt, { state: "idle", loudness: 0 }, meHead);
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
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onHover);
      controls.dispose();
      me.dispose();
      for (const c of companions.values()) c.dispose();
      companions.clear();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
