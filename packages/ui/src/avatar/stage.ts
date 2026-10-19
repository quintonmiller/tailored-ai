/**
 * The 3D half of the avatar: a small room, lit for the time of day, with a
 * VRM model in it, moving every frame by the pose {@link Motion} computes.
 * While nobody is talking to it, it passes the time with what the room has
 * (`idle.ts`): a book at the shelf, a coffee at the sideboard, a nap late at
 * night. It comes back to the middle when a session starts, and goes where
 * you click. Drag to look around; the close-up view follows the head and
 * torso. Other agents in the same room appear too, each with its own body,
 * passing their own time. Every body shows what its agent is doing: a thing
 * in its hand, a sign over its head, its desk or the task board while it
 * works, a seat when it reads or sleeps. In a meeting room they sit at the
 * table and turn to whoever speaks. An agent that came to see one it
 * messaged stands with it, the two facing each other (`visits.ts`).
 * Imported only when an avatar is configured, so three.js stays out of the
 * main bundle.
 *
 * A stage can also be visited: the body on it is then yours, walked with the
 * arrow keys or WASD (or by clicking the floor), with the camera following,
 * nearer or further as the wheel or a pinch says; or put away to fly the
 * camera anywhere. Agents look up as you come near. A door under the pointer
 * lights up, and the page says where it goes.
 *
 * VRM is the open format for humanoid avatars: a glTF file whose skeleton,
 * mouth shapes and blink follow one standard, so any VRM model works here
 * without per-model setup.
 */
import { type VRM, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { nameOf } from "../lib/conversations";
import { aboutLines, asleepWords } from "../lib/did";
import { type BoardSpot, type BoardTask, boardAtUv, drawBoard } from "./boards";
import type { Cue } from "./cues";
import { type AgentActivity, type Behavior, behaviorFor, heldFor, hueFor, sameBehavior, stationSpot } from "./doing";
import { arrivalAt, doorFrame, doorLight, doorReached, doorTo, threshold } from "./doors";
import { Figure, loadModel } from "./figure";
import { faceToFace, sideFor } from "./greet";
import { chooseErrand, type Errand, errandAt, idleSpots, isMeeting, seeded } from "./idle";
import { inTheWay, type Obstacle, type Pick, standingIn } from "./locomotion";
import type { BodyState } from "./motion";
import { type Box, type Column, metresPerPixel, stack } from "./overhead";
import { nearestUse, type Use } from "./pick";
import { buildDoor, buildProp, buildShell, disposeTree } from "./props";
import {
  changesShown,
  DEFAULT_ROOM,
  farFor,
  type Lighting,
  type Lights,
  lightingFor,
  lookTarget,
  MIN_ASPECT,
  nearestWithin,
  OPEN_SIDES,
  ownZoom,
  type Prop,
  ROOM_TARGET,
  ROOM_VIEW,
  type Room,
  type RoomDoor,
  roomDistance,
  roomFocus,
  type Spot,
  spotById,
  spotFor,
  spreadLights,
} from "./scene";
import { blockers, FADED, FADED_WALL, type Solid, TALL, type Vec3, type Wall, wallOf, wallsBehind } from "./sight";
import {
  clampReach,
  ease,
  followDistance,
  heldMove,
  keepUp,
  MOVE_KEYS,
  pinchReach,
  REACH,
  REACH_PER_NOTCH,
  RUN_KEYS,
  type Travel,
  travelSpeed,
  VISITOR_TURN,
  WALK_SPEED,
  wheelPixels,
  wheelReach,
  widestReach,
  ZOOM_SECONDS,
} from "./travel";
import { FOLLOW_AT, keeping, standBy } from "./visits";

export type { Travel } from "./travel";

/** Something an agent said, when it said it (an ISO time; a reply can be timed to follow), and to whom. */
export interface Line {
  text: string;
  at: string;
  to?: string[];
}

/** A line older than this when it arrives was said before anyone was looking: no bubble. */
const STALE_LINE_MS = 15_000;

/** The whole room, or the avatar's head and torso. */
export type StageView = "room" | "close";

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
  /** The agent here it came to see, having messaged it directly: it stands with that one, facing it. */
  with?: string;
}

export interface Stage {
  setView(view: StageView): void;
  /**
   * Say how much of the stage is covered, in pixels: a chat panel down the
   * right, a toolbar along the top, the chat along the bottom of a phone. The
   * camera frames what is left, and what is said is kept inside it.
   */
  setInsets(insets: { right: number; top?: number; bottom?: number }): void;
  /** Walk to a spot in the room, by id. False when there is no such spot. */
  walkTo(spot: string): boolean;
  /**
   * Do what a cue from the agent says: a gesture, `go` to a place, or `look`
   * or `point` at something, or someone else in the room. One the room can't
   * make sense of is ignored.
   */
  cue(cue: { name: string; target?: string }): void;
  /**
   * Show the room as it is now: what is new appears, what is gone goes, and
   * the avatar stays where it can. `moved`, the avatar has gone to another
   * place: whoever was round it stays behind, and whoever is in the new one
   * is there already rather than coming in.
   */
  setRoom(room: Room, moved?: boolean): void;
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
  /** Light the place as a home, cosy after dark, or as a public place (the lobby, a hall), bright at any hour. */
  setLights(lights: Lights): void;
  /**
   * Come into another place through a door: the room is swapped for it, and
   * you stand just inside the door back to `from` (at its start, when it has
   * none), with your body, how you travel and the keys you hold as they were.
   * Everyone in the place you left stays there.
   */
  enter(room: Room, from: string | undefined): void;
  /**
   * Stand in front of an agent's body, facing it, at once: going straight to
   * someone from a list. When its body isn't here yet, as soon as it is. For a
   * visitor only: an agent's own view has no body of yours to move.
   */
  standBefore(agent: string): void;
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

/**
 * What a photo hangs in, in the order photos fill them (the server's
 * `PHOTO_FRAMES` says the same), and the painted part of each, which a photo
 * covers: its width, height and centre, in its own frame.
 */
const ARTS: Record<string, { width: number; height: number; y: number; z: number }> = {
  // In front of the picture's sun, which stands proud of it to 0.032.
  picture: { width: 0.82, height: 0.52, y: 0.3, z: 0.036 },
  // In front of the painting's blocks of colour, which stand proud of it to 0.031.
  painting: { width: 1.12, height: 0.72, y: 0.4, z: 0.035 },
};

/**
 * Hang a photo in a picture or a painting: a white mount over the art, the
 * photo on it, as large as fits at its own shape. Loaded from the media store;
 * a photo that can't be had leaves the art.
 */
function hangPhoto(picture: THREE.Group, kind: string, media: string) {
  const art = ARTS[kind];
  new THREE.TextureLoader().load(
    `/api/media/${encodeURIComponent(media)}`,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      const image = texture.image as { width: number; height: number };
      const aspect = image.width / Math.max(1, image.height);
      const room = { w: art.width - 0.04, h: art.height - 0.04 };
      const [w, h] = aspect > room.w / room.h ? [room.w, room.w / aspect] : [room.h * aspect, room.h];
      const mount = new THREE.Mesh(
        new THREE.PlaneGeometry(art.width, art.height),
        new THREE.MeshStandardMaterial({ color: 0xf6f3ec, roughness: 0.9 }),
      );
      mount.position.set(0, art.y, art.z);
      const photo = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({
          map: texture,
          emissive: 0xffffff,
          emissiveMap: texture,
          emissiveIntensity: 0.2,
        }),
      );
      photo.position.set(0, art.y, art.z + 0.002);
      picture.add(mount, photo);
    },
    undefined,
    () => {},
  );
}

/** Things that hang on a wall, so they are never in the way of a walk. */
const WALL_KINDS = new Set(["window", "picture", "clock", "shelf", "board", "painting", "poster", "pegboard", "sign"]);
/** Things flat on the floor, walked over. */
const FLAT_KINDS = new Set(["rug", "round_rug"]);
/** Lamps that light the room after dark, and how high their bulb is above where they stand. */
const BULBS: Partial<Record<string, number>> = { lamp: 1.45, table_lamp: 0.32 };
/** The most lamps lit at once, for the frame rate: the rest glow, but light nothing. */
const LIT_LAMPS = 4;
/** Milliseconds after coming to a place within which whoever turns up was there already, rather than coming in. */
const SETTLED_MS = 4000;
/** Seconds a body walking out may take to reach the door before it is simply gone. */
const LEAVING_SECONDS = 15;
/**
 * How much round you the walking camera takes in, as you last zoomed it: kept
 * while the page is open, through doors, by the map, and back from the agent's
 * own view, so you set it once.
 */
let reachKept = REACH.start;
/**
 * How far the chat page's view of the agent is zoomed, as last set (1 as it
 * starts, more further back): kept while the page is open, from agent to
 * agent and back from a visit.
 */
let zoomKept = 1;
/** Milliseconds the picture takes to fade out as you go through a door, and in again. */
const FADE_MS = 220;
/** How long a door waits for the place behind it before giving up and letting you back. */
const DOOR_PATIENCE_MS = 5000;
/** How often what is under a still pointer is looked at again while the view moves under it. */
const HOVER_AGAIN_MS = 120;
/** Seconds at least between one body's looks for a new way round you, while you are in its way. */
const REROUTE_SECONDS = 0.4;
/** Seconds something in the way takes to fade, or to come back once the view is clear. */
const SEE_THROUGH_SECONDS = 0.15;

/**
 * Something that can fade so a body can be seen past it: a tall thing on the
 * floor, by the box round it, or a wall, or something hanging on one, by which
 * wall. How much of it shows now, and the see-through materials it wears while
 * it is faded, in place of the ones it was built with.
 */
interface Fadeable {
  group: THREE.Object3D;
  solid?: Solid;
  wall?: Wall;
  level: number;
  own?: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
}

/** The box round something, as one that can hide a body. */
const solidOf = (box: THREE.Box3): Solid => ({ min: box.min.toArray(), max: box.max.toArray() });

/** A see-through copy of a material, which remembers how opaque the material was. */
function seeThroughCopy(m: THREE.Material): THREE.Material {
  const c = m.clone();
  c.userData.opacity = m.opacity;
  c.transparent = true;
  c.depthWrite = false;
  return c;
}

/** Draw something that can fade at how much of it shows: in see-through copies while it is faded, its own once it isn't. */
function paintFaded(f: Fadeable) {
  if (f.level >= 0.995) {
    for (const [mesh, was] of f.own ?? []) {
      for (const m of [mesh.material].flat()) m.dispose();
      mesh.material = was;
    }
    f.own = undefined;
    return;
  }
  const own = (f.own ??= new Map());
  f.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // A photo hung after it faded is put in see-through copies when it comes.
    if (!own.has(mesh)) {
      own.set(mesh, mesh.material);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(seeThroughCopy) : seeThroughCopy(mesh.material);
    }
    for (const m of [mesh.material].flat()) m.opacity = (m.userData.opacity ?? 1) * f.level;
  });
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
    /** The agent this stage shows, for its activity and its colour. */
    agent?: string;
    /** Someone clicked an agent's body (or its tag): which agent, and where on the page. */
    onPick?: (agent: string, at: { x: number; y: number }) => void;
    /** The body here is the visitor's own, moved by keys and clicks, not an agent's. */
    visitor?: boolean;
    /** The agent the visitor is standing next to, when it changes; undefined when none is. */
    onNear?: (agent: string | undefined) => void;
    /** Something made to be used was clicked: a kiosk, a task board. Its action, and on a board what was hit. */
    onUse?: (action: string, on?: BoardSpot) => void;
    /** A visitor is within earshot of an agent as it starts saying something: who, what, and how near (0–1, 1 beside it). */
    onLine?: (agent: string, text: string, nearness: number) => void;
    /** Someone went through a door (walked into it, or clicked it): the page brings the place behind it. */
    onDoor?: (door: RoomDoor) => void;
    /** The place come from, through a door: you start just inside the door back to it. */
    arriveFrom?: string;
    /** How the place is lit after dark: a home's lamps, or a public place's lights overhead. */
    lights?: Lights;
    /** The pointer came over a door (where on the page, for saying where it goes), or left the one it was over. */
    onDoorHover?: (door: RoomDoor | undefined, at?: { x: number; y: number }) => void;
    /** The controls laid over the top of the stage: what is said is kept out from under them. */
    overlays?: () => Element[];
  } = {},
): Promise<Stage> {
  // The room as the page gave it, and as drawn: with spots added by things that bring none (see `idleSpots`).
  let given = opts.room ?? DEFAULT_ROOM;
  let room = given;
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
  // How far a lamp's light goes in this room, before the hour stretches it.
  let lampReach = 5;
  // The lights those lamps and fires give, made once and moved from room to room. The renderer keeps what it works
  // out for each light for as long as it lives, so a light made for every room is never let go; and a different
  // number of lights has every material in the room compiled again. Those a room has no lamp for stay dark.
  const bulbs = Array.from({ length: LIT_LAMPS }, () => {
    const light = new THREE.PointLight(0xffc98a, 0, 5, 1.5);
    scene.add(light);
    return light;
  });
  let furniture = new THREE.Group();
  // What stands on the floor in the way: walks go round these.
  let obstacles: Obstacle[] = [];
  /** What an agent walks round: the furniture, and you, standing here in your own body, with room to pass. */
  const ways = (): Obstacle[] =>
    opts.visitor && travel === "walk"
      ? [...obstacles, standingIn([me.walker.place.x, me.walker.place.z], me.radius)]
      : obstacles;
  /** What a body walks round: everyone else's walks go round you; yours goes round the furniture. */
  const waysFor = (f: Figure) => (f === me && opts.visitor ? obstacles : ways());
  // What can fade so a body can be seen past it: tall things, the walls and what hangs on them.
  let fadeable: Fadeable[] = [];
  /** Everything faded back as it was built, before the room it is in is taken down. */
  const unfade = () => {
    for (const f of fadeable) {
      f.level = 1;
      paintFaded(f);
    }
    fadeable = [];
  };
  // Boards on the walls, each drawn with the tasks; and what they show.
  let boards: { label: string; screen: NonNullable<ReturnType<typeof buildProp>["screen"]> }[] = [];
  let tasks: BoardTask[] = [];
  // What each agent is doing: every body shows its own, and the light by a home's door its owner's.
  let activities: Record<string, AgentActivity> = {};
  const drawBoards = () => {
    for (const b of boards) {
      drawBoard(b.screen.canvas, b.label, tasks);
      b.screen.texture.needsUpdate = true;
    }
  };
  // Things that just appeared, growing into place.
  const appearing: { group: THREE.Group; started: number; scale: number }[] = [];
  // Things that were just moved, on their way from where they stood.
  const gliding: {
    group: THREE.Group;
    started: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
    turn: [number, number];
  }[] = [];
  // The doors, each with the light by it that says what the agent behind it is doing.
  let doorLights: { occupant: string; light: THREE.MeshBasicMaterial }[] = [];
  // How to light each door up while the pointer is over it, and the door it is over.
  let doorHighlights = new Map<RoomDoor, (on: boolean) => void>();
  let overDoor: RoomDoor | undefined;
  /** The pointer is over a door now (`at` on the stage), or none: it lights up, and the last one goes back. */
  const hoverDoor = (door: RoomDoor | undefined, at?: { x: number; y: number }) => {
    if (door !== overDoor) {
      if (overDoor) doorHighlights.get(overDoor)?.(false);
      if (door) doorHighlights.get(door)?.(true);
      overDoor = door;
    }
    opts.onDoorHover?.(door, door ? at : undefined);
  };
  const lightDoors = () => {
    for (const d of doorLights) {
      const { color, glow } = doorLight(activities[d.occupant]?.doing);
      d.light.color.setHex(color).multiplyScalar(glow);
    }
  };

  /** Build the room's shell and furniture; `fresh` names props to grow in, as just added, and `moved` where others were. */
  const furnish = (fresh: Set<string> = new Set(), moved: Map<string, Prop> = new Map()) => {
    furniture = new THREE.Group();
    scenery.length = 0;
    clickable.length = 0;
    glows = [];
    boards = [];
    const shell = buildShell(room);
    furniture.add(shell);
    scenery.push(shell);
    fadeable = [];
    shell.traverse((o) => {
      if (o.userData.wall) fadeable.push({ group: o, wall: o.userData.wall as Wall, level: 1 });
    });
    const lights: { at: THREE.Vector3; fire: boolean }[] = [];
    obstacles = [];
    // The photos taken here go in the pictures, newest in the first, then in the paintings.
    const photos = [...(room.photos ?? [])];
    const hung = new Map<string, string>();
    for (const kind of Object.keys(ARTS))
      for (const prop of room.props) {
        const photo = prop.kind === kind ? photos.shift() : undefined;
        if (photo) hung.set(prop.id, photo.media);
      }
    for (const prop of room.props) {
      const built = buildProp(prop.kind, { color: prop.color, size: prop.size, label: prop.label });
      if (built.screen) boards.push({ label: prop.label ?? "Tasks", screen: built.screen });
      const photo = hung.get(prop.id);
      if (photo) hangPhoto(built.group, prop.kind, photo);
      built.group.position.set(prop.at[0], prop.elevation ?? 0, prop.at[1]);
      built.group.rotation.y = rad(prop.facing);
      const scale = prop.size ? 1 : (prop.scale ?? 1);
      built.group.scale.setScalar(scale);
      // Its outline on the floor, measured from what was built, before it grows in. A tall one can hide a body.
      if (!prop.on && !WALL_KINDS.has(prop.kind) && !FLAT_KINDS.has(prop.kind)) {
        const box = new THREE.Box3().setFromObject(built.group);
        obstacles.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
        if (box.max.y >= TALL) fadeable.push({ group: built.group, solid: solidOf(box), level: 1 });
      }
      // What hangs on a wall fades with it.
      const wall = WALL_KINDS.has(prop.kind) ? wallOf(room, prop.at) : undefined;
      if (wall) fadeable.push({ group: built.group, wall, level: 1 });
      furniture.add(built.group);
      scenery.push(built.group);
      if (prop.spot) built.group.userData.spot = prop.spot;
      if (prop.action) built.group.userData.action = prop.action;
      if (prop.spot || prop.action) clickable.push(built.group);
      if (built.glow) glows.push({ kind: prop.kind, glow: built.glow });
      const bulb = BULBS[prop.kind];
      if (bulb !== undefined)
        lights.push({
          at: new THREE.Vector3(prop.at[0], (prop.elevation ?? 0) + bulb * scale, prop.at[1]),
          fire: false,
        });
      if (prop.kind === "fireplace") {
        const front = new THREE.Vector3(Math.sin(rad(prop.facing)), 0, Math.cos(rad(prop.facing))).multiplyScalar(0.45);
        lights.push({ at: new THREE.Vector3(prop.at[0], 0.4, prop.at[1]).add(front), fire: true });
      }
      if (fresh.has(prop.id) && !opts.reducedMotion) {
        built.group.scale.setScalar(scale * 0.01);
        appearing.push({ group: built.group, started: performance.now(), scale });
      }
      const was = moved.get(prop.id);
      if (was && !opts.reducedMotion) {
        const to = built.group.position.clone();
        const from = new THREE.Vector3(was.at[0], was.elevation ?? 0, was.at[1]);
        built.group.position.copy(from);
        built.group.rotation.y = rad(was.facing);
        gliding.push({
          group: built.group,
          started: performance.now(),
          from,
          to,
          turn: [rad(was.facing), rad(prop.facing)],
        });
      }
    }
    // The doors to other places: on a wall, or standing at an open side.
    doorLights = [];
    doorHighlights = new Map();
    // The door the pointer was over is gone with the room it was in.
    if (overDoor) hoverDoor(undefined);
    for (const door of room.doors ?? []) {
      const built = buildDoor(door, {
        freestanding: door.wall === "front" || door.wall === "right",
        trim: room.walls,
        height: room.height,
      });
      const { at, facing } = doorFrame(room, door);
      built.group.position.set(at[0], 0, at[1]);
      built.group.rotation.y = rad(facing);
      built.group.userData.door = door;
      furniture.add(built.group);
      scenery.push(built.group);
      clickable.push(built.group);
      // A door in a wall fades with it; one standing at an open side is a tall thing like any other.
      if (door.wall === "back" || door.wall === "left")
        fadeable.push({ group: built.group, wall: door.wall, level: 1 });
      else fadeable.push({ group: built.group, solid: solidOf(new THREE.Box3().setFromObject(built.group)), level: 1 });
      if (built.light && door.occupant) doorLights.push({ occupant: door.occupant, light: built.light });
      doorHighlights.set(door, built.highlight);
    }
    lightDoors();
    scene.add(furniture);
    // Somewhere to stand by a plant, the task board, a sideboard: worked out once what is in the way is known.
    room = { ...given, spots: [...given.spots, ...idleSpots(given, obstacles)] };
    drawBoards();
    warm.length = 0;
    // A big room's lamps reach further, so the light still meets in the middle.
    lampReach = Math.max(5, Math.hypot(room.width, room.depth) / 2.2);
    const kept = spreadLights(lights, LIT_LAMPS);
    for (const [i, light] of bulbs.entries()) {
      const l = kept[i];
      // Dark, but still there, so the number of lights stays the same.
      light.intensity = 0;
      if (!l) continue;
      light.color.setHex(l.fire ? 0xff9a50 : 0xffc98a);
      light.distance = lampReach;
      light.position.copy(l.at);
      warm.push({ light, fire: l.fire });
    }
  };
  furnish();

  // Come in through a door: just inside it, facing in, at no spot.
  const cameIn = doorTo(room, opts.arriveFrom);
  const arrival = cameIn ? arrivalAt(room, cameIn, obstacles) : undefined;
  const start: Spot | undefined = arrival
    ? { id: "", name: "", place: "", at: arrival.at, facing: (arrival.facing * 180) / Math.PI }
    : ((opts.still?.spot ? spotById(room, opts.still.spot) : undefined) ?? spotById(room, room.start) ?? room.spots[0]);
  // A photo holds still. A selfie faces the camera, sitting down if the spot is a seat.
  const selfie = !!opts.still && opts.view === "close";
  const stillActivity = opts.still && !(selfie && start?.activity !== "sit") ? start?.activity : undefined;
  const self = opts.agent || "default";

  // What each idle body is doing with its time, and whether it has got there yet.
  const errands = new Map<Figure, { errand: Errand; arrived: boolean }>();
  // A run of chances per agent, so two in one room don't do the same thing at once, and each keeps its own day.
  const chances = new Map<string, () => number>();
  const chanceFor = (agent: string) => {
    let next = chances.get(agent);
    if (!next) {
      next = seeded(`${agent}\n${new Date().toDateString()}`);
      chances.set(agent, next);
    }
    return next;
  };
  /** An errand over: eyes open again, unless it is asleep for real. */
  const stopErrand = (f: Figure) => {
    const e = errands.get(f);
    if (!e) return;
    errands.delete(f);
    if (e.errand.doze) f.doze(!!shows.get(f)?.behavior.asleep);
  };
  /** Something to do next for an idle body: where it goes, and how long it stays once there. */
  const pickFor =
    (agent: string, figure: () => Figure | undefined) =>
    (here: string, busy?: ReadonlySet<string>): Pick | undefined => {
      const f = figure();
      if (!f) return undefined;
      const last = errands.get(f)?.errand.id;
      stopErrand(f);
      const next = chooseErrand(room, { hour: hourNow(), random: chanceFor(agent), last, here, taken: busy });
      if (!next) return undefined;
      errands.set(f, { errand: next, arrived: false });
      return { spot: next.spot, stay: next.seconds };
    };
  /** What a body's errand has it doing where it stands, once it is there, for its pose. */
  const errandHere = (f: Figure): { activity: Errand["activity"] } | undefined => {
    const e = errands.get(f);
    return e?.arrived && f.here === e.errand.spot ? { activity: e.errand.activity } : undefined;
  };
  const pickMine = opts.visitor || opts.still ? undefined : pickFor(self, (): Figure | undefined => me);

  const me: Figure = new Figure(vrm, room, start, {
    reducedMotion: opts.reducedMotion,
    animations: opts.animations,
    agentChooses: !!opts.chooseIdle,
    ...(pickMine ? { pick: pickMine } : {}),
    ...(selfie && start && start.activity !== "sit" ? { facing: 0.5 } : {}),
    hue: hueFor(opts.agent ?? "default"),
    // Your own body walks briskly and turns on the spot, whatever its size; the agents keep their own calmer pace.
    ...(opts.visitor ? { pace: WALK_SPEED, turn: VISITOR_TURN, runs: true } : {}),
    // Which motion is playing, for anyone inspecting the page: "code" until animation files take over.
    onClips: () => {
      host.dataset.motion = "clips";
    },
  });
  scene.add(me.body, me.gaze);
  if (arrival) me.placeAt(arrival.at, arrival.facing);
  host.dataset.motion = "code";

  // Other agents in the room, by agent, with who each came to see here, if anyone; and those still loading.
  const companions = new Map<string, Figure & { name?: string; with?: string }>();
  // What each body is showing of what its agent is doing.
  const shows = new Map<Figure, { behavior: Behavior; doing?: string; checked: number; faced: number }>();
  // The last line of each agent's that has been shown, by its time, so a line shows once.
  const heard = new Map<string, string>();
  // Lines about to be said, for a visitor to hear when they start.
  let voices: { agent: string; text: string; at: number }[] = [];
  const arriving = new Set<string>();
  // Bodies on their way out through the door, until they get there.
  const departing: { fig: Figure; from: number }[] = [];
  // When the stage came to the place it shows, and which place that is, counted: see `meet`.
  let placedAt = performance.now();
  let placeGen = 0;
  let wanted: Companion[] = [];
  /**
   * An agent you came to see whose body is still on its way: you stand in
   * front of it once it is here. Only one this place is expecting, only while
   * it still is (`meet`), and only until you set off on your own.
   */
  let greeting: string | undefined;

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
  /** Where someone arriving appears: at a free seat round the table in a meeting room, anywhere free elsewhere. */
  const arrivalSpot = (): Spot | undefined => {
    const busy = taken();
    const seats = isMeeting(room) ? room.spots.filter((s) => /^seat-\d+$/.test(s.id) && !busy.has(s.id)) : [];
    return seats.length ? seats[Math.floor(Math.random() * seats.length)] : freeSpot();
  };
  // Who keeps whom company here, by agent (see `keeping`); where each visitor stands, or is walking to stand;
  // and when each body last looked to its company.
  let kept = new Map<string, string>();
  const standing = new Map<Figure, [number, number]>();
  const facedAt = new Map<Figure, number>();
  const rekeep = () => {
    const was = kept;
    kept = keeping(
      [...companions].map(([agent, c]): [string, string | undefined] => [agent, c.with]),
      new Set([self, ...companions.keys()]),
    );
    // Company gone: nowhere it stands for them, and, standing at a spot, back to what it faces there. One that got
    // up to meet its visitor is at no spot, and goes on to one once it has stopped (see `drift`).
    for (const agent of was.keys()) {
      const f = kept.has(agent) ? undefined : figureOf(agent);
      if (!f || (f === me && opts.visitor)) continue;
      standing.delete(f);
      if (f.here && f.seated < 0.05 && !opts.still) f.go(room, f.here, waysFor(f));
    }
  };
  /** At a spot with something to do there: a line said to it turns its head, not the whole of it. */
  const busyAt = (f: Figure) => !!f.here && !!spotById(room, f.here)?.activity;
  /**
   * A body standing at no spot, with nobody to keep company and nothing to
   * walk to, goes to a free one: the wandering, errands and asking what to do
   * all start from a spot.
   */
  const drift = (f: Figure) => {
    if (f.current !== undefined || f.moving) return;
    const spot = freeSpot(f);
    if (!spot) return;
    if (f === me) go(spot.id);
    else f.go(room, spot.id, ways());
  };
  /** Where `f` stands to talk to `partner`, coming from `from` (where it is, when not given): clear of everyone else. */
  const standFor = (f: Figure | undefined, partner: Figure, from?: [number, number]) => {
    const others: [number, number][] = [];
    for (const g of [me, ...companions.values()])
      if (g !== f && g !== partner) others.push(standing.get(g) ?? [g.walker.place.x, g.walker.place.z]);
    return standBy(room, obstacles, [partner.walker.place.x, partner.walker.place.z], {
      from: from ?? (f ? [f.walker.place.x, f.walker.place.z] : undefined),
      others,
    });
  };
  /** A visitor goes over to stand with the one it came to see. */
  const joinUp = (f: Figure, partner: Figure) => {
    const spot = standFor(f, partner);
    standing.set(f, spot.at);
    f.goTo(room, spot.at, waysFor(f));
  };
  /**
   * Every few seconds, a body keeping someone company turns to them; a
   * visitor whose company has moved off walks over to it again. One sitting
   * about when its visitor comes up gets up to stand with it, face to face,
   * unless it is at a meeting table, where everyone keeps their seat.
   */
  const keepCompany = (f: Figure, partnerAgent: string, visitor: boolean, t: number) => {
    const partner = figureOf(partnerAgent);
    if (!partner || t - (facedAt.get(f) ?? Number.NEGATIVE_INFINITY) < 2 || f.moving) return;
    facedAt.set(f, t);
    const apart = Math.hypot(partner.walker.place.x - f.walker.place.x, partner.walker.place.z - f.walker.place.z);
    if (visitor && apart > FOLLOW_AT && !partner.moving) joinUp(f, partner);
    else if (!visitor && f.seated > 0.05 && !partner.moving && apart <= FOLLOW_AT && !isMeeting(room)) {
      // Idle, or talking with its visitor: up it gets. Asleep it sleeps on, and busy with something else it carries on.
      const b = shows.get(f)?.behavior;
      if (!b?.stays || b.face === partnerAgent) joinUp(f, partner);
      else f.face(partner.head(), t);
    } else f.face(partner.head(), t, !visitor && !!shows.get(f)?.behavior.stays && busyAt(f));
  };

  /** The agent you talk to goes somewhere; anyone already there makes room. */
  const go = (id: string) => {
    for (const c of companions.values()) {
      if (c.current !== id) continue;
      const elsewhere = freeSpot(c);
      if (elsewhere && elsewhere.id !== id) c.go(room, elsewhere.id, ways());
    }
    return me.go(room, id, waysFor(me));
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
    for (const w of warm) {
      w.light.intensity = w.fire ? (l.lamp.on ? 1.8 : 0.9) : l.lamp.on ? l.lamp.intensity : 0;
      w.light.distance = lampReach * (l.lamp.reach ?? 1);
    }
    for (const { kind, glow } of glows) {
      if (kind === "lamp" || kind === "table_lamp") glow.emissiveIntensity = l.lamp.on ? 0.9 : 0;
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
  let lights: Lights = opts.lights ?? "home";
  light(lightingFor(hour, lights));

  const camera = new THREE.PerspectiveCamera(ROOM_VIEW.fov, 1, 0.05, farFor(room));
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

  /** How a visitor gets around: walking their body, with the camera following, or flying the camera. */
  let travel: Travel = "walk";
  /** Pixels of the stage covered by something laid over it: a chat panel on the right, a toolbar, a phone's chat below. */
  let insetRight = 0;
  let insetTop = 0;
  let insetBottom = 0;
  /** The stage's size in pixels, as of the last resize: read every frame, so not asked of the page every frame. */
  let stageW = Math.max(1, host.clientWidth);
  let stageH = Math.max(1, host.clientHeight);
  /** Where the controls over the stage are, in pixels from its top left, as last measured. */
  let covered: Box[] = [];
  const measureOverlays = () => {
    const box = host.getBoundingClientRect();
    covered = (opts.overlays?.() ?? [])
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        left: r.left - box.left,
        right: r.right - box.left,
        top: r.top - box.top,
        bottom: r.bottom - box.top,
      }));
  };
  /** The shape of the part of the stage that can be seen: framing fits the room into that. */
  const visibleAspect = () =>
    Math.max(MIN_ASPECT, (stageW - insetRight) / Math.max(1, stageH - insetTop - insetBottom));
  /** The share of the stage's height that can be seen, between the toolbar and a phone's chat: framing fits into it. */
  const visibleTall = () => Math.min(1, Math.max(0.2, (stageH - insetTop - insetBottom) / stageH));
  /** How far back the camera following a visitor sits: the reach they zoomed to, in what can be seen of this room. */
  const followBack = () =>
    followDistance(clampReach(reachKept, widestReach(room)), visibleAspect(), ROOM_VIEW.fov, visibleTall());

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
    // A photo shows the whole room; a visitor's camera follows them, as far back as they zoomed it; the chat page's
    // view stays near the agent, as near as it was zoomed.
    const focus =
      opts.visitor || opts.still
        ? undefined
        : roomFocus(room, visibleAspect(), me.walker.place, zoomKept, visibleTall());
    const target = opts.visitor ? me.head() : new THREE.Vector3(...(focus?.target ?? ROOM_TARGET));
    const distance = opts.visitor
      ? followBack()
      : (focus?.distance ?? roomDistance(room, visibleAspect(), visibleTall()));
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
  // How far the picture is shifted left and up, in pixels: half the covered strip on each side, so the scene is
  // centred in the part of the stage nothing is laid over. A panel opening or closing eases it there, rather than
  // jumping.
  let shift: [number, number] = [0, 0];
  let framed = false;
  const wantShift = (): [number, number] => [
    insetRight > 0 && insetRight < stageW ? insetRight / 2 : 0,
    insetTop + insetBottom < stageH ? (insetBottom - insetTop) / 2 : 0,
  ];
  const project = () => {
    if (Math.abs(shift[0]) > 0.5 || Math.abs(shift[1]) > 0.5)
      camera.setViewOffset(stageW, stageH, shift[0], shift[1], stageW, stageH);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  const resize = () => {
    stageW = Math.max(1, host.clientWidth);
    stageH = Math.max(1, host.clientHeight);
    renderer.setSize(stageW, stageH, false);
    camera.aspect = stageW / stageH;
    measureOverlays();
    if (!framed || opts.reducedMotion) shift = wantShift();
    project();
    // A visitor's camera eases to its distance each frame (`frameUp`); flying, it stays where it was flown.
    if (tween || opts.visitor) return;
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
  framed = true;

  /**
   * Each frame: the picture's shift eases toward what the covered strip asks
   * for, and a walking visitor's camera toward how far back it should be, for
   * the reach they zoomed to and the part of the stage that can be seen.
   */
  function frameUp(dt: number) {
    const want = wantShift();
    if (shift[0] !== want[0] || shift[1] !== want[1]) {
      shift = opts.reducedMotion
        ? want
        : [ease(shift[0], want[0], dt, ZOOM_SECONDS), ease(shift[1], want[1], dt, ZOOM_SECONDS)];
      project();
    }
    if (!opts.visitor || travel !== "walk" || tween) return;
    const offset = camera.position.clone().sub(controls.target);
    const now = offset.length();
    if (now < 1e-6) return;
    const back = opts.reducedMotion ? followBack() : ease(now, followBack(), dt, ZOOM_SECONDS);
    camera.position.copy(controls.target).add(offset.setLength(back));
    // Zoomed right out in a narrow strip, the far side of the room is further than the room's own view ever goes.
    const far = back + Math.hypot(room.width, room.depth, room.height);
    if (far > camera.far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  /** Zoom the walking camera to a reach, kept for the rest of the page's life. */
  const zoomTo = (reach: number) => {
    reachKept = reach;
  };
  /** The chat page's view of the agent, which the wheel and a pinch bring nearer or take further back. */
  const ownView = () => !opts.visitor && !opts.still && view === "room";
  const onWheel = (e: WheelEvent) => {
    if (ownView()) {
      e.preventDefault();
      zoomKept = ownZoom(zoomKept * REACH_PER_NOTCH ** (wheelPixels(e) / 100), room, visibleAspect(), visibleTall());
      return;
    }
    // Flying, the controls' own zoom moves you along the way you look.
    if (!opts.visitor || travel !== "walk") return;
    e.preventDefault();
    const widest = widestReach(room);
    zoomTo(wheelReach(clampReach(reachKept, widest), wheelPixels(e), widest));
  };
  // Fingers on the stage, by pointer, for a pinch; and whether this touch has been one, so it isn't a tap as well.
  const touches = new Map<number, [number, number]>();
  let apart = 0;
  let pinched = false;
  const spread = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  };
  /**
   * Two fingers down, walking: a pinch, which zooms and nothing else. The
   * controls would go on turning the view with the first finger, so turning
   * waits until a finger is lifted.
   */
  const pinching = () => {
    const now = touches.size === 2 && ((!!opts.visitor && travel === "walk") || ownView());
    controls.enableRotate = !now;
    return now;
  };
  const onTouch = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (!pinching()) return;
    pinched = true;
    const now = spread();
    const widest = widestReach(room);
    if (apart > 0 && now > 0) {
      if (ownView()) zoomKept = ownZoom((zoomKept * apart) / now, room, visibleAspect(), visibleTall());
      else zoomTo(pinchReach(clampReach(reachKept, widest), apart, now, widest));
    }
    apart = now;
  };
  const untouch = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    apart = spread();
    pinching();
    if (!touches.size) pinched = false;
  };

  // A click (not a drag) on furniture sends the avatar to its spot; the
  // pointer says so on hover.
  const canvas = renderer.domElement;
  /** Where a pointer is, on the page. */
  type At = { clientX: number; clientY: number };
  const ray = new THREE.Raycaster();
  /**
   * The nearest clickable thing under the pointer, and what it is for: a
   * door, a use (a kiosk, a board) or a spot to go to. On a board's face, the
   * note or column the pointer is on as well.
   */
  const pick = (e: At): (Use & { on?: BoardSpot }) | undefined => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    const found = nearestUse(ray.intersectObjects(clickable, true));
    if (!found) return undefined;
    const { hit, use } = found;
    const board = use.action ? boards.find((b) => b.screen.face === hit.object) : undefined;
    if (!board || !hit.uv) return use;
    const { width, height } = board.screen.canvas;
    return { ...use, on: boardAtUv(width, height, tasks, hit.uv.x, hit.uv.y) };
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
  const agentAt = (e: At): string | undefined => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    // A visitor's own body is nobody's to open a menu on.
    const bodies = new Map<THREE.Object3D, string>(opts.visitor ? [] : [[me.body, self]]);
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
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      apart = spread();
      pinching();
    }
  };
  const onUp = (e: PointerEvent) => {
    const moved = downAt ? Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) : Infinity;
    downAt = null;
    const pinch = pinched;
    untouch(e);
    if (moved > 6 || pinch) return;
    // An agent first: a body stands in front of the furniture it is at.
    const who = opts.onPick ? agentAt(e) : undefined;
    if (who) {
      opts.onPick?.(who, { x: e.clientX, y: e.clientY });
      return;
    }
    const it = pick(e);
    if (it?.action && opts.onUse) {
      opts.onUse(it.action, it.on);
      return;
    }
    if (it?.door && opts.onDoor) {
      leave(it.door);
      return;
    }
    if (it?.spot) go(it.spot);
    else if (opts.visitor && travel === "walk") {
      const to = floorAt(e);
      if (to) {
        greeting = undefined;
        me.goTo(room, to, obstacles);
      }
    }
  };
  // Where the mouse is over the stage, so what is under it is looked at again as the view moves under a still pointer.
  let pointer: At | undefined;
  const onHover = (e: PointerEvent) => {
    if (downAt || e.pointerType !== "mouse") return;
    pointer = { clientX: e.clientX, clientY: e.clientY };
    hoverAt(pointer);
  };
  /** What is under the pointer now: a body's tag says more, a door lights up and says where it goes. */
  const hoverAt = (e: At) => {
    const who = agentAt(e);
    if (who !== hovered) hover(who);
    const it = pick(e);
    // A body stands in front of a door; the door behind it isn't what the pointer is on.
    const door = !who && !leaving && opts.onDoor ? it?.door : undefined;
    const box = canvas.getBoundingClientRect();
    hoverDoor(door, { x: e.clientX - box.left, y: e.clientY - box.top });
    canvas.style.cursor = (opts.onPick && who) || it?.spot || (it?.action && opts.onUse) || door ? "pointer" : "";
  };
  /** The pointer is over a body now, or none: its tag says more, and the last one's goes back. */
  const hover = (who: string | undefined) => {
    const was = hovered;
    hovered = who;
    // For anyone inspecting the page, like `data-motion`: whose tag is saying more.
    host.dataset.hovered = who ?? "";
    for (const agent of [was, who]) {
      const f = agent ? figureOf(agent) : undefined;
      if (agent && f) show(agent, f);
    }
  };
  const onLeave = () => {
    pointer = undefined;
    hover(undefined);
    hoverDoor(undefined);
  };
  // Walking, the camera easing or zooming, or someone stepping in front of a door all change what is under a pointer
  // that hasn't moved: it is looked at again, a few times a second, while the view moves or something is lit.
  const seen = new THREE.Matrix4();
  let lookedAt = 0;
  const lookAgain = (now: number) => {
    if (!pointer || downAt || now - lookedAt < HOVER_AGAIN_MS) return;
    const moved = !seen.equals(camera.matrixWorld);
    if (!moved && !overDoor && !hovered) return;
    lookedAt = now;
    seen.copy(camera.matrixWorld);
    hoverAt(pointer);
  };

  // Going through a door: the picture fades, the page brings the place behind it, and `enter` fades it back in.
  canvas.style.transition = opts.reducedMotion ? "" : `opacity ${FADE_MS}ms ease`;
  let leaving: { door: RoomDoor; giveUp: ReturnType<typeof setTimeout> } | undefined;
  const fadeIn = () => {
    if (leaving) clearTimeout(leaving.giveUp);
    leaving = undefined;
    canvas.style.opacity = "1";
  };
  function leave(door: RoomDoor) {
    if (leaving || !opts.onDoor) return;
    hoverDoor(undefined);
    // Nothing came back in time: you are still here, and can try again.
    leaving = { door, giveUp: setTimeout(fadeIn, DOOR_PATIENCE_MS) };
    canvas.style.opacity = "0";
    setTimeout(
      () => {
        if (!disposed) opts.onDoor?.(door);
      },
      opts.reducedMotion ? 0 : FADE_MS,
    );
  }
  // Come in through a door: from dark.
  if (arrival) {
    canvas.style.opacity = "0";
    requestAnimationFrame(() => requestAnimationFrame(fadeIn));
  }
  // A visitor's keys: held keys move them every frame, unless they are typing or working in a panel over the stage.
  const held = new Set<string>();
  const typing = (e: KeyboardEvent) =>
    (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog']");
  // Keys held through a door, until they are let go: the view faces the same way on the other side, so holding W
  // into a door at the back would otherwise walk you straight back out of the one you came in by.
  const waiting = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    const run = RUN_KEYS.has(e.code);
    if (!opts.visitor || !(run || e.code in MOVE_KEYS) || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    // Shift alone does nothing in the page to keep from it, so it is only listened to.
    if (!run) e.preventDefault();
    if (!waiting.has(e.code)) held.add(e.code);
    if (!run) greeting = undefined;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    held.delete(e.code);
    waiting.delete(e.code);
  };
  const onBlur = () => {
    held.clear();
    waiting.clear();
  };
  if (opts.visitor) {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    // Free to look all the way round. Walking, the wheel and a pinch zoom the camera following you (`onWheel`).
    controls.enableZoom = false;
  }
  // Agents who have noticed the visitor, until the visitor walks away.
  const noticed = new Set<string>();
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", untouch);
  canvas.addEventListener("pointermove", onHover);
  canvas.addEventListener("pointermove", onTouch);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  let disposed = false;
  let asking = false;
  let readyFired = false;
  let settleFrom: number | undefined;
  let gestureAt: number | undefined;
  let wasBusy = false;
  let tagsAt = 0;
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
    // A body with a tag has its name in the bubble: the tag is put away while it speaks.
    f.say(line.text, at, f === me ? undefined : companions.get(agent)?.name);
    if (opts.visitor && opts.onLine && f !== me) voices.push({ agent, text: line.text, at });
    // Said to someone here: the two turn to each other.
    for (const name of line.to ?? []) {
      const g = figureOf(name) ?? companionNamed(name);
      if (!g || g === f) continue;
      if (!f.walker.busy) f.face(g.head(), at, busyAt(f));
      if (!g.walker.busy && !(g === me && opts.visitor)) g.face(f.head(), at, busyAt(g));
    }
    // Round a meeting table, everyone turns to whoever is speaking.
    if (isMeeting(room))
      for (const g of [me, ...companions.values()])
        if (g !== f && !(g === me && opts.visitor) && !g.walker.busy) g.aim(f.head(), false, at);
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

  // Whose tag says more: the body under the pointer, and the one a visitor stands next to.
  let hovered: string | undefined;
  let near: string | undefined;
  const closeTo = (agent: string) => !opts.still && (agent === hovered || agent === near);

  /**
   * Show on a body what its agent is doing now: its sign, its tag, how it
   * sleeps; a gesture as it starts. Come close, and an idle agent's tag says
   * what it is up to, what it did last and when it next wakes; a sleeping
   * one's, why and until when.
   */
  function show(agent: string, f: Figure & { name?: string }) {
    const activity = opts.still ? undefined : activities[agent];
    const behavior = behaviorFor(activity);
    const was = shows.get(f);
    const close = closeTo(agent) && !(f === me && opts.visitor);
    // Come to see someone here, and with nothing else to say: talking with them, as the map has it.
    const visiting = f === me ? undefined : companions.get(agent)?.with;
    const status = behavior.label
      ? close && activity?.doing === "asleep"
        ? `asleep · ${asleepWords(activity)}`
        : behavior.detail
          ? `${behavior.label} · ${behavior.detail}`
          : behavior.label
      : visiting
        ? `talking with ${nameOf(visiting)}`
        : close
          ? (errands.get(f)?.errand.label ?? "idle")
          : undefined;
    // The agent you talk to needs no name; the others always show theirs.
    f.label(f === me ? (opts.visitor ? "you" : undefined) : f.name, status, close ? aboutLines(activity) : []);
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
   * (not a laptop, at a desk — it types there), go to its desk, the task
   * board or a seat when one is free and nothing else has it walking, and
   * turn to whoever it is talking to when they are here. Idle and free, its
   * time is its own: whatever it is doing with it, at the spot it went to.
   */
  const attend = (f: Figure, agent: string, t: number, free: boolean) => {
    const s = shows.get(f);
    const b = s?.behavior;
    const spot = f.here ? spotById(room, f.here) : undefined;
    let e = errands.get(f);
    // Sent somewhere else, or busy now: whatever it was doing with its time is over.
    const own = free && !b?.stays;
    if (e && (!own || (f.current !== e.errand.spot && f.pending !== e.errand.spot))) {
      stopErrand(f);
      e = undefined;
    }
    // At a spot it went to some other way (put there, sent by a cue): something to do there.
    if (!e && own && f.here) {
      const found = errandAt(room, f.here, hourNow(), chanceFor(agent));
      if (found) errands.set(f, (e = { errand: found, arrived: false }));
    }
    if (e && !e.arrived && f.here === e.errand.spot) {
      e.arrived = true;
      if (e.errand.gesture) f.gesture(e.errand.gesture, t);
      if (e.errand.doze) f.doze(true);
    }
    const partner = b?.face ? figureOf(b.face) : undefined;
    const held = heldFor(b, { spotActivity: spot?.activity, partnerHere: !!partner && partner !== f });
    const errandHold = e?.arrived ? e.errand.hold : undefined;
    if (held.prop) f.hold(held.prop, held.hold);
    else f.hold(errandHold?.prop, errandHold?.how);
    if (!s || !b) return;
    // In a meeting room everyone keeps their seat at the table: nobody leaves it for a desk to think at.
    const station = isMeeting(room) && b.station !== "seat" ? undefined : b.station;
    if (station && free && t - s.checked > 1.5 && !f.walker.busy && !f.pending) {
      s.checked = t;
      const to = stationSpot(
        station,
        room.spots,
        { x: f.walker.place.x, z: f.walker.place.z, spotActivity: spot?.activity, ...(f.here ? { spot: f.here } : {}) },
        taken(f),
      );
      if (to) {
        if (f === me) go(to.id);
        else f.go(room, to.id, ways());
      }
    }
    if (partner && partner !== f && t - s.faced > 3 && !f.walker.busy) {
      s.faced = t;
      f.aim(partner.head(), false, clock);
    }
  };

  /** The way in and out for agents coming and going: the threshold of the room's first door, when it has one. */
  const doorway = () => (room.doors?.[0] ? threshold(room, room.doors[0]) : undefined);

  /**
   * Bring the company in line with who should be here. Whoever is here when
   * you arrive is already about; anyone who comes later walks in through the
   * door, and anyone who leaves walks out through it, when the room has one.
   */
  const meet = (company: Companion[]) => {
    wanted = company;
    const ids = new Set(company.map((c) => c.agent));
    // The agent you came to see has gone before its body got here: you aren't sent to it if it comes back later.
    if (greeting && !ids.has(greeting)) greeting = undefined;
    const way = opts.still ? undefined : doorway();
    for (const [agent, fig] of companions) {
      if (ids.has(agent)) continue;
      errands.delete(fig);
      shows.delete(fig);
      standing.delete(fig);
      facedAt.delete(fig);
      companions.delete(agent);
      // Gone home, or somewhere else: out through the door, or simply gone from a room without one.
      if (!way) {
        fig.dispose();
        continue;
      }
      fig.doze(false);
      fig.label(fig.name, undefined);
      fig.goTo(room, way.at, ways());
      departing.push({ fig, from: clock });
    }
    // Arriving after the stage has settled in this place is coming in; any sooner, it was here already.
    const coming = !opts.still && performance.now() - placedAt > SETTLED_MS;
    const gen = placeGen;
    for (const c of company) {
      const fig = companions.get(c.agent);
      if (fig) {
        fig.name = c.name;
        // Here already, and now come to see someone here: over to them.
        if (fig.with !== c.with) {
          fig.with = c.with;
          standing.delete(fig);
          const partner = c.with ? figureOf(c.with) : undefined;
          if (partner && !opts.still) joinUp(fig, partner);
        }
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
          const entrance = coming && gen === placeGen ? doorway() : undefined;
          // Come to see someone here: it stands with them, from the side it comes in; anyone else takes a seat.
          const partner = still.with ? figureOf(still.with) : undefined;
          const stand = partner ? standFor(undefined, partner, entrance?.at) : undefined;
          const seat = stand ? undefined : arrivalSpot();
          const start = entrance
            ? { id: "", name: "", place: "", at: entrance.at, facing: (entrance.facing * 180) / Math.PI }
            : stand
              ? { id: "", name: "", place: "", at: stand.at, facing: (stand.facing * 180) / Math.PI }
              : seat;
          const figure = new Figure(model, room, start, {
            reducedMotion: opts.reducedMotion,
            animations: still.animations,
            hue: hueFor(c.agent),
            ...(opts.still ? {} : { pick: pickFor(c.agent, () => companions.get(c.agent)) }),
          }) as Figure & { name?: string; with?: string };
          figure.name = still.name;
          figure.with = still.with;
          scene.add(figure.body, figure.gaze);
          companions.set(c.agent, figure);
          rekeep();
          show(c.agent, figure);
          // The agent you came to see: you stand in front of it now that it is here.
          if (greeting === c.agent) standBefore(c.agent);
          // In through the door, and on to whoever it came to see, or somewhere free.
          if (stand) standing.set(figure, stand.at);
          if (entrance && stand) figure.goTo(room, stand.at, ways());
          else if (entrance && seat) figure.go(room, seat.id, ways());
          // What brought it here may be what it just said, in the room it came to say it in: that shows. Anything
          // older than a moment is old news, which `hear` leaves out.
          hear(c.agent, speech[c.agent]);
        })
        .catch(() => {
          arriving.delete(c.agent);
        });
    }
    rekeep();
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
      if (to) f.go(room, to, waysFor(f));
    } else if (f.currentAt && Math.hypot(spot.at[0] - f.currentAt[0], spot.at[1] - f.currentAt[1]) > 0.05) {
      // A walk from a spot to itself goes nowhere: from here, as if between spots.
      f.current = undefined;
      f.go(room, spot.id, waysFor(f));
    }
  };

  /** Flying: turn about a point just ahead, so dragging feels like turning your head, any way round. */
  function turnAboutAhead() {
    const look = controls.target.clone().sub(camera.position).normalize();
    controls.target.copy(camera.position).add(look.multiplyScalar(1.2));
    controls.minAzimuthAngle = Number.NEGATIVE_INFINITY;
    controls.maxAzimuthAngle = Number.POSITIVE_INFINITY;
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = Math.PI - 0.05;
    controls.update();
  }

  /** The camera's heading on the floor, and its right, for keys that move relative to the view. */
  const heading = () => {
    const fwd = controls.target.clone().sub(camera.position);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    return { fwd, right: new THREE.Vector3(-fwd.z, 0, fwd.x) };
  };

  /** The way the held keys push your body this frame, walking; undefined when none are held. */
  let pushing: [number, number] | undefined;
  /** One frame of a visit: move by the held keys, at a run while Shift is held. */
  function visit(dt: number) {
    const { right: r, forward: f, up: u, running } = heldMove(held);
    const speed = travelSpeed(travel, running) * dt;
    pushing = undefined;
    if (travel === "walk") {
      if (r || f) {
        const { fwd, right } = heading();
        const v = fwd.multiplyScalar(f).add(right.multiplyScalar(r)).normalize().multiplyScalar(speed);
        me.steer(v.x, v.z, room, obstacles);
        pushing = [v.x, v.z];
      }
    } else if (r || f || u) {
      const look = controls.target.clone().sub(camera.position).normalize();
      const right = new THREE.Vector3().crossVectors(look, camera.up).normalize();
      const v = look
        .multiplyScalar(f)
        .add(right.multiplyScalar(r))
        .add(new THREE.Vector3(0, u, 0))
        .multiplyScalar(speed);
      camera.position.add(v);
      controls.target.add(v);
    }
  }

  /** Where your body stood last frame, so the camera moves exactly as far as you did. */
  let lastAt: [number, number] = [me.walker.place.x, me.walker.place.z];

  /** Face to face with an agent, at once, clear of the furniture: see `Stage.standBefore`. */
  function standBefore(agent: string) {
    if (!opts.visitor) return;
    const f = companions.get(agent);
    if (!f) {
      // Not here and not coming (it left before you got here, or the map was behind): nobody to wait for.
      greeting = wanted.some((c) => c.agent === agent) ? agent : undefined;
      return;
    }
    greeting = undefined;
    const p = f.walker.place;
    const to = faceToFace(room, obstacles, [p.x, p.z], sideFor(p.facing, OPEN_SIDES));
    me.placeAt(to.at, to.facing);
    lastAt = [to.at[0], to.at[1]];
    // The same view as on arriving anywhere, centred on where you now stand.
    tween = null;
    const shot = framing("room");
    const shift = me.head().sub(shot.target);
    shot.target.add(shift);
    shot.position.add(shift);
    settle(shot);
    if (travel === "fly") turnAboutAhead();
  }

  /**
   * The camera keeps the same angle on you, wherever you walk: it moves with
   * your body each frame, after the body has moved, so it never trails behind.
   */
  function keepWithYou(dt: number) {
    const p = me.walker.place;
    const moved: [number, number, number] = [p.x - lastAt[0], 0, p.z - lastAt[1]];
    lastAt = [p.x, p.z];
    // Walked into a door, or pressing on toward it where the wall stopped you: through it.
    const through =
      travel === "walk" && !leaving ? doorReached(room, [p.x, p.z], [moved[0], moved[2]], pushing) : undefined;
    if (through) leave(through);
    if (tween || travel !== "walk") return;
    const head = me.head();
    const t = controls.target;
    const step = new THREE.Vector3(...keepUp([t.x, t.y, t.z], [head.x, head.y, head.z], moved, dt));
    controls.target.add(step);
    camera.position.add(step);
  }

  // When each body last found a new way round you, so it looks again only a few times a second.
  const rerouted = new WeakMap<Figure, number>();
  /**
   * An agent on its way somewhere, whose way you have stepped into (or who
   * set off before you were there), goes round you instead.
   */
  function giveWay(t: number) {
    if (travel !== "walk") return;
    const you: [number, number] = [me.walker.place.x, me.walker.place.z];
    for (const f of [...companions.values(), ...departing.map((d) => d.fig)]) {
      if (!f.walker.way.length || t - (rerouted.get(f) ?? Number.NEGATIVE_INFINITY) < REROUTE_SECONDS) continue;
      const here: [number, number] = [f.walker.place.x, f.walker.place.z];
      if (!inTheWay(here, f.walker.way, you, me.radius + f.radius + 0.1)) continue;
      rerouted.set(f, t);
      f.reroute(room, ways());
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
      const was = near;
      near = nearest?.agent;
      opts.onNear?.(near);
      for (const agent of [was, near]) {
        const f = agent ? figureOf(agent) : undefined;
        if (agent && f) show(agent, f);
      }
    }
  }

  /**
   * Each frame, a tall thing between the camera and anyone's head or chest
   * fades to a ghost of itself, and so does a wall the camera has gone round
   * behind, with what hangs on it; each comes back once the view is clear.
   */
  function seeThrough(dt: number) {
    if (!fadeable.length) return;
    const eye: Vec3 = [camera.position.x, camera.position.y, camera.position.z];
    const targets: Vec3[] = [];
    for (const f of [me, ...companions.values()]) {
      // Flying, your body is put away: nothing need fade for it.
      if (f === me && opts.visitor && travel !== "walk") continue;
      const head = f.head();
      const feet = f.body.position.y;
      targets.push([head.x, head.y, head.z], [head.x, feet + (head.y - feet) * 0.6, head.z]);
    }
    const tall = fadeable.filter((f) => f.solid);
    const inWay = blockers(
      tall.map((f) => f.solid as Solid),
      eye,
      targets,
    );
    const hiding = new Set([...inWay].map((i) => tall[i]));
    const behind = wallsBehind(room, eye);
    for (const f of fadeable) {
      const want = f.wall ? (behind.has(f.wall) ? FADED_WALL : 1) : hiding.has(f) ? FADED : 1;
      if (f.level === want && want < 1 === !!f.own) continue;
      f.level = opts.reducedMotion ? want : ease(f.level, want, dt, SEE_THROUGH_SECONDS);
      paintFaded(f);
    }
  }

  // A head's place on the screen, and its distance in front of the camera, worked out in this.
  const onScreen = new THREE.Vector3();
  /**
   * Each frame, what floats over every head, sized to read on the screen and
   * stacked so nothing covers anything else (see `overhead.ts`): the tags and
   * signs, and the bubbles, the newest over its speaker and drawn on top.
   */
  function floatOver(dt: number) {
    const bodies: [string, Figure][] = [
      [opts.visitor ? "you" : self, me],
      ...companions,
      ...departing.map((d, i): [string, Figure] => [`leaving ${i}`, d.fig]),
    ];
    camera.updateMatrixWorld();
    const columns: Column[] = [];
    for (const [id, f] of bodies) {
      const crown = f.crown();
      const depth = -onScreen.copy(crown).applyMatrix4(camera.matrixWorldInverse).z;
      // Behind the camera, nothing over its head is on the screen to lay out.
      if (depth <= 0.05) continue;
      onScreen.copy(crown).project(camera);
      const over = f.fitOver(metresPerPixel(depth, camera.fov, stageH), clock);
      // The tag under the pointer, or of the one you stand by, keeps its place; then whoever is talking; then the nearer.
      const rank = (closeTo(id) ? 2 : f.speaking(clock) ? 1 : 0) * 1000 - depth;
      columns.push({ id, x: ((onScreen.x + 1) / 2) * stageW, y: ((1 - onScreen.y) / 2) * stageH, rank, ...over });
    }
    const laid = stack(columns, { left: 0, right: stageW - insetRight, top: insetTop, covered });
    const said = columns
      .filter((c) => c.bubble)
      .sort((a, b) => (a.said ?? 0) - (b.said ?? 0))
      .map((c) => c.id);
    for (const [id, f] of bodies) {
      const at = laid.get(id);
      if (at) f.placeOver(at, dt, 12 + Math.max(0, said.indexOf(id)));
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
      light(lightingFor(hour, lights));
    }
    const { state, loudness, engaged } = input();
    // A photo's frame is posed at the gesture's best moment exactly, however late this frame came.
    const peak = PEAK[opts.still?.gesture ?? ""] ?? 0.7;
    const shoot = !!opts.still && !readyFired && gestureAt !== undefined && t - gestureAt >= peak;
    const poseAt = shoot && gestureAt !== undefined ? gestureAt + peak : t;
    const here = me.here;
    const mine = shows.get(me)?.behavior;
    // Someone came to see the agent: it stays with them rather than wandering off.
    const myCompany = opts.visitor || opts.still ? undefined : kept.get(self);
    const next =
      asking || opts.still || opts.visitor || mine?.stays || myCompany
        ? undefined
        : me.director.decide(t, here, engaged, taken(me));
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
          // Couldn't ask: something from the room to do instead, or a spot at random.
          if (disposed) return;
          const picked = pickMine?.(here ?? "", taken(me))?.spot ?? freeSpot(me)?.id;
          if (picked) go(picked);
        })
        .finally(() => {
          asking = false;
          me.director.sent();
        });
    }
    if (!opts.still && !opts.visitor) attend(me, self, t, !engaged && !myCompany);
    if (!opts.still && !opts.visitor && !myCompany && !engaged && !asking && !mine?.stays) drift(me);
    // Talking with you comes first; otherwise it turns to whoever came to see it.
    if (myCompany && !engaged) keepCompany(me, myCompany, false, t);
    if (opts.visitor) {
      visit(dt);
      giveWay(t);
    }
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
      opts.still ? { activity: stillActivity } : opts.visitor ? undefined : errandHere(me),
    );
    if (opts.visitor) keepWithYou(dt);
    frameUp(dt);
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
    // The chat page's view keeps the agent in frame as it moves round a room too big to see whole from near
    // enough, slowly; and comes in or backs off to the zoom quickly, from whatever angle it was turned to.
    if (view === "room" && !tween && !opts.visitor && !opts.still) {
      const focus = roomFocus(room, visibleAspect(), me.walker.place, zoomKept, visibleTall());
      const follow = new THREE.Vector3(...focus.target).sub(controls.target).multiplyScalar(1 - Math.exp(-dt / 0.8));
      controls.target.add(follow);
      camera.position.add(follow);
      const offset = camera.position.clone().sub(controls.target);
      const away = offset.length();
      if (away > 1e-6 && away !== focus.distance) {
        const back = opts.reducedMotion ? focus.distance : ease(away, focus.distance, dt, ZOOM_SECONDS);
        camera.position.copy(controls.target).add(offset.setLength(back));
      }
    }
    // The others wander on their own, and keep an eye on the agent you are talking to.
    const meHead = me.head();
    for (const [agent, c] of companions) {
      const theirs = shows.get(c)?.behavior;
      if (!opts.still) {
        // Keeping someone company, a body stays with them: no wandering, no going off to a desk.
        const company = kept.get(agent);
        const move = theirs?.stays || company ? undefined : c.director.decide(t, c.here, false, taken(c));
        if (typeof move === "string") c.go(room, move, ways());
        attend(c, agent, t, !company);
        if (company) keepCompany(c, company, c.with === company, t);
        else if (!theirs?.stays) drift(c);
      }
      const talking = c.speaking(t);
      c.step(
        room,
        ways(),
        poseAt,
        dt,
        { state: talking ? "speaking" : theirs?.thinking ? "thinking" : "idle", loudness: talking ? chatter(t) : 0 },
        meHead,
        errandHere(c),
      );
    }
    // Those leaving walk on to the door, and are gone once they reach it.
    for (let i = departing.length - 1; i >= 0; i--) {
      const { fig, from } = departing[i];
      fig.step(room, ways(), poseAt, dt, { state: "idle", loudness: 0 }, meHead);
      if ((t - from > 0.5 && !fig.moving) || t - from > LEAVING_SECONDS) {
        fig.dispose();
        departing.splice(i, 1);
      }
    }
    // The tags that say more keep up: what they are doing changes, and "40 min ago" goes on counting.
    if (t - tagsAt > 1) {
      tagsAt = t;
      for (const agent of [hovered, near]) {
        const f = agent ? figureOf(agent) : undefined;
        if (agent && f) show(agent, f);
      }
      // The controls over the stage change with what is on it (a button to talk to who you stand by, where you are).
      measureOverlays();
      // What the renderer holds, for anyone inspecting the page, like `data-motion`: shapes and pictures on the
      // GPU. A count that keeps growing place after place is something not let go.
      const { geometries, textures } = renderer.info.memory;
      host.dataset.gpu = `${geometries} ${textures}`;
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
    for (let i = gliding.length - 1; i >= 0; i--) {
      const g = gliding[i];
      const k = Math.min(1, (now - g.started) / 700);
      // Eased both ways: it sets off and settles rather than snapping.
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      g.group.position.lerpVectors(g.from, g.to, e);
      const [a, b] = g.turn;
      const turn = Math.atan2(Math.sin(b - a), Math.cos(b - a));
      g.group.rotation.y = a + turn * e;
      if (k >= 1) gliding.splice(i, 1);
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
    floatOver(dt);
    seeThrough(dt);
    renderer.render(scene, camera);
    lookAgain(now);
  });

  /** Leaving the place shown for another: everyone in it stays there, and whoever is in the next one was there already. */
  const leavePlace = () => {
    for (const c of companions.values()) {
      shows.delete(c);
      errands.delete(c);
      c.dispose();
    }
    companions.clear();
    standing.clear();
    facedAt.clear();
    kept = new Map();
    for (const d of departing.splice(0)) d.fig.dispose();
    placedAt = performance.now();
    placeGen++;
    greeting = undefined;
    noticed.clear();
    voices = [];
    if (near) {
      near = undefined;
      opts.onNear?.(undefined);
    }
  };

  return {
    setView(next) {
      if (next === view && !tween) return;
      view = next;
      moveCamera(framing(next));
    },
    setInsets({ right, top = 0, bottom = 0 }) {
      if (right === insetRight && top === insetTop && bottom === insetBottom) return;
      insetRight = Math.max(0, right);
      insetTop = Math.max(0, top);
      insetBottom = Math.max(0, bottom);
      resize();
    },
    walkTo: go,
    cue: handleCue,
    setRoom(next, moved = false) {
      if (next === given && !moved) return;
      if (moved) leavePlace();
      // The same place changing shows what changed: new things pop in, moved ones glide over. Another place is simply there.
      const changed = changesShown(given, next, !moved);
      const resized = next.width !== room.width || next.depth !== room.depth || next.height !== room.height;
      unfade();
      scene.remove(furniture);
      disposeTree(furniture);
      appearing.length = 0;
      gliding.length = 0;
      given = next;
      room = next;
      camera.far = farFor(room);
      camera.updateProjectionMatrix();
      furnish(changed?.fresh, changed?.moved);
      if (lit) light(lit);
      fitShadows();
      // A visitor stays where they are standing: the room changing round them doesn't walk them anywhere.
      if (!opts.visitor) reseat(me, () => (spotById(room, room.start) ? room.start : undefined));
      for (const c of companions.values()) reseat(c, () => freeSpot(c)?.id);
      if (resized && !tween && !opts.visitor) moveCamera(framing(view));
      // Whoever is in the new place, at free spots in it.
      if (moved) meet(wanted);
    },
    enter(next, from) {
      // Everyone in the place you left stays there.
      leavePlace();
      unfade();
      scene.remove(furniture);
      disposeTree(furniture);
      appearing.length = 0;
      gliding.length = 0;
      given = next;
      room = next;
      camera.far = farFor(room);
      camera.updateProjectionMatrix();
      furnish();
      if (lit) light(lit);
      fitShadows();
      me.director.setRoom(room);
      const door = doorTo(room, from);
      const first = spotById(room, room.start) ?? room.spots[0];
      const to = door
        ? arrivalAt(room, door, obstacles)
        : { at: first?.at ?? ([0, 0] as [number, number]), facing: rad(first?.facing ?? 0) };
      me.placeAt(to.at, to.facing);
      lastAt = [to.at[0], to.at[1]];
      // You stop on the threshold; Shift still runs once you set off again.
      for (const key of [...held])
        if (key in MOVE_KEYS) {
          held.delete(key);
          waiting.add(key);
        }
      tween = null;
      // The same view as on arriving anywhere, centred on where you came in; flying, you turn about a point
      // just ahead of you from there, as you did before the door.
      const f = framing("room");
      const shift = me.head().sub(f.target);
      f.target.add(shift);
      f.position.add(shift);
      settle(f);
      if (travel === "fly") turnAboutAhead();
      // Whoever is in the new place, at free spots in it.
      meet(wanted);
      requestAnimationFrame(fadeIn);
    },
    setCompany: meet,
    standBefore,
    setActivities(next) {
      activities = next;
      show(self, me);
      for (const [agent, c] of companions) show(agent, c);
      lightDoors();
    },
    setTasks(next) {
      tasks = next;
      drawBoards();
    },
    setLights(next) {
      if (next === lights) return;
      lights = next;
      light(lightingFor(hour, lights));
    },
    setTravel(next) {
      if (!opts.visitor || next === travel) return;
      travel = next;
      held.clear();
      // Flying, the wheel moves you along the way you look; walking, it zooms the camera following you.
      controls.enableZoom = next === "fly";
      me.body.visible = next === "walk";
      if (next === "fly") {
        turnAboutAhead();
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
      if (leaving) clearTimeout(leaving.giveUp);
      renderer.setAnimationLoop(null);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", untouch);
      canvas.removeEventListener("pointermove", onHover);
      canvas.removeEventListener("pointermove", onTouch);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      controls.dispose();
      me.dispose();
      for (const c of companions.values()) c.dispose();
      companions.clear();
      for (const d of departing.splice(0)) d.fig.dispose();
      shows.clear();
      unfade();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
