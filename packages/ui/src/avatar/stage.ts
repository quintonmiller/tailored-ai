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
 * table and turn to whoever speaks. Two agents talking in the same place
 * face each other, the one who spoke first stepping over when they are far
 * apart; one talking to an agent somewhere else holds a phone to its ear, and
 * the far side's words come out of it (`talk.ts`). An agent out on its day
 * (`routines.ts`) sits at its seat, a coffee or a book in hand, and chats with
 * whoever is at the same table or bench; outdoors it walks from its own door
 * to its seat and back.
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
import {
  type Anchor,
  boxRound,
  EDGE,
  follow,
  inView,
  layoutPanels,
  type PanelIn,
  PLAQUE,
  type Placed,
  plaqueSpot,
  stripTaken,
  walkedAway,
} from "./anchors";
import { type BoardSpot, type BoardTask, boardAtUv, drawBoard } from "./boards";
import {
  type BodyLooks,
  builtKey,
  carriageKey,
  carriageOf,
  chosenNow,
  chosenSpotIn,
  type EmoteRecord,
  emoteNow,
  idleStyle,
  makesRoom,
  type Plan,
  planFor,
  stayingWords,
  type TurnBack,
  tintOf,
  turnBackAfter,
  turnBackNow,
} from "./body";
import { type CalendarView, drawCalendar } from "./calendar";
import type { Cue } from "./cues";
import {
  type AgentActivity,
  type Behavior,
  behaviorFor,
  chatsAt,
  heldFor,
  sameBehavior,
  seatToTake,
  stationSpot,
} from "./doing";
import { arrivalAt, doorFrame, doorLight, doorReached, doorTo, threshold } from "./doors";
import {
  carriedTo,
  doorItem,
  doorItemTo,
  doorPatch,
  doorPoint,
  doorSlotAt,
  footprint,
  groupOf,
  heightOf,
  type Kinds,
  type Move,
  moveKey,
  onFloor,
  onTop,
  onWall,
  ridersOf,
} from "./editing";
import { type Fadeable, type Ghost, paintFaded } from "./fade";
import { Figure, loadModel } from "./figure";
import { faceToFace, sideFor } from "./greet";
import { type Fit, Handles, type Patch } from "./handles";
import { chooseErrand, type Errand, errandAt, idleSpots, isMeeting, likesOf, seeded, stayLength } from "./idle";
import { inTheWay, type Obstacle, type Pick, standingIn } from "./locomotion";
import { buildModel } from "./models";
import type { BodyState } from "./motion";
import { type Box, type Column, metresPerPixel, stack, TAG_PX } from "./overhead";
import { nearestUse, shown, type Use } from "./pick";
import { buildDoor, buildPlaque, buildProp, buildShell, disposeTree } from "./props";
import { chatDue, chatPause, drawNotes, type Notes, talkedWords } from "./routines";
import {
  centrepieces,
  changesShown,
  closeDistance,
  DEFAULT_ROOM,
  farFor,
  fitView,
  framedIn,
  type Lighting,
  type Lights,
  lightingFor,
  lookTarget,
  MIN_ASPECT,
  nearestWithin,
  OPEN_SIDES,
  ownZoom,
  type Part,
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
import { drawScreen, drawStrip, pageAt, type ScreenCard } from "./screens";
import { takeDown } from "./shared";
import { blockers, FADED, FADED_WALL, type Solid, TALL, type Vec3, type Wall, wallOf, wallsBehind } from "./sight";
import { disposeSprite, fitSprite, liftSprite, thinkingCue } from "./signs";
import { SurfaceLayer, type SurfaceSpec, type SurfaceView } from "./surface-layer";
import { behindView, blocksView, facingSurface, focusDistance, focusFraming, overWalls, solidInWay } from "./surfaces";
import { byPhone, heardThrough, presentIn, standBy, talkingHere, talkMove } from "./talk";
import { type Thinker, thinkingTogether, thinkingWords } from "./together";
import { ashore, DOOR_SHOWN, isOutdoors, lightFrom, nearestLamps, skyFor } from "./town";
import { type BuiltTown, buildTown } from "./townscape";
import {
  Arrival,
  clampReach,
  ease,
  flyBounds,
  flyPinchStep,
  flyWheelStep,
  followDistance,
  heldMove,
  keepUp,
  keptIn,
  MOVE_KEYS,
  OUTDOOR_PACE,
  pinchReach,
  REACH,
  REACH_PER_NOTCH,
  RUN_KEYS,
  reachAt,
  type Travel,
  takeOff,
  travelSpeed,
  VISITOR_TURN,
  WALK_SPEED,
  wheelPixels,
  wheelReach,
  widestReach,
  ZOOM_SECONDS,
} from "./travel";
import { inOrder } from "./turns";

export type { SurfaceUse, SurfaceView } from "./surface-layer";
export type { Travel } from "./travel";

/**
 * A surface the page lays in the room itself (see `surface-layer.ts`): on
 * something in the room, or at a place on the floor plan, at a height,
 * facing a way (degrees, as a prop's `facing`).
 */
export type StageSurface = Omit<SurfaceSpec, "anchor" | "face" | "prop"> & {
  anchor: THREE.Object3D | { at: [number, number]; elevation: number; facing: number };
};

/** Something an agent said, when it said it (an ISO time; a reply can be timed to follow), to whom, and in which room. */
export interface Line {
  text: string;
  at: string;
  to?: string[];
  /** The room it was said in; none for a direct message, which may be said down the phone. */
  room?: string;
  /** Already heard out loud where it was said (the reply to a spoken turn): only a bubble here, never voiced again. */
  voiced?: boolean;
}

/**
 * Where on something made to be used a click landed: a note or a column on a
 * board, the page a screen is on, or a line on a calendar about an agent.
 */
export type UseSpot = BoardSpot | { card: string } | { agent: string };

/** A line older than this when it arrives was said before anyone was looking: no bubble. */
const STALE_LINE_MS = 15_000;

/** The whole room, or the avatar's head and torso. */
export type StageView = "room" | "close";

/** How near an agent you have to be for it to notice you, and how far to go before it forgets. */
const NOTICE_AT = 1.5;
const FORGET_AT = 2.4;
/** How near a visitor has to be to hear what an agent says. */
const HEAR_AT = 3.5;
/** How near another body has to be for a gesture with no target to be made for it. */
const AUDIENCE_AT = 5;
/** Seconds most gestures take, once: when a body turned to make one turns back. */
const EMOTE_SECONDS = 2.5;

/** Another agent in the same room: who, what to call it, and its body. */
export interface Companion {
  agent: string;
  /** What the agent you are talking to calls it: "the planner". */
  name: string;
  url: string;
  animations: string[];
  /** What it wears, by name (see `wear.ts`). */
  wear?: string[];
  /**
   * How it chose to look and carry itself (see `body.ts`): its colour, size,
   * idle style, posture, walk and what it likes doing, and a spot here it
   * chose to stay at. `url` is already the model it chose, if it chose one.
   */
  looks?: BodyLooks;
  /** Outdoors, where it comes from when it turns up: the door of the place it was in. */
  from?: [number, number];
}

/** Where an agent's body went just now, and where it came from, as places by id: either may not be known. */
export interface BodyMove {
  from?: string;
  to?: string;
}

export interface Stage {
  setView(view: StageView): void;
  /**
   * Say how much of the stage is covered, in pixels: a chat panel down the
   * right, a toolbar along the top, the chat along the bottom of a phone. The
   * camera frames what is left, and what is said is kept inside it. `panels`
   * is a strip beside the right one kept for panels beside things, taken from
   * the scene only when they need it (`stripTaken`).
   */
  setInsets(insets: { right: number; top?: number; bottom?: number; panels?: number }): void;
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
  /** What the body this stage shows wears, by name. */
  setWear(wear: string[]): void;
  /**
   * How the body this stage shows chose to look and carry itself: a new
   * model, colour or size makes it again where it stands, without the room
   * being built again; the rest changes on the body as it is.
   */
  setLooks(looks: BodyLooks): void;
  /** The gesture each agent is making, by agent: a new one plays on its body here, once or for as long as it says. */
  setEmotes(emotes: Record<string, EmoteRecord>): void;
  /** What each agent is doing, by agent: every body in the room shows its own. */
  setActivities(activities: Record<string, AgentActivity>): void;
  /** The last thing each agent said, by agent: a new line shows in a bubble over its head. */
  setSpeech(speech: Record<string, Line>): void;
  /** A visitor walks their body, or flies the camera. */
  setTravel(travel: Travel): void;
  /** The tasks every board in the room shows. */
  setTasks(tasks: BoardTask[]): void;
  /** The pages every screen in the room goes through, one every quarter of a minute. */
  setScreen(cards: ScreenCard[]): void;
  /** What every calendar in the room shows. */
  setCalendar(view: CalendarView): void;
  /**
   * What each widget (a status board, a feed, a chart…) shows from across a
   * room, by the id of the thing it is on: drawn on it while its live page
   * isn't up, and in a photo.
   */
  setGlances(glances: Record<string, ScreenCard>): void;
  /** Light the place as a home, cosy after dark, or as a public place (the lobby, a hall), bright at any hour. */
  setLights(lights: Lights): void;
  /** What a meeting room's whiteboards say: its room's last few lines, and when it last talked. */
  setNotes(notes: Notes | undefined): void;
  /** When each room last talked, by its meeting room's id: the card pinned on its door says so. */
  setTalked(talked: Record<string, string>): void;
  /** The buildings in the town with someone in them: their windows light up. */
  setOccupied(buildings: string[]): void;
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
  /**
   * Rearrange the room, or stop (null): the camera takes in the whole room,
   * the walking keys rest, and things are picked and dragged instead of gone
   * to. Called again as what is picked, or where it is being put, changes.
   */
  setEditing(edit: StageEdit | null): void;
  /**
   * Lay a surface of the page's own in the room: live HTML on a plane, on
   * something in the room or at a place in it. It belongs to the place on
   * the stage now, and going somewhere else takes it down; the function
   * returned takes it down sooner.
   */
  addSurface(surface: StageSurface): () => void;
  /** Hear which surfaces are live, each time that changes: the page draws into each one's element. */
  onSurfaces(listener: (views: SurfaceView[]) => void): () => void;
  /** The page has drawn into a live surface: from now on it shows through the picture. */
  surfaceReady(id: string): void;
  /** Bring a surface up to read and use, head-on, or put it down (null) and go back to where you were. */
  focusSurface(id: string | null): void;
  /** Where a pointer is on a surface, in the surface's own pixels from its top left; none when it is off it. */
  surfacePoint(id: string, at: { clientX: number; clientY: number }): [number, number] | undefined;
  /**
   * An agent's body on its way from one place to another, seen going by in
   * the town: it comes out at `from` (the door it left by), walks the streets
   * to `to` (the door it is going in by), and is gone once there. Only
   * outdoors, and only for a body not already here.
   */
  walkBy(walker: Companion & { from: [number, number]; to: [number, number] }): void;
  /** Where you are on the floor: your body, walking; what the camera turns about, flying. */
  where(): [number, number];
  /** Where every body here stands on the floor: yours while you walk, and each agent's. */
  standing(): [number, number][];
  /**
   * Keep a panel of the page's beside what it is about (see `anchors.ts`):
   * an agent's body, a thing here, the room's plaque, your own body, or held
   * in front of you. It is placed every frame, out of the way of the others,
   * the higher `rank` first; with what it is about off the screen it is held
   * as `fallback` says. `onAway` hears, once, that you walked away from what
   * it is about. The function returned lets it go.
   */
  anchorPanel(el: HTMLElement, anchor: Anchor, opts?: PanelOptions): () => void;
  /** The words on the room's plaque by its door, which a click opens the room's card from; none takes it down. */
  setPlaque(words: string | undefined): void;
  dispose(): void;
}

/** Metres a second a body walks going by in the town: briskly, somewhere to be. */
const PASSING_PACE = 2.2;

/** How a panel kept beside something goes (see `Stage.anchorPanel`). */
export interface PanelOptions {
  rank?: number;
  /** Put away rather than laid over another panel. */
  optional?: boolean;
  /**
   * Beside the body it is about and what that is with (whoever is gathered
   * round it, what it is at or standing by), rather than over them: your
   * conversation, which shouldn't cover what you walked up to.
   */
  gathered?: boolean;
  /** How it is held while what it is about is off the screen: in front of you (the default), or docked at the side. */
  fallback?: "front" | "dock";
  onAway?: () => void;
}

/**
 * Rearranging the room on the stage (see `editing.ts`): the kinds of thing
 * there are, what is picked, where it is being put if that isn't saved yet
 * and whether it fits there, and what the page hears as you pick and drag.
 */
export interface StageEdit {
  kinds: Kinds;
  selected?: string;
  /** Where the picked thing is shown instead of where it stands; `fits` unknown while the server is asked. */
  pending?: Move & { fits?: boolean };
  /** A thing was clicked or tapped, or nothing was. */
  onSelect(id: string | undefined): void;
  /** Where the thing being dragged would go now. */
  onDrag(move: Move): void;
  /** It was let go here. */
  onDrop(move: Move): void;
}

/** The nearest the camera comes while you rearrange a room, as a share of how far back it takes in the whole room. */
const EDIT_NEAREST = 0.3;

/**
 * Read every frame: the turn's moment, the voice's loudness right now (0–1),
 * and whether a session is under way, which keeps the avatar from wandering.
 */
export type StageInput = () => { state: BodyState; loudness: () => number; engaged: boolean };

/** Seconds to move between views. */
const VIEW_SECONDS = 0.8;
/**
 * A building in the town between the camera and you fades to this: a pale,
 * even glow at a fifth of itself, by day or night, its shape plain and the
 * street seen clear through it, rather than its walls and roof going murky.
 */
const TOWN_GHOST: Ghost = { color: 0xdfe7f5, faded: 0.2 };
/** Seconds the camera takes to come back round to you from the shot of a room on the way in. */
const LEAD_SECONDS = 0.7;
/** How high the head of a tall body sat at a meeting table comes: the shot on the way in keeps it in. */
const SEATED_TOP = 1.9;
/** Pixels kept between what the shot on the way in frames and the keys hint along the stage's foot. */
const HINT_MARGIN = 6;
/** Bodies this near an agent, in metres on the floor, are gathered with it: a panel about it goes beside them too. */
const GATHERED = 2;
/** Where a cue over several thinking together is laid out among the tags: after every one, so it goes up over theirs. */
const CUE_RANK = -1e9;
/** A tall thing on the floor this near a body, in metres from its edge, is what it stands by: a panel keeps off it too. */
const BESIDE_THING = 0.9;
/** A room's boards to be read, which a faint tag in a crowd never sits over. */
const BOARD_KINDS = new Set(["board", "whiteboard"]);
/** What hangs on a room's walls to be read, which the shot on the way in takes in with what the room is gathered round. */
const READ_ON_WALLS = new Set([
  "board",
  "whiteboard",
  "screen",
  "calendar",
  "status_board",
  "needs_board",
  "feed",
  "chart",
  "agenda",
  "todo",
  "ticker",
]);

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
const WALL_KINDS = new Set([
  "window",
  "picture",
  "clock",
  "shelf",
  "board",
  "painting",
  "poster",
  "pegboard",
  "sign",
  "screen",
  "calendar",
  "map",
  "wall_model",
]);
/** The kinds a model an agent made is, by where it goes: drawn from its parts (`models.ts`). */
const MODEL_KINDS = new Set(["model", "wall_model", "small_model"]);
/** What a click on a thing does when the room doesn't say: a screen and a calendar open what they show. */
const USES: Partial<Record<string, string>> = { screen: "screen", calendar: "calendar" };
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
/** The same outdoors, kept apart: a town is seen from further back than a room, and each keeps how you left it. */
let outdoorReachKept = REACH.outdoorStart;
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
/** How much of a gate at an open side shows while someone stands behind it. */
const GATE_FAINT = 0.03;
/** How often the controls that step aside look again at what is behind them, in milliseconds. */
const ASIDE_MS = 150;
/** Seconds at least between one body's looks for a new way round you, while you are in its way. */
const REROUTE_SECONDS = 0.4;
/** Seconds something in the way takes to fade, or to come back once the view is clear. */
const SEE_THROUGH_SECONDS = 0.15;
/** How far off a surface can be and still be brought up with F from the camera's own view, not a body's: metres. */
const FAR_FACE = 30;
/** Pixels kept clear round a surface being read, and at the stage's foot for the chat's bar when nothing covers it. */
const READ_GAP = 14;
const READ_FOOT = 70;
/** How paper on a wall looks by a home's lamps after dark: a little dimmer and warmer than by day. */
const LAMPLIT = "brightness(0.92) sepia(0.14)";
/** The least height in pixels a surface being read is fitted into, however much is over the stage. */
const READ_LEAST = 160;

/** The box round something, as one that can hide a body. */
const solidOf = (box: THREE.Box3): Solid => ({ min: box.min.toArray(), max: box.max.toArray() });
/**
 * A thing as solid as it is: the box round all of it, and the boxes round each
 * of its parts, so only those, not the open space between them (under a cart's
 * awning, beside a lamp's post), can hide a body.
 */
const shapeOf = (group: THREE.Object3D, box: THREE.Box3): Solid => {
  const parts: Solid[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) parts.push(solidOf(new THREE.Box3().setFromObject(o)));
  });
  return { ...solidOf(box), ...(parts.length > 1 ? { parts } : {}) };
};

const bare = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .trim();

const UP = new THREE.Vector3(0, 1, 0);

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
    /**
     * Where an agent's body last went, and came from: one leaving walks out
     * by the door to where it went, and one arriving comes in by the door
     * from where it was, when the room has that door, rather than its first.
     */
    wentBy?: (agent: string) => BodyMove | undefined;
    /** The agent this stage shows, for its activity and its colour. */
    agent?: string;
    /** What that body wears, by name (see `wear.ts`). */
    wear?: string[];
    /** How that body chose to look and carry itself: its colour, size, model, idle style, posture and walk. */
    looks?: BodyLooks;
    /** Someone clicked an agent's body (or its tag): which agent, and where on the page. */
    onPick?: (agent: string, at: { x: number; y: number }) => void;
    /** Outdoors, where an agent's body goes when it leaves: the door of where it is going, when that is known. */
    exitFor?: (agent: string) => [number, number] | undefined;
    /** The body here is the visitor's own, moved by keys and clicks, not an agent's. */
    visitor?: boolean;
    /** The agent the visitor is standing next to, when it changes; undefined when none is. */
    onNear?: (agent: string | undefined) => void;
    /**
     * The agents whose bodies are in the place, when that changes: those here,
     * and those still walking out of it, who are here until they reach the door.
     */
    onPresent?: (agents: string[]) => void;
    /**
     * Something made to be used was clicked: a kiosk, a task board, a screen, a
     * calendar. Its action; on a board, what was hit; on a screen, the page up.
     */
    onUse?: (action: string, on?: UseSpot, thing?: string) => void;
    /**
     * A visitor is within earshot as an agent starts saying something: who,
     * what, and how near (0–1, 1 beside it); `phone`, it is the far side of a
     * call, heard out of the phone of someone here.
     */
    onLine?: (agent: string, text: string, nearness: number, phone?: boolean) => void;
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
    /** What else is laid over the stage that the page's panels keep clear of, though the camera frames past it. */
    hints?: () => Element[];
    /**
     * Controls over the stage that step aside: each is marked `data-behind` while what you are looking at is behind
     * it (your body, the agent's in its own view, the middle of the view while you fly) or the pointer is, on the
     * picture, and the page fades it then. The trail of where you are.
     */
    fades?: () => Element[];
    /** A surface was brought up to read close up, or put down (undefined). */
    onFocus?: (surface: string | undefined) => void;
    /** The pointer came over a surface a click brings up (what it is, and where on the page), or left it. */
    onSurfaceHover?: (label: string | undefined, at?: { x: number; y: number }) => void;
    /** The pointer came over the room's plaque (where on the page), or left it. */
    onPlaqueHover?: (at: { x: number; y: number } | undefined) => void;
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

  // How the body this stage shows chose to look, and what it was built from: a new model, colour or size makes it again.
  let myLooks: BodyLooks = opts.looks ?? {};
  let myBuild = builtKey(url, myLooks, opts.agent || "default");
  let vrm: VRM;
  try {
    vrm = await loadModel(myLooks.avatar ?? url);
  } catch (err) {
    renderer.dispose();
    // Its drawing context goes now too, as when a stage is taken down: a body that won't load is tried at each rebuild.
    renderer.forceContextLoss();
    throw err;
  }

  const scene = new THREE.Scene();
  // Live HTML on the room's screens, boards, calendars and kiosks, under the picture (`surface-layer.ts`). None in
  // a photo, which is never told what is on them.
  const layer = new SurfaceLayer(!opts.still);
  // Surfaces the page laid at a place in the room rather than on something in it: what each lies on.
  const pinned = new THREE.Group();
  scene.add(pinned);
  /** Whether something is in the room on the stage, not left behind with furniture taken down. */
  const inScene = (o: THREE.Object3D) => {
    let p: THREE.Object3D | null = o;
    while (p?.parent) p = p.parent;
    return p === scene;
  };
  // Which place the surfaces belong to: a prop's surface is the same one in the same place, and another in the next.
  let surfacePlace = 0;
  // The surface being read close up, if any; the layer is told, and the camera, the keys and the pointer follow.
  let reading: string | undefined;
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
  // The town, when the place is outdoors: built in place of a room's floor and walls, its sky round the camera.
  let town: BuiltTown | undefined;
  // Its doors, each drawn only while near enough to matter.
  let townDoors: THREE.Group[] = [];
  /** Let the town go, its sky too: the rest of it is in the furniture, freed with that. */
  const clearTown = () => {
    if (!town) return;
    scene.remove(town.sky);
    town.dispose();
    town = undefined;
    townDoors = [];
    scene.fog = null;
  };
  // Each thing in the room as built, by its id: what is picked and dragged while the room is rearranged.
  let things = new Map<string, THREE.Group>();
  // What stands on the floor, by the box round it as built: what someone standing by it is with (`withOnStage`).
  let floorBoxes = new Map<string, THREE.Box3>();
  // Rearranging the room (see `setEditing`): what the page says, and how far back the camera sits for it, as a share
  // of taking in the whole room. Here, ahead of everything that asks whether the room is being rearranged.
  let editing: StageEdit | null = null;
  let editZoom = 1;
  // Things drawn somewhere other than where the room has them: what is being moved, and what stands on it.
  const shifted = new Set<string>();
  // A door put in drawn somewhere other than where the room has it, while it is dragged.
  let shiftedDoor: { group: THREE.Object3D; door: RoomDoor } | undefined;
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
  type Face = NonNullable<ReturnType<typeof buildProp>["screen"]>;
  let boards: { label: string; screen: Face }[] = [];
  let tasks: BoardTask[] = [];
  // Screens, each on the page the clock says, and calendars; what they show, and what was last drawn, so the same
  // again isn't drawn twice.
  let screens: (Face & { pin?: string })[] = [];
  let calendars: Face[] = [];
  // The widgets (`widgets.ts`): each one's face, and what it shows from across a room, by the id of what it is on.
  let widgetFaces: { prop: string; title: string; screen: Face }[] = [];
  let glances: Record<string, ScreenCard> = {};
  let glancesKey = "{}";
  // Whiteboards, and what a meeting room's say; the cards on doors saying when each room last talked.
  let whiteboards: Face[] = [];
  let notes: Notes | undefined;
  let notesKey = "";
  let doorNotes: { to: string; note: (words: string | undefined) => void }[] = [];
  let talked: Record<string, string> = {};
  let notedMinute = -1;
  // The buildings in the town with someone in them, once the page has said.
  let occupied: Set<string> | undefined;
  let cards: ScreenCard[] = [];
  let cardsKey = "[]";
  let shownPage = -1;
  let shownMinute = -1;
  let calendar: CalendarView | undefined;
  let calendarKey = "";
  // What each agent is doing: every body shows its own, and the light by a home's door its owner's.
  let activities: Record<string, AgentActivity> = {};
  const drawBoards = () => {
    for (const b of boards) {
      drawBoard(b.screen.canvas, b.label, tasks);
      b.screen.texture.needsUpdate = true;
    }
  };
  /** Draw the screens on the page that is up now; a clock on it shows this minute. */
  const drawScreens = () => {
    const now = Date.now();
    shownPage = pageAt(now, cards.length);
    shownMinute = cards[shownPage]?.clock ? Math.floor(now / 60_000) : -1;
    for (const s of screens) {
      // A screen kept to one widget shows that one's page alone.
      const pinned = s.pin ? cards.find((c) => c.id === s.pin || c.title.toLowerCase() === s.pin) : undefined;
      if (s.pin) drawScreen(s.canvas, pinned ?? { id: s.pin, title: s.pin }, 0, 1);
      else drawScreen(s.canvas, cards[shownPage], shownPage, cards.length);
      s.texture.needsUpdate = true;
    }
  };
  /** Draw each widget as it reads from across a room: its title alone until the page says more. */
  const drawGlances = () => {
    for (const w of widgetFaces) {
      const card = glances[w.prop] ?? { id: w.prop, title: w.title };
      // A strip (a ticker) reads in one line; anything else as a screen's page does.
      if (w.screen.canvas.width > w.screen.canvas.height * 3) drawStrip(w.screen.canvas, card);
      else drawScreen(w.screen.canvas, card, 0, 1);
      w.screen.texture.needsUpdate = true;
    }
  };
  /** Write a meeting room's last few lines on its whiteboards, and the time since on each, as of this minute. */
  const drawWhiteboards = () => {
    for (const b of whiteboards) {
      drawNotes(b.canvas, notes);
      b.texture.needsUpdate = true;
    }
  };
  /** The card on each meeting room's door: how long since its room talked, now. */
  const noteDoors = () => {
    const now = Date.now();
    notedMinute = Math.floor(now / 60_000);
    for (const d of doorNotes) d.note(talkedWords(talked[d.to], now));
  };
  // Until the page says what is on them (and in a photo, where it never does), calendars show today's date alone.
  const drawCalendars = () => {
    for (const c of calendars) {
      drawCalendar(c.canvas, calendar);
      c.texture.needsUpdate = true;
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
  // The door put in that is picked while rearranging, lit up as one under the pointer is.
  let pickedDoor: RoomDoor | undefined;
  /** The pointer is over a door now (`at` on the stage), or none: it lights up, and the last one goes back. */
  const hoverDoor = (door: RoomDoor | undefined, at?: { x: number; y: number }) => {
    if (door !== overDoor) {
      if (overDoor) doorHighlights.get(overDoor)?.(false);
      if (door) doorHighlights.get(door)?.(true);
      overDoor = door;
    }
    opts.onDoorHover?.(door, door ? at : undefined);
  };
  // The room's plaque by its door, which opens the room's card: the words the page gave for it, and what was built.
  let plaqueWords: string | undefined;
  let plaque: ReturnType<typeof buildPlaque> | undefined;
  let overPlaque = false;
  /**
   * Hang the plaque in the room as it is now, beside a door in a wall with
   * room for it (`plaqueSpot`), once the page has said what it says; the one
   * hung before comes down first.
   */
  const hangPlaque = () => {
    if (plaque) {
      const old = plaque.group;
      // Faded with its wall, it wears copies of its own materials: those go back first, so its own are what is freed.
      const faded = fadeable.find((f) => f.group === old);
      if (faded) {
        faded.level = 1;
        paintFaded(faded);
      }
      fadeable = fadeable.filter((f) => f.group !== old);
      furniture.remove(old);
      // Only what is its own: its rim is painted in a colour the rest of the furniture shares.
      plaque.dispose();
      const i = clickable.indexOf(old);
      if (i >= 0) clickable.splice(i, 1);
      plaque = undefined;
    }
    // The pointer resting on the one taken down: what a click on it opened goes with it.
    if (overPlaque) opts.onPlaqueHover?.(undefined);
    overPlaque = false;
    const spot = plaqueWords && !opts.still ? plaqueSpot(given) : undefined;
    if (!spot || !plaqueWords) return;
    const built = buildPlaque(plaqueWords, PLAQUE.width, PLAQUE.height);
    built.group.position.set(spot.at[0], PLAQUE.elevation, spot.at[1]);
    built.group.rotation.y = rad(spot.facing);
    built.group.userData.action = "place";
    furniture.add(built.group);
    clickable.push(built.group);
    // It hangs on its wall, and fades with it.
    fadeable.push({ group: built.group, wall: spot.door.wall as Wall, level: 1 });
    plaque = built;
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
    things = new Map();
    floorBoxes = new Map();
    shifted.clear();
    scenery.length = 0;
    clickable.length = 0;
    glows = [];
    boards = [];
    screens = [];
    calendars = [];
    widgetFaces = [];
    whiteboards = [];
    // Outdoors, the town in place of a floor and walls: its buildings fade when they hide you, and a click on one
    // walks you up to its door.
    clearTown();
    if (isOutdoors(room)) town = buildTown(room.town);
    const shell = town ? town.group : buildShell(room);
    furniture.add(shell);
    scenery.push(shell);
    fadeable = [];
    shell.traverse((o) => {
      if (o.userData.wall) fadeable.push({ group: o, wall: o.userData.wall as Wall, level: 1 });
    });
    const lights: { at: THREE.Vector3; fire: boolean }[] = [];
    obstacles = town ? [...town.obstacles] : [];
    if (town) {
      for (const b of town.buildings) {
        fadeable.push({ group: b.group, solid: b.solid, level: 1, ghost: TOWN_GHOST });
        b.group.userData.approach = b.approach;
        clickable.push(b.group);
      }
      scene.add(town.sky);
    }
    // The photos taken here go in the pictures, newest in the first, then in the paintings.
    const photos = [...(room.photos ?? [])];
    const hung = new Map<string, string>();
    for (const kind of Object.keys(ARTS))
      for (const prop of room.props) {
        const photo = prop.kind === kind ? photos.shift() : undefined;
        if (photo) hung.set(prop.id, photo.media);
      }
    // The surfaces on the things here are laid again, each keeping what it shows if its thing is still here. One the
    // page laid on something that went with the old furniture goes with it: the page lays it again on the new.
    layer.markStale((s) => !!s.prop || !inScene(s.anchor));
    for (const prop of room.props) {
      // A model an agent made is drawn from its parts, fitted into the box the room gave it; its faces are surfaces.
      const model = MODEL_KINDS.has(prop.kind) ? buildModel(room.models?.[prop.model ?? ""], prop.size) : undefined;
      const built = model
        ? { group: model.group }
        : buildProp(prop.kind, { color: prop.color, size: prop.size, label: prop.label, scale: prop.scale });
      for (const face of model?.faces ?? [])
        if (face.spec)
          layer.add({
            id: `${surfacePlace}:${prop.id}:${face.part}`,
            anchor: face.anchor,
            size: face.surface,
            face: face.mesh,
            prop,
            component: face.spec,
            label: prop.name ?? face.spec.kind,
          });
      if (built.screen) {
        if (prop.kind === "screen")
          screens.push({ ...built.screen, ...(prop.shows ? { pin: prop.shows.trim().toLowerCase() } : {}) });
        else if (prop.kind === "calendar") calendars.push(built.screen);
        else if (prop.kind === "board") boards.push({ label: prop.label ?? "Tasks", screen: built.screen });
        else if (prop.kind === "whiteboard") whiteboards.push(built.screen);
        else if (prop.kind !== "kiosk")
          widgetFaces.push({ prop: prop.id, title: prop.name ?? prop.kind, screen: built.screen });
        layer.add({
          id: `${surfacePlace}:${prop.id}`,
          anchor: built.screen.face,
          size: built.screen.size,
          face: built.screen.face,
          prop,
          label: prop.name ?? prop.label ?? prop.kind,
          // A kiosk's button is pressed there and then; anything with more on it is brought up to read first.
          use: prop.kind === "kiosk" ? "direct" : "focus",
        });
      }
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
        floorBoxes.set(prop.id, box);
        if (box.max.y >= TALL)
          fadeable.push({ group: built.group, solid: shapeOf(built.group, box), level: 1, shadeless: true });
      }
      // What hangs on a wall fades with it.
      const wall = WALL_KINDS.has(prop.kind) ? wallOf(room, prop.at) : undefined;
      if (wall) fadeable.push({ group: built.group, wall, level: 1 });
      furniture.add(built.group);
      scenery.push(built.group);
      built.group.userData.prop = prop.id;
      things.set(prop.id, built.group);
      const action = prop.action ?? USES[prop.kind];
      if (prop.spot) built.group.userData.spot = prop.spot;
      if (action) built.group.userData.action = action;
      if (prop.spot || action) clickable.push(built.group);
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
    doorNotes = [];
    doorHighlights = new Map();
    // The door the pointer was over is gone with the room it was in, and so is one picked while rearranging.
    if (overDoor) hoverDoor(undefined);
    pickedDoor = undefined;
    for (const door of room.doors ?? []) {
      // Outdoors, a door is in the front of a building, framed in its trim, as tall as a ground floor.
      const outside = !!door.at;
      const built = buildDoor(door, {
        freestanding: !outside && (door.wall === "front" || door.wall === "right"),
        trim: outside ? "#f2efe8" : room.walls,
        height: outside ? 3.2 : room.height,
        signpost: !outside && door.wall === "right",
      });
      const { at, facing } = doorFrame(room, door);
      built.group.position.set(at[0], 0, at[1]);
      built.group.rotation.y = rad(facing);
      built.group.userData.door = door;
      furniture.add(built.group);
      scenery.push(built.group);
      clickable.push(built.group);
      // A door in a wall fades with it; one standing at an open side is a tall thing like any other; one in the
      // front of a building, with the building.
      const house = outside ? town?.buildings.find((b) => b.building.id === door.to) : undefined;
      if (outside) {
        townDoors.push(built.group);
        // Its building's shadow is shadow enough: a door's dozen parts aren't drawn again for it.
        built.group.traverse((o) => {
          o.castShadow = false;
        });
      }
      if (house) fadeable.push({ group: built.group, solid: house.solid, level: 1 });
      else if (door.wall === "back" || door.wall === "left")
        fadeable.push({ group: built.group, wall: door.wall, level: 1 });
      // A gate at an open side, between the camera and the room, all but goes while someone stands behind it: half
      // there, its posts and plate would look like a pane of glass in front of them.
      else
        fadeable.push({
          group: built.group,
          solid: solidOf(new THREE.Box3().setFromObject(built.group)),
          level: 1,
          faint: GATE_FAINT,
        });
      if (built.light && door.occupant) doorLights.push({ occupant: door.occupant, light: built.light });
      if (built.note) doorNotes.push({ to: door.to, note: built.note });
      doorHighlights.set(door, built.highlight);
    }
    plaque = undefined;
    hangPlaque();
    lightDoors();
    noteDoors();
    layer.sweep();
    scene.add(furniture);
    // Somewhere to stand by a plant, the task board, a sideboard: worked out once what is in the way is known.
    room = { ...given, spots: [...given.spots, ...idleSpots(given, obstacles)] };
    drawBoards();
    drawScreens();
    drawCalendars();
    drawGlances();
    drawWhiteboards();
    warm.length = 0;
    // A big room's lamps reach further, so the light still meets in the middle; outdoors, a street lamp's pool.
    lampReach = town ? 9 : Math.max(5, Math.hypot(room.width, room.depth) / 2.2);
    // Outdoors, the street lamps nearest you light up (see `lightStreets`); the rest only glow.
    const kept = town ? [] : spreadLights(lights, LIT_LAMPS);
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
    if (town) for (const light of bulbs) warm.push({ light, fire: false });
    litAt = undefined;
    sunAt = undefined;
  };
  // Where the street lamps were last lit round, and the sun last aimed from: outdoors, both follow you.
  let litAt: [number, number] | undefined;
  let sunAt: [number, number] | undefined;
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

  // What each idle body is doing with its time, whether it has got there yet, and, at a spot it chose to stay at,
  // when it moves on to something else there (see `attend`).
  const errands = new Map<Figure, { errand: Errand; arrived: boolean; ends?: number }>();
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
  /** How each agent chose to look and carry itself, by agent: the others here, and the one this stage shows. */
  const looksOf = (agent: string): BodyLooks | undefined =>
    agent === self ? myLooks : wanted.find((c) => c.agent === agent)?.looks;
  /** What each agent likes doing, by errand: what its idle style draws it to, and what it said it likes. */
  const likesFor = (agent: string) => {
    const looks = looksOf(agent);
    return likesOf(idleStyle(looks?.idle).likes, looks?.errands);
  };
  /** Something to do next for an idle body: where it goes, and how long it stays once there, as its idle style has it. */
  const pickFor =
    (agent: string, figure: () => Figure | undefined) =>
    (here: string, busy?: ReadonlySet<string>): Pick | undefined => {
      const f = figure();
      if (!f) return undefined;
      const last = errands.get(f)?.errand.id;
      stopErrand(f);
      const likes = likesFor(agent);
      const next = chooseErrand(room, { hour: hourNow(), random: chanceFor(agent), last, here, taken: busy, likes });
      if (!next) return undefined;
      errands.set(f, { errand: next, arrived: false });
      const stay = idleStyle(looksOf(agent)?.idle).stay;
      return { spot: next.spot, stay: [next.seconds[0] * stay, next.seconds[1] * stay] };
    };
  /** What a body's errand has it doing where it stands, once it is there, for its pose. */
  const errandHere = (f: Figure): { activity: Errand["activity"] } | undefined => {
    const e = errands.get(f);
    return e?.arrived && f.here === e.errand.spot ? { activity: e.errand.activity } : undefined;
  };
  const pickMine = opts.visitor || opts.still ? undefined : pickFor(self, (): Figure | undefined => me);

  /** The body this stage shows, built from a model as it chose to look, standing at `at`. */
  const makeMe = (model: VRM, at: Spot | undefined, wear: string[] | undefined) =>
    new Figure(model, room, at, {
      reducedMotion: opts.reducedMotion,
      animations: opts.animations,
      agentChooses: !!opts.chooseIdle,
      ...(pickMine ? { pick: pickMine } : {}),
      ...(selfie && at && at.activity !== "sit" ? { facing: 0.5 } : {}),
      tint: tintOf(myLooks.color, self),
      ...(myLooks.size ? { size: myLooks.size } : {}),
      carriage: carriageOf(myLooks),
      wear,
      // Your own body walks briskly and turns on the spot, whatever its size; the agents keep their own calmer pace.
      ...(opts.visitor ? { pace: WALK_SPEED, turn: VISITOR_TURN, runs: true } : {}),
      // Which motion is playing, for anyone inspecting the page: "code" until animation files take over.
      onClips: () => {
        host.dataset.motion = "clips";
      },
    });
  let me: Figure = makeMe(vrm, start, opts.wear);
  scene.add(me.body, me.gaze);
  if (arrival) me.placeAt(arrival.at, arrival.facing);
  host.dataset.motion = "code";
  /** Your own body's pace for the place it is in: brisker outdoors, where the streets are long. */
  const paceFor = () => {
    if (opts.visitor) me.walker.speed = WALK_SPEED * (isOutdoors(room) ? OUTDOOR_PACE : 1);
  };
  paceFor();

  // Other agents in the room, by agent; and those still loading.
  const companions = new Map<string, Figure & { name?: string; built?: string; carried?: string }>();
  // What each body is showing of what its agent is doing.
  const shows = new Map<Figure, { behavior: Behavior; doing?: string; checked: number; faced: number }>();
  // The last line of each agent's that has been shown, by its time, so a line shows once.
  const heard = new Map<string, string>();
  // Lines about to be said, for a visitor to hear when they start; `via`, the one here whose phone a far line comes out of.
  let voices: { agent: string; text: string; at: number; via?: string }[] = [];
  const arriving = new Set<string>();
  // Bodies about to go by in the town, still loading: apart from those arriving, so a walk cut short by going
  // somewhere else never keeps an agent from turning up there.
  const passing = new Set<string>();
  // Bodies walking out, each gone once it gets where it is going, or by `until` (seconds on the stage's clock); one
  // going by in the town says whose it is (`agent`), so its next walk takes its place.
  /** Bodies on their way out, gone at the door: one leaving the place (`leaving`), or one passing by outdoors. */
  const departing: { fig: Figure; from: number; until?: number; agent?: string; leaving?: boolean }[] = [];
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
  // Who faces whom here, talking face to face, and whether each is the one to walk over (see `talkingHere`); where
  // each that walked over stands, or is walking to stand; and when each body last looked to its company.
  let kept = new Map<string, { partner: string; goes: boolean }>();
  // Whether you are talking to the agent shown, this frame: a person at the page comes before the spot it chose.
  let engagedNow = false;
  const standing = new Map<Figure, [number, number]>();
  const facedAt = new Map<Figure, number>();
  const rekeep = () => {
    const was = kept;
    kept = talkingHere(activities, new Set([self, ...companions.keys()]));
    // A talk over: nowhere it stands for it, and, standing at a spot, back to what it faces there. One that got up
    // to talk is at no spot, and goes on to one once it has stopped (see `drift`).
    for (const agent of was.keys()) {
      const f = kept.has(agent) ? undefined : figureOf(agent);
      if (!f || (f === me && opts.visitor)) continue;
      standing.delete(f);
      if (f.here && f.seated < 0.05 && !opts.still) f.go(room, f.here, waysFor(f));
    }
    // A talk begun, or with someone else now: seen to at once, not at the next look round a couple of seconds on.
    for (const [agent, talk] of kept) {
      const before = was.get(agent);
      const f = before?.partner === talk.partner ? undefined : figureOf(agent);
      if (f) facedAt.delete(f);
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
  /** The spot in this room an agent chose to stay at, while its time hasn't run out; undefined when there is none. */
  const stayFor = (agent: string): string | undefined => {
    const spot = looksOf(agent)?.spot;
    const now = spot ? chosenNow(spot, spot.place, Date.now()) : undefined;
    return now ? chosenSpotIn(room, now) : undefined;
  };
  /** Its tag at the spot it chose, with nothing else to say: "staying at the window". */
  const stayTag = (agent: string, f: Figure): string | undefined => {
    const name = looksOf(agent)?.spot?.name;
    return name && f.here !== undefined && f.here === stayFor(agent) ? stayingWords(name) : undefined;
  };
  /**
   * Which rule has a body this frame (see `planFor`): your own body on a
   * visit, and a photo's, are yours. Whether you are talking to the agent
   * shown is the frame's (`engagedNow`).
   */
  const planOf = (f: Figure): Plan => {
    if (f === me && (opts.visitor || opts.still)) return "you";
    const agent = f === me ? self : [...companions].find(([, c]) => c === f)?.[0];
    if (!agent) return "routine";
    return planFor({
      talking: kept.has(agent),
      working: !!shows.get(f)?.behavior.stays,
      engaged: f === me && engagedNow,
      spot: !!stayFor(agent),
    });
  };
  /**
   * Go to the spot it chose and stay. A body there about its own routine
   * makes room; one with more reason to be there (it chose the spot too, it
   * works there, it is talking, or with you) keeps it, and this one waits
   * where it is until the spot is free, rather than pushing in every frame.
   * Waiting at no spot at all, it stands at a free one meanwhile. Already
   * there, or on its way, nothing to do.
   */
  const keepTo = (f: Figure, id: string) => {
    if (f.current === id || f.pending === id) return;
    const holders = [me, ...companions.values()].filter((g) => g !== f && g.current === id);
    if (!holders.every((g) => makesRoom(planOf(g), "spot"))) {
      drift(f);
      return;
    }
    for (const g of holders) {
      const elsewhere = freeSpot(g);
      if (elsewhere && elsewhere.id !== id) g.go(room, elsewhere.id, waysFor(g));
    }
    f.go(room, id, waysFor(f));
  };
  /**
   * Where `f` stands to talk to `partner`, on the side it comes from: clear of everyone else. Come to talk to you on a
   * visit, beside you as the camera sees you, so you are both in the picture rather than one behind the other.
   */
  const standFor = (f: Figure, partner: Figure) => {
    const others: [number, number][] = [];
    for (const g of [me, ...companions.values()])
      if (g !== f && g !== partner) others.push(standing.get(g) ?? [g.walker.place.x, g.walker.place.z]);
    return standBy(room, obstacles, [partner.walker.place.x, partner.walker.place.z], {
      from: [f.walker.place.x, f.walker.place.z],
      others,
      ...(partner === me && opts.visitor ? { eye: [camera.position.x, camera.position.z] as [number, number] } : {}),
    });
  };
  /** One goes over to stand and talk with another. */
  const joinUp = (f: Figure, partner: Figure) => {
    const spot = standFor(f, partner);
    standing.set(f, spot.at);
    f.goTo(room, spot.at, waysFor(f));
  };
  /**
   * Every few seconds, a body talking face to face turns to the other, and
   * the one who goes walks over (see `talkMove`): when they are too far apart
   * to talk, again if the other moves off, and at once from wherever else it
   * was going, its desk among them. One sitting about when the other has
   * walked over to it gets up to stand with it; at a meeting table everyone
   * keeps their seat.
   */
  const keepCompany = (f: Figure, partnerAgent: string, goes: boolean, t: number) => {
    const partner = figureOf(partnerAgent);
    if (!partner || t - (facedAt.get(f) ?? Number.NEGATIVE_INFINITY) < 2) return;
    const move = talkMove({
      goes,
      apart: Math.hypot(partner.walker.place.x - f.walker.place.x, partner.walker.place.z - f.walker.place.z),
      joining: f.walking && standing.has(f),
      walking: f.walking,
      seated: f.seated > 0.05,
      partnerWalking: partner.walking,
      partnerCame: standing.has(partner),
      meeting: isMeeting(room),
    });
    // Turning where it stands, it turns again in a moment; anything else waits a while before it is looked at again.
    if (move === "wait" && f.moving && !f.walking) return;
    facedAt.set(f, t);
    if (move === "join") joinUp(f, partner);
    else if (move === "rise") {
      // Idle, or talking with the one who came over: up it gets. Asleep it sleeps on, and busy it carries on.
      const b = shows.get(f)?.behavior;
      if (!b?.stays || b.face === partnerAgent) joinUp(f, partner);
      else f.face(partner.head(), t);
    } else if (move === "face") f.face(partner.head(), t, !goes && !!shows.get(f)?.behavior.stays && busyAt(f));
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
  scene.add(sky, sun, sun.target);
  /** How far round you the shadows are drawn outdoors, either side: the town is far too big to shadow at once. */
  const OUTDOOR_SHADOWS = 26;
  /**
   * The shadows cover the whole room, however big it has been made. Outdoors
   * they cover the ground round you, and follow you (see `aimSun`).
   */
  const fitShadows = () => {
    const half = town ? OUTDOOR_SHADOWS : Math.max(room.width, room.depth) / 2 + 0.6;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, far: town ? 120 : 16 });
    sun.shadow.camera.updateProjectionMatrix();
    if (!town) {
      sun.position.set(-4, 5.5, 2.5);
      sun.target.position.set(0, 0, 0);
      sun.target.updateMatrixWorld();
    }
  };
  fitShadows();
  /** Outdoors, the sun (or the moon) shines from where the hour puts it, on the ground round `at`. */
  const aimSun = (at: [number, number]) => {
    const [x, y, z] = lightFrom(hour);
    sun.target.position.set(at[0], 0, at[1]);
    sun.position.set(at[0] + x * 50, y * 50, at[1] + z * 50);
    sun.target.updateMatrixWorld();
    sunAt = at;
  };
  /**
   * Outdoors, the street lamps nearest `at` light the street after dark; the
   * others only glow. By day they light nothing, so they are put away, and the
   * whole town is drawn without them.
   */
  const lightStreets = (at: [number, number]) => {
    if (!isOutdoors(room)) return;
    const near = nearestLamps(room.town.lamps, at, LIT_LAMPS);
    const on = !!lit?.lamp.on;
    for (const [i, light] of bulbs.entries()) {
      const lamp = near[i];
      light.visible = on && !!lamp;
      if (lamp) light.position.set(lamp[0], 3.2, lamp[1]);
    }
    litAt = at;
  };
  let lit: Lighting | undefined;
  const light = (l: Lighting) => {
    lit = l;
    // Paper on the walls (a board, a calendar) takes on a home's lamplight after dark; a screen lights itself.
    layer.dom.style.setProperty("--surface-paper", lights === "home" && l.lamp.on ? LAMPLIT : "none");
    // Outdoors: the sky for the hour, the street lamps on after dark, and the far distance lost in the sky's haze.
    if (town) {
      town.setHour(hour, l.lamp.on, l.glow ?? 0);
      town.setWindows(activities, hour, occupied);
      scene.fog = new THREE.Fog(skyFor(hour).horizon, 90, 380);
      aimSun(sunAt ?? [me.walker.place.x, me.walker.place.z]);
      lightStreets(litAt ?? [me.walker.place.x, me.walker.place.z]);
    } else for (const bulb of bulbs) bulb.visible = true;
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

  const camera = new THREE.PerspectiveCamera(ROOM_VIEW.fov, 1, isOutdoors(room) ? 0.15 : 0.05, farFor(room));
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
        // A door in the town too far off to be drawn is no more in the way than it is clickable.
        if (!sight.intersectObjects(scenery, true).some((h) => shown(h.object))) return { azimuth: a, distance: d };
      }
    }
    return { azimuth: preferred, distance };
  };

  /** How a visitor gets around: walking their body, with the camera following, or flying the camera. */
  let travel: Travel = "walk";
  /** Pixels of the stage covered by something laid over it: a chat panel on the right, a toolbar, a phone's chat below. */
  /** Pixels on the right the scene isn't framed in: the chat's column, and the strip for panels while it is taken. */
  let insetRight = 0;
  let insetTop = 0;
  let insetBottom = 0;
  /** The chat's column, as wide as the page says: always kept out of the scene's framing. */
  let columnRight = 0;
  /** Pixels on the right the page keeps for its panels beside things (`anchors.ts`), taken only as `stripTaken` says. */
  let panelRoom = 0;
  /** How many panels are docked at the side and not to be put away: while any is, the strip is taken for them. */
  let docked = 0;
  /** How many panels are on the room's plaque: while any is, the plaque doesn't say what a click on it opens. */
  let onPlaque = 0;
  /** How tall a panel shown as a sheet over the stage's foot is, on a narrow stage: the camera frames what is above it. */
  let sheetTall = 0;
  /** The stage's size in pixels, as of the last resize: read every frame, so not asked of the page every frame. */
  let stageW = Math.max(1, host.clientWidth);
  let stageH = Math.max(1, host.clientHeight);
  /** Where the controls over the stage are, in pixels from its top left, as last measured. */
  let covered: Box[] = [];
  /** The part of the stage the camera frames into: what is not covered, clear of the controls where they are in the way. */
  let part: Part = { left: 0, right: stageW, top: 0, bottom: stageH };
  /** What else on the stage the page's panels keep clear of, as last measured: the keys hint along its foot. */
  let hints: Box[] = [];
  /**
   * Take the strip kept for panels from the scene, or give it back, as what
   * is open and what is being read say (`stripTaken`); whether that moved the
   * edge of what the scene is framed in.
   */
  const applyStrip = (): boolean => {
    const take = stripTaken({
      room: panelRoom,
      stage: stageW,
      seen: stageW - columnRight,
      reading: !!reading,
      docked: docked > 0,
    });
    const right = columnRight + (take ? panelRoom : 0);
    if (right === insetRight) return false;
    insetRight = right;
    return true;
  };
  /** Measure the controls over the stage, and so the part it frames into; whether that part changed. */
  const measureOverlays = () => {
    const box = host.getBoundingClientRect();
    const boxes = (els: Element[]) =>
      els
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({
          left: r.left - box.left,
          right: r.right - box.left,
          top: r.top - box.top,
          bottom: r.bottom - box.top,
        }));
    covered = boxes(opts.overlays?.() ?? []);
    hints = boxes(opts.hints?.() ?? []);
    const was = part;
    part = framedIn(
      { left: 0, right: stageW - insetRight, top: insetTop, bottom: stageH - insetBottom - sheetTall },
      covered,
    );
    return (
      Math.abs(part.left - was.left) +
        Math.abs(part.right - was.right) +
        Math.abs(part.top - was.top) +
        Math.abs(part.bottom - was.bottom) >
      1
    );
  };
  /** The shape of the part of the stage the camera frames into: framing fits the room into that. */
  const visibleAspect = () => Math.max(MIN_ASPECT, (part.right - part.left) / Math.max(1, part.bottom - part.top));
  /** The share of the stage's height the camera frames into, between the toolbar and a phone's chat. */
  const visibleTall = () => Math.min(1, Math.max(0.2, (part.bottom - part.top) / stageH));
  /** How much round you the walking camera takes in, as last zoomed: indoors or out. */
  const reachNow = () => (isOutdoors(room) ? outdoorReachKept : reachKept);
  /**
   * Coming into a room on a visit, the camera shows what the room is
   * gathered round as well as you (`centrepieces`): its table and its task
   * board, rather than you alone at the door. It looks `lead` past your head,
   * taking in what `entering` says, until you walk off from where you came in
   * or zoom; then it comes back to you, smoothly.
   */
  const lead = new THREE.Vector3();
  const entering = new Arrival();
  /** Done with the shot of the room on the way in, at once: flying off, or brought to stand before someone. */
  const dropLead = () => {
    entering.drop();
    lead.set(0, 0, 0);
  };
  /** How much round you the walking camera takes in this moment: on the way in, what it shows of the room. */
  const reachShown = () => entering.reach ?? reachNow();
  /** How far back the camera following a visitor sits: the reach they zoomed to, in what can be seen of this room. */
  const followBack = () =>
    followDistance(clampReach(reachShown(), widestReach(room)), visibleAspect(), ROOM_VIEW.fov, visibleTall());
  /**
   * The share of what can be seen that the keys hint covers along its foot:
   * the shot on the way in is framed above it, so your feet aren't under it.
   */
  const hintFoot = () => {
    const h = part.bottom - part.top;
    const tops = hints
      .filter((b) => b.left < part.right && part.left < b.right && b.top < part.bottom)
      .map((b) => b.top);
    if (!tops.length || h <= 0) return 0;
    return Math.min(0.4, Math.max(0, (part.bottom - Math.min(...tops) + HINT_MARGIN) / h));
  };
  /**
   * The share of what can be seen that the rows of tools along its top cover:
   * the shot on the way in is framed below them, so nothing on the far wall
   * is under a button. They are no bar the whole scene is framed under (see
   * `framedIn`), being up in a corner, but what hangs there is there to read.
   */
  const toolsHead = () => {
    const h = part.bottom - part.top;
    const bottoms = covered
      .filter((b) => b.left < part.right && part.left < b.right && b.top < part.top + h / 4 && b.bottom > part.top)
      .map((b) => b.bottom);
    if (!bottoms.length || h <= 0) return 0;
    return Math.min(0.4, Math.max(0, (Math.max(...bottoms) - part.top + HINT_MARGIN) / h));
  };
  /** Where you stand come into a room, and how much of it the camera shows from there: see `lead`. */
  const aimArrival = () => {
    lead.set(0, 0, 0);
    entering.reach = undefined;
    if (!entering.holds || !opts.visitor || travel !== "walk" || isOutdoors(room)) return;
    const gathered = centrepieces(room);
    if (!gathered.length) return;
    // What the room is gathered round, and what hangs on its walls to be read: its calendar, its screens, its boards.
    const boxes = [...gathered, ...room.props.filter((p) => READ_ON_WALLS.has(p.kind)).map((p) => p.id)].flatMap(
      (id) => {
        const thing = things.get(id);
        return thing ? [new THREE.Box3().setFromObject(thing)] : [];
      },
    );
    const p = me.walker.place;
    // You from your feet to the top of your head, however tall you were made, the corners of each thing, and
    // everyone here and every seat at the table to the top of a tall body's head, so nobody sat there is cut off.
    const tops = [...companions.values()].map((c): [number, number, number] => [
      c.walker.place.x,
      c.bounds.max.y + 0.15,
      c.walker.place.z,
    ]);
    const seats = room.spots
      .filter((sp) => /^seat-\d+$/.test(sp.id))
      .map((sp): [number, number, number] => [sp.at[0], SEATED_TOP, sp.at[1]]);
    const points: [number, number, number][] = [
      [p.x, 0, p.z],
      [p.x, me.bounds.max.y + 0.15, p.z],
      ...tops,
      ...seats,
      ...boxes.flatMap((b) =>
        [b.min, b.max].flatMap((y) =>
          [
            [b.min.x, b.min.z],
            [b.max.x, b.min.z],
            [b.min.x, b.max.z],
            [b.max.x, b.max.z],
          ].map(([x, z]): [number, number, number] => [x, y.y, z]),
        ),
      ),
    ];
    const shot = fitView(points, visibleAspect(), visibleTall(), hintFoot(), toolsHead());
    const reach = reachAt(shot.distance, visibleAspect(), ROOM_VIEW.fov, visibleTall());
    // Further than the room's widest is the whole room already: as near as that, looking where the shot says.
    entering.fit(reach, reachNow(), visibleTall(), widestReach(room));
    lead.set(...shot.target).sub(me.head());
  };

  const framing = (view: StageView): Framing => {
    if (view === "close") {
      const top = me.bounds.max.y;
      const span = (top - me.hipsY) * 1.25;
      // A selfie stands back a little further than the chat page's close-up, so the room shows behind.
      const distance = closeDistance(span, visibleAspect(), visibleTall()) * (selfie ? 1.5 : 1);
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
    const target = opts.visitor ? me.head().add(lead) : new THREE.Vector3(...(focus?.target ?? ROOM_TARGET));
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
    // A visitor can look all the way round, and from nearly overhead to the floor, or flying, any way at all;
    // reading a surface, straight at it.
    if (opts.visitor && !reading) {
      [controls.minAzimuthAngle, controls.maxAzimuthAngle] = [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
      [controls.minPolarAngle, controls.maxPolarAngle] = travel === "fly" ? [0.05, Math.PI - 0.05] : [0.15, 1.5];
    }
    // Reading a surface, the view holds still on it: dragging doesn't turn it away.
    controls.enabled = !reading;
    controls.update();
  };

  // The surfaces under the picture, which shows them through holes; the picture over them takes the pointer.
  host.appendChild(layer.dom);
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-hidden", "true");
  // How far the picture is shifted left and up, in pixels, so the scene is centred in the part of the stage it is
  // framed in (`part`). A panel opening or closing eases it there, rather than jumping.
  let shift: [number, number] = [0, 0];
  let framed = false;
  const wantShift = (): [number, number] => {
    // Reading a surface, it is centred in the box it is read in instead (`readingBox`).
    const p = reading ? readingBox() : part;
    return [
      p.right > p.left ? (stageW - p.right - p.left) / 2 : 0,
      p.bottom > p.top ? (stageH - p.bottom - p.top) / 2 : 0,
    ];
  };
  const project = () => {
    if (Math.abs(shift[0]) > 0.5 || Math.abs(shift[1]) > 0.5)
      camera.setViewOffset(stageW, stageH, shift[0], shift[1], stageW, stageH);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  const resize = () => {
    stageW = Math.max(1, host.clientWidth);
    stageH = Math.max(1, host.clientHeight);
    applyStrip();
    renderer.setSize(stageW, stageH, false);
    layer.setSize(stageW, stageH);
    camera.aspect = stageW / stageH;
    measureOverlays();
    refit();
  };
  /** Fit the camera to the part of the stage it frames into, as that is now. */
  const refit = () => {
    if (!framed || opts.reducedMotion) shift = wantShift();
    project();
    // Reading a surface, it is framed again in what can be seen now: a panel opened beside it, say.
    if (reading) {
      const f = readingFraming(reading);
      if (f) moveCamera(f);
      raiseWall(reading, f);
      return;
    }
    // Still where you came in, the shot of the room is fitted to what can be seen now: a chat panel opened beside it.
    if (entering.holds) aimArrival();
    // A visitor's camera eases to its distance each frame (`frameUp`); flying, it stays where it was flown.
    if (tween || opts.visitor) return;
    // Keep the angle the person dragged to; only the distance follows the frame's shape.
    const fitted = editing ? editFraming() : framing(view);
    const offset = camera.position.clone().sub(controls.target);
    if (offset.lengthSq() === 0) settle(fitted);
    else camera.position.copy(controls.target).add(offset.setLength(fitted.position.distanceTo(fitted.target)));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  // On a visit, come in showing what the room is gathered round as well as you.
  if (opts.visitor) {
    entering.begin([me.walker.place.x, me.walker.place.z]);
    aimArrival();
  }
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
    if (!opts.visitor || travel !== "walk" || tween || editing || reading) return;
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
    if (isOutdoors(room)) outdoorReachKept = reach;
    else reachKept = reach;
    // Zoomed by hand, the shot on the way in is over, as if you had walked off: the reach is yours from here, the
    // camera comes back round to you as you zoom, and a panel opening or someone coming in doesn't put the shot back.
    entering.zoomed();
  };
  /** The chat page's view of the agent, which the wheel and a pinch bring nearer or take further back. */
  const ownView = () => !opts.visitor && !opts.still && view === "room";
  /** Whether you fly about as you like: in your own body, with nothing brought up to read. */
  const flyingFree = () => !!opts.visitor && travel === "fly" && !reading;
  /** Fly this many metres along the way you look, forward, or back for less than none. */
  const flyAlong = (metres: number) => {
    const along = controls.target.clone().sub(camera.position).normalize().multiplyScalar(metres);
    camera.position.add(along);
    controls.target.add(along);
    keepFlying();
  };
  /** A zoom while rearranging, kept between the nearest it comes and the whole room. */
  const editZoomTo = (zoom: number) => {
    editZoom = Math.min(1, Math.max(EDIT_NEAREST, zoom));
  };
  const onWheel = (e: WheelEvent) => {
    if (editing) {
      e.preventDefault();
      editZoomTo(editZoom * REACH_PER_NOTCH ** (wheelPixels(e) / 100));
      return;
    }
    if (ownView()) {
      e.preventDefault();
      zoomKept = ownZoom(zoomKept * REACH_PER_NOTCH ** (wheelPixels(e) / 100), room, visibleAspect(), visibleTall());
      return;
    }
    // Flying, the wheel flies you along the way you look, back as it rolls toward you and on as it rolls away.
    if (flyingFree()) {
      e.preventDefault();
      flyAlong(flyWheelStep(wheelPixels(e)));
      return;
    }
    if (!opts.visitor || travel !== "walk") return;
    e.preventDefault();
    const widest = widestReach(room);
    zoomTo(wheelReach(clampReach(reachShown(), widest), wheelPixels(e), widest));
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
   * Two fingers down, walking: a pinch, which zooms and nothing else; flying,
   * it flies you on or back, as the wheel does. The controls would go on
   * turning the view with the first finger, so turning waits until a finger
   * is lifted.
   */
  const pinching = () => {
    const now = touches.size === 2 && (!!editing || (!!opts.visitor && travel === "walk") || flyingFree() || ownView());
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
      if (editing) editZoomTo((editZoom * apart) / now);
      else if (ownView()) zoomKept = ownZoom((zoomKept * apart) / now, room, visibleAspect(), visibleTall());
      else if (flyingFree()) flyAlong(flyPinchStep(apart, now));
      else zoomTo(pinchReach(clampReach(reachShown(), widest), apart, now, widest));
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
  /** The thing in the room something is part of, by its id: what a panel opened from it is kept beside. */
  const thingOf = (o: THREE.Object3D | undefined): string | undefined => {
    for (let p = o; p; p = p.parent ?? undefined) if (typeof p.userData.prop === "string") return p.userData.prop;
    return undefined;
  };
  /**
   * Whether something is part of a gate all but gone for someone standing
   * behind it (`GATE_FAINT`), other than the mat at its foot, which stays: a
   * pointer on it is on what is behind it, as it looks.
   */
  const gateGone = (thing: THREE.Object3D) => {
    if (thing.userData.keep) return false;
    for (let o: THREE.Object3D | null = thing; o; o = o.parent) {
      const f = fadeable.find((x) => x.group === o);
      if (f) return f.faint !== undefined && f.level < 0.5;
    }
    return false;
  };
  const pick = (e: At): (Use & { on?: UseSpot; object: THREE.Object3D }) | undefined => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    const found = nearestUse(ray.intersectObjects(clickable, true).filter((h) => !gateGone(h.object)));
    if (!found) return undefined;
    const { hit } = found;
    const use = { ...found.use, object: hit.object };
    // On a screen, the page that is up: a click opens what it shows.
    const card = cards[shownPage];
    if (use.action && card && screens.some((s) => s.face === hit.object)) return { ...use, on: { card: card.id } };
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
    // A raycaster hits what isn't drawn all the same: a tag put away, a bubble that gave way, a tail too short to show.
    for (const hit of ray.intersectObjects([...bodies.keys()], true)) {
      if (!shown(hit.object)) continue;
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
    // Rearranging, a click picks a thing or nothing, and a drag moves it: nobody is gone to, and no door opens.
    if (editing) {
      letGo(moved > 6 || pinch);
      return;
    }
    if (moved > 6 || pinch) return;
    // An agent first: a body stands in front of the furniture it is at.
    const who = opts.onPick ? agentAt(e) : undefined;
    if (who) {
      opts.onPick?.(who, { x: e.clientX, y: e.clientY });
      return;
    }
    // A surface: one with more on it is brought up to read; a kiosk's live button is pressed. A kiosk too far off to
    // be live does what it is for, as anything made to be used does.
    const surface = surfaceUnder(e);
    if (surface && layer.howUsed(surface) === "focus") {
      bringUp(surface);
      return;
    }
    if (surface && layer.interactive(surface)) {
      passOn(e);
      return;
    }
    const it = pick(e);
    if (it?.action && opts.onUse) {
      opts.onUse(it.action, it.on, thingOf(it.object));
      // What it opened is beside it now: the label saying what a click does would only be under it.
      if (overPlaque) {
        plaque?.highlight(false);
        overPlaque = false;
        opts.onPlaqueHover?.(undefined);
      }
      return;
    }
    if (it?.door && opts.onDoor) {
      leave(it.door);
      return;
    }
    // A building in the town: up to its door.
    if (it?.approach && opts.visitor && travel === "walk") {
      greeting = undefined;
      me.goTo(room, it.approach, obstacles);
      return;
    }
    if (it?.spot) go(it.spot);
    else if (opts.visitor && travel === "walk") {
      const to = floorAt(e);
      if (to) {
        greeting = undefined;
        me.goTo(room, isOutdoors(room) ? ashore(room.town, to, me.radius) : to, obstacles);
      }
    }
  };
  // Where the mouse is over the stage, so what is under it is looked at again as the view moves under a still pointer.
  let pointer: At | undefined;
  // The surface under the pointer that a click brings up, whose name the page is showing by the pointer.
  let hoveredSurface: string | undefined;
  const onHover = (e: PointerEvent) => {
    if (downAt || e.pointerType !== "mouse") return;
    pointer = { clientX: e.clientX, clientY: e.clientY };
    hoverAt(pointer);
  };
  /** What is under the pointer now: a body's tag says more, a door lights up and says where it goes. */
  const hoverAt = (e: At) => {
    // Rearranging, what is under the pointer is something to pick up (see `onEditMove`), not somewhere to go.
    if (editing) return;
    const who = agentAt(e);
    if (who !== hovered) hover(who);
    // A surface brought up to read when clicked says so while the pointer is on it: found as a click finds it
    // (`surfaceUnder`), so a face on anything says so, a model's on a wall too, and what a click does is what it says.
    const surface = !who && overAFace(e) ? surfaceUnder(e) : undefined;
    const reads = surface && !reading && layer.howUsed(surface) === "focus" ? surface : undefined;
    // A click on a surface does what the surface is for, not what is behind or around it.
    const it = reads ? undefined : pick(e);
    // A body stands in front of a door; the door behind it isn't what the pointer is on.
    const door = !who && !leaving && opts.onDoor ? it?.door : undefined;
    const box = canvas.getBoundingClientRect();
    hoverDoor(door, { x: e.clientX - box.left, y: e.clientY - box.top });
    layer.hover(reads);
    if (reads || hoveredSurface)
      opts.onSurfaceHover?.(reads ? layer.labelOf(reads) : undefined, {
        x: e.clientX - box.left,
        y: e.clientY - box.top,
      });
    hoveredSurface = reads;
    // The room's plaque lights up, and says what a click on it opens, unless that is open on it already.
    const plaqued = !who && !!plaque && it?.action === "place" && !onPlaque;
    if (plaqued !== overPlaque) {
      plaque?.highlight(plaqued);
      overPlaque = plaqued;
      if (!plaqued) opts.onPlaqueHover?.(undefined);
    }
    if (plaqued) opts.onPlaqueHover?.({ x: e.clientX - box.left, y: e.clientY - box.top });
    const approach = !!it?.approach && opts.visitor && travel === "walk";
    canvas.style.cursor =
      (opts.onPick && who) || reads || it?.spot || (it?.action && opts.onUse) || door || approach ? "pointer" : "";
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
    layer.hover(undefined);
    if (hoveredSurface) opts.onSurfaceHover?.(undefined);
    hoveredSurface = undefined;
    if (overPlaque) {
      plaque?.highlight(false);
      overPlaque = false;
      opts.onPlaqueHover?.(undefined);
    }
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
  layer.dom.style.transition = canvas.style.transition;
  /** The picture, and the surfaces under it, which would otherwise show through as it fades. */
  const fadeTo = (opacity: number) => {
    canvas.style.opacity = String(opacity);
    layer.dom.style.opacity = String(opacity);
  };
  let leaving: { door: RoomDoor; giveUp: ReturnType<typeof setTimeout> } | undefined;
  const fadeIn = () => {
    if (leaving) clearTimeout(leaving.giveUp);
    leaving = undefined;
    fadeTo(1);
  };
  function leave(door: RoomDoor) {
    if (leaving || !opts.onDoor) return;
    hoverDoor(undefined);
    // Nothing came back in time: you are still here, and can try again.
    leaving = { door, giveUp: setTimeout(fadeIn, DOOR_PATIENCE_MS) };
    fadeTo(0);
    setTimeout(
      () => {
        if (!disposed) opts.onDoor?.(door);
      },
      opts.reducedMotion ? 0 : FADE_MS,
    );
  }
  // Come in through a door: from dark.
  if (arrival) {
    fadeTo(0);
    requestAnimationFrame(() => requestAnimationFrame(fadeIn));
  }
  // A visitor's keys: held keys move them every frame, unless they are typing or working in a panel over the stage.
  const held = new Set<string>();
  // Keys pressed in a card in the world are the card's, as it is a dialog. Your conversation in the world is not one:
  // after a click on its buttons, the keys still walk you, as they did after a click in the chat's column.
  const typing = (e: KeyboardEvent) =>
    (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog']");
  // Keys held through a door, until they are let go: the view faces the same way on the other side, so holding W
  // into a door at the back would otherwise walk you straight back out of the one you came in by.
  const waiting = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    // Rearranging, the keys turn and remove things (the page's), and you stay where you are; reading a surface, they
    // are the surface's.
    if (editing || reading) return;
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
  // --- Rearranging the room (see `editing.ts`) ---

  const handles = new Handles();
  scene.add(handles.group);
  /**
   * A thing being dragged: which, how far from its middle it was picked up,
   * where the pointer went down, whether it has moved yet, and the last place
   * it would go, with its key. `dropped` is where it was let go, shown until
   * the page answers, so it never jumps back for a frame.
   */
  let drag:
    | { item: string; grab: [number, number]; from: [number, number]; moving: boolean; last?: Move; key?: string }
    | undefined;
  let dropped: Move | undefined;

  /** The camera while rearranging: from the room view's angle, back as far as the zoom says from taking in the room. */
  const editFraming = (): Framing => {
    const target = new THREE.Vector3(...ROOM_TARGET);
    const distance = roomDistance(room, visibleAspect(), visibleTall()) * editZoom;
    return {
      target,
      position: new THREE.Vector3()
        .setFromSphericalCoords(distance, Math.PI / 2 - ROOM_VIEW.elevation, ROOM_VIEW.azimuth)
        .add(target),
      azimuth: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      polar: [0.12, 1.35],
    };
  };
  /** Point the ray at where the pointer is. */
  const aim = (e: At) => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
  };
  /**
   * The thing under the pointer, by id: what a click picks up while
   * rearranging. A door someone put in can be picked too, to take out, by
   * the id the page knows it by (`doorItem`).
   */
  const thingAt = (e: At): string | undefined => {
    aim(e);
    const made = clickable.filter((o) => !!(o.userData.door as RoomDoor | undefined)?.by);
    for (const hit of ray.intersectObjects([...things.values(), ...made], true))
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        if (typeof o.userData.prop === "string") return o.userData.prop as string;
        const door = o.userData.door as RoomDoor | undefined;
        if (door?.by) return doorItem(door.to);
      }
    return undefined;
  };
  /** Where the pointer's line of sight crosses a height, on the floor plan. */
  const crossing = (height: number): [number, number] | undefined => {
    const hit = ray.ray.intersectPlane(new THREE.Plane(UP, -height), new THREE.Vector3());
    return hit ? [hit.x, hit.z] : undefined;
  };
  /** Where on the walls the pointer is, on the floor plan: the nearer of the back and left walls it points at, else the floor. */
  const onWalls = (): [number, number] | undefined => {
    const hits: { at: [number, number]; far: number }[] = [];
    const back = ray.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), room.depth / 2),
      new THREE.Vector3(),
    );
    if (back && Math.abs(back.x) <= room.width / 2 && back.y >= 0 && back.y <= room.height)
      hits.push({ at: [back.x, -room.depth / 2], far: back.distanceTo(camera.position) });
    const left = ray.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(1, 0, 0), room.width / 2),
      new THREE.Vector3(),
    );
    if (left && Math.abs(left.z) <= room.depth / 2 && left.y >= 0 && left.y <= room.height)
      hits.push({ at: [-room.width / 2, left.z], far: left.distanceTo(camera.position) });
    hits.sort((a, b) => a.far - b.far);
    return hits[0]?.at ?? crossing(0);
  };
  /** Where the thing being dragged would go, for the pointer here: on the floor, along a wall, or on a top. */
  const moveFor = (e: PointerEvent): Move | undefined => {
    // A door put in slides along the sides of the room: to the side nearest the pointer, as far along it as it goes.
    if (drag && editing && doorItemTo(drag.item)) {
      aim(e);
      const floor = crossing(0);
      return floor ? { item: drag.item, at: doorPoint(room, doorSlotAt(room, floor)), facing: 0 } : undefined;
    }
    const prop = drag && editing ? room.props.find((p) => p.id === drag?.item) : undefined;
    if (!drag || !editing || !prop) return undefined;
    aim(e);
    const kinds = editing.kinds;
    const kind = kinds[prop.kind];
    const free = e.shiftKey;
    const pending = editing.pending?.item === prop.id ? editing.pending : undefined;
    const facing = pending?.facing ?? prop.facing;
    if (kind?.mount === "wall") {
      const point = onWalls();
      if (!point) return undefined;
      const hung = onWall(room, point, footprint(prop, kinds)[0], free);
      return { item: prop.id, at: hung.at, facing: hung.facing, elevation: prop.elevation ?? kind.elevation };
    }
    if (kind?.mount === "on" || prop.on) {
      const top = onTop(room, kinds, prop, crossing, free);
      if (top) return { item: prop.id, at: top.at, facing, on: top.on, elevation: top.elevation };
      // Over nothing with a top: shown on the floor, where it can't stay.
      const floor = crossing(0);
      return floor ? { item: prop.id, at: onFloor(room, floor, free), facing, elevation: 0, loose: true } : undefined;
    }
    const floor = crossing(0);
    if (!floor) return undefined;
    const size = footprint(prop, kinds);
    const at = onFloor(room, [floor[0] - drag.grab[0], floor[1] - drag.grab[1]], free, size, kind?.round ? 0 : facing);
    // What goes with it comes along (`groupOf`): the chairs at a table, what stands on a rug. Alt moves it alone.
    const along = e.altKey ? [] : groupOf(room, kinds, prop.id);
    return { item: prop.id, at, facing, ...(along.length ? { with: along } : {}) };
  };

  /** Everything shown somewhere else, back where the room has it. */
  const putBack = () => {
    if (shiftedDoor) {
      const { at, facing } = doorFrame(room, shiftedDoor.door);
      shiftedDoor.group.position.set(at[0], 0, at[1]);
      shiftedDoor.group.rotation.y = rad(facing);
      shiftedDoor = undefined;
    }
    for (const id of shifted) {
      const prop = room.props.find((p) => p.id === id);
      const g = things.get(id);
      if (!prop || !g) continue;
      g.position.set(prop.at[0], prop.elevation ?? 0, prop.at[1]);
      g.rotation.y = rad(prop.facing);
    }
    shifted.clear();
  };
  /** Show a thing where it is being put, turned as it is turned, and what stands on it along with it. */
  const shiftTo = (move: Move) => {
    const prop = room.props.find((p) => p.id === move.item);
    if (!prop) return;
    const hangs = editing?.kinds[prop.kind]?.mount === "wall";
    const lift = move.elevation ?? (hangs || prop.on ? (prop.elevation ?? 0) : 0);
    const turn = rad(move.facing - prop.facing);
    const from = new THREE.Vector3(prop.at[0], prop.elevation ?? 0, prop.at[1]);
    const to = new THREE.Vector3(move.at[0], lift, move.at[1]);
    // It, what goes with it, and what stands on any of them: each kept in its place round it, turned as it turns.
    const along = move.with ?? [];
    for (const id of [prop.id, ...along, ...[prop.id, ...along].flatMap((a) => ridersOf(room, a))]) {
      const p = room.props.find((x) => x.id === id);
      const g = things.get(id);
      if (!p || !g) continue;
      const offset = new THREE.Vector3(p.at[0], p.elevation ?? 0, p.at[1]).sub(from).applyAxisAngle(UP, turn);
      g.position.copy(to).add(offset);
      g.rotation.y = rad(p.facing) + turn;
      shifted.add(id);
    }
  };
  /** The footprint to draw for a thing, where it is shown: on the floor or its top, or the patch of wall it covers. */
  const patchOf = (prop: Prop, move: Move | undefined, kinds: Kinds): Patch => {
    const at = move?.at ?? prop.at;
    const [width, depth] = footprint(prop, kinds);
    const kind = kinds[prop.kind];
    if (kind?.mount === "wall")
      return {
        on: wallOf(room, at, Number.POSITIVE_INFINITY) ?? "back",
        at,
        elevation: move?.elevation ?? prop.elevation ?? kind.elevation ?? 1.2,
        width,
        height: heightOf(prop, kinds),
      };
    const y = move?.elevation ?? (prop.on ? (prop.elevation ?? 0) : 0);
    return { on: "floor", at, y, width, depth, facing: kind?.round ? 0 : (move?.facing ?? prop.facing) };
  };
  /**
   * Draw what is picked and where it is going: the thing itself, moved there
   * ahead of being saved, with a box round it and its footprint coloured by
   * whether it fits, as the page last heard for that place.
   */
  const markEdit = () => {
    putBack();
    // A door put in, picked: lit up until something else is.
    const to = doorItemTo(editing?.selected);
    const door = to ? room.doors?.find((d) => d.to === to && d.by) : undefined;
    if (door !== pickedDoor) {
      if (pickedDoor && pickedDoor !== overDoor) doorHighlights.get(pickedDoor)?.(false);
      if (door) doorHighlights.get(door)?.(true);
      pickedDoor = door;
    }
    const prop = editing?.selected ? room.props.find((p) => p.id === editing?.selected) : undefined;
    // For anyone inspecting the page, like `data-motion`: what is picked, and whether it fits where it is going.
    host.dataset.picked = prop?.id ?? (door ? doorItem(door.to) : "");
    if (editing && door) {
      // A door put in, being dragged: drawn where it is going, the floor in front of it coloured by whether it fits.
      const id = doorItem(door.to);
      const group = clickable.find((o) => o.userData.door === door);
      const pending = editing.pending?.item === id ? editing.pending : undefined;
      const held = drag?.moving && drag.item === id ? drag.last : dropped?.item === id ? dropped : undefined;
      const shown = held ?? pending;
      if (!shown || !group) {
        host.dataset.fit = "";
        handles.show(undefined, undefined, "picked");
        return;
      }
      const slot = doorSlotAt(room, shown.at);
      const { at, facing } = doorFrame(room, { ...door, ...slot });
      group.position.set(at[0], 0, at[1]);
      group.rotation.y = rad(facing);
      shiftedDoor = { group, door };
      const fit: Fit =
        moveKey(shown) !== moveKey(pending) || pending?.fits === undefined ? "asking" : pending.fits ? "fits" : "no";
      host.dataset.fit = fit;
      handles.show(group, { on: "floor", y: 0, ...doorPatch(room, slot) }, fit);
      return;
    }
    if (!editing || !prop) {
      host.dataset.fit = "";
      handles.show(undefined, undefined, "picked");
      return;
    }
    const pending = editing.pending?.item === prop.id ? editing.pending : undefined;
    const held = drag?.moving && drag.item === prop.id ? drag.last : dropped?.item === prop.id ? dropped : undefined;
    const shown = held ?? pending;
    if (shown) shiftTo(shown);
    const fit: Fit = !shown
      ? "picked"
      : shown.loose
        ? "no"
        : moveKey(shown) !== moveKey(pending) || pending?.fits === undefined
          ? "asking"
          : pending.fits
            ? "fits"
            : "no";
    host.dataset.fit = fit;
    // What goes with it, where it is going too: dragged, or as it would go with it if dragged now.
    const kinds = editing.kinds;
    const also = (shown?.with ?? []).flatMap((id): Patch[] => {
      const p = room.props.find((x) => x.id === id);
      const to = shown ? carriedTo(room, shown).find((c) => c.id === id) : undefined;
      return p ? [patchOf(p, to && { item: id, at: to.at, facing: to.facing }, kinds)] : [];
    });
    // For anyone inspecting the page, like `data-picked`: what is moving with it.
    host.dataset.along = (shown?.with ?? []).join(" ");
    handles.show(things.get(prop.id), patchOf(prop, shown, kinds), fit, also);
  };
  /** A thing picked up: pressed on, it is picked, and dragging moves it rather than turning the view. */
  const onEditDown = (e: PointerEvent) => {
    if (!editing || (e.pointerType === "mouse" && e.button !== 0)) return;
    // A second finger is a pinch: whatever the first was dragging goes back.
    if (e.pointerType === "touch" && touches.size > 0) {
      drag = undefined;
      if (!tween) controls.enabled = true;
      markEdit();
      return;
    }
    const id = thingAt(e);
    if (!id) return;
    const prop = room.props.find((p) => p.id === id);
    const pending = editing.pending?.item === id ? editing.pending : undefined;
    const at = pending?.at ?? prop?.at ?? [0, 0];
    const floor = crossing(0) ?? at;
    drag = { item: id, grab: [floor[0] - at[0], floor[1] - at[1]], from: [e.clientX, e.clientY], moving: false };
    controls.enabled = false;
    canvas.setPointerCapture?.(e.pointerId);
    editing.onSelect(id);
  };
  /** The pointer moving while rearranging: what is held follows it, and the hand says what can be picked up. */
  const onEditMove = (e: PointerEvent) => {
    if (!editing) return;
    if (!drag) {
      if (e.pointerType === "mouse" && !downAt) canvas.style.cursor = thingAt(e) ? "grab" : "";
      return;
    }
    if (!drag.moving && Math.hypot(e.clientX - drag.from[0], e.clientY - drag.from[1]) < 4) return;
    drag.moving = true;
    canvas.style.cursor = "grabbing";
    const move = moveFor(e);
    if (!move || moveKey(move) === drag.key) return;
    drag.key = moveKey(move);
    drag.last = move;
    markEdit();
    editing.onDrag(move);
  };
  /** Let go: what was dragged is put down where it is, for the page to check and save; a click on nothing picks nothing. */
  function letGo(turnedTheView: boolean) {
    const held = drag;
    drag = undefined;
    if (!tween) controls.enabled = true;
    canvas.style.cursor = "";
    if (held?.moving && held.last) {
      dropped = held.last;
      editing?.onDrop(held.last);
    } else if (!held && !turnedTheView) editing?.onSelect(undefined);
    markEdit();
  }
  const onEditCancel = () => {
    if (!drag) return;
    drag = undefined;
    if (!tween) controls.enabled = true;
    markEdit();
  };
  // Ahead of the controls, so a thing pressed on is held before they start turning the view.
  canvas.addEventListener("pointerdown", onEditDown, { capture: true });
  canvas.addEventListener("pointermove", onEditMove);
  canvas.addEventListener("pointercancel", onEditCancel);

  // Agents who have noticed the visitor, until the visitor walks away.
  const noticed = new Set<string>();
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", untouch);
  canvas.addEventListener("pointermove", onHover);
  canvas.addEventListener("pointermove", onTouch);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  // --- Surfaces: reading one close up, and the pointer going to the HTML of one in use (see `surface-layer.ts`) ---

  /** Whether something is drawn: it, and everything it is in, is shown. */
  const drawn = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  /** Whether the pointer is on any surface's face at all: a quick look, before what might be in front of it is. */
  const overAFace = (e: At): boolean => {
    const faces = layer.faces();
    if (!faces.length) return false;
    aim(e);
    return ray.intersectObjects(faces, false).some((h) => drawn(h.object));
  };
  /**
   * The surface under a pointer, with nothing nearer in front of it: a body,
   * a chair. A wall or a plant faded to see past doesn't count, as it doesn't
   * for what the pointer says a click does (`pick`).
   */
  const surfaceUnder = (e: At): string | undefined => {
    aim(e);
    const bodies = [me.body, ...[...companions.values()].map((c) => c.body)];
    const hit = ray
      .intersectObjects([furniture, pinned, ...bodies], true)
      .find(
        (h) =>
          !(h.object as THREE.Sprite).isSprite &&
          drawn(h.object) &&
          (layer.surfaceAt(h.object) !== undefined || !fadedNow(h.object)),
      );
    return layer.surfaceAt(hit?.object);
  };
  /**
   * The pointer goes to the HTML of a surface in use (a kiosk's button, the
   * surface being read) while it is over it, and back to the picture once it
   * is off it. Pressed, it stays where it went down, so a drag isn't cut off.
   */
  const route = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || editing || e.buttons) return;
    const take = !!reading || (layer.anyDirect() && layer.interactive(surfaceUnder(e)));
    canvas.style.pointerEvents = take ? "none" : "";
  };
  /** Whether a pointer event came from inside a surface's HTML. */
  const onSurface = (target: EventTarget | null) =>
    target instanceof Node && target !== layer.dom && layer.dom.contains(target);
  /**
   * A tap on a surface that takes it, which went to the picture (a finger
   * has no pointer moving over it first): on to what is under it in the
   * HTML, as a click.
   */
  const passOn = (e: At) => {
    canvas.style.pointerEvents = "none";
    const under = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = reading ? "none" : "";
    if (!(under instanceof HTMLElement) || !onSurface(under)) return;
    const el = under.closest<HTMLElement>("button, a, input, select, textarea, [tabindex]") ?? under;
    el.focus({ preventScroll: true });
    el.click();
  };
  /** Whether a pointer event came from inside the surface being read. */
  const onReading = (target: EventTarget | null) =>
    !!reading && target instanceof Node && !!layer.elementOf(reading)?.contains(target);
  // Pressing anywhere off the surface being read (another surface included), and letting go without dragging: it is
  // put down.
  let awayFrom: [number, number] | undefined;
  const onAwayDown = (e: PointerEvent) => {
    awayFrom = reading && !onReading(e.target) && e.target !== canvas ? [e.clientX, e.clientY] : undefined;
  };
  const onAwayUp = (e: PointerEvent) => {
    const from = awayFrom;
    awayFrom = undefined;
    if (!reading || !from || onReading(e.target)) return;
    if (Math.hypot(e.clientX - from[0], e.clientY - from[1]) <= 6) putDown();
  };
  host.addEventListener("pointermove", route);
  host.addEventListener("pointerdown", onAwayDown);
  host.addEventListener("pointerup", onAwayUp);
  // Keys move the keyboard focus through a surface's HTML, and the browser scrolls what is focused into view: the
  // layer is laid out by the stage, never scrolled.
  const unscroll = () => {
    if (layer.dom.scrollTop || layer.dom.scrollLeft) layer.dom.scrollTo(0, 0);
  };
  layer.dom.addEventListener("scroll", unscroll);

  /** Where the camera was before a surface was brought up: where putting it down goes back to. */
  let readFrom: { position: THREE.Vector3; target: THREE.Vector3 } | undefined;
  // Bodies put out of sight while a surface is read, for standing in the way of it.
  const hidden = new Set<THREE.Object3D>();

  /**
   * The part of the stage a surface being read is fitted into: all of it the
   * page doesn't cover (a chat panel, a phone's chat), below the tools over
   * the top, and clear of the foot, where the chat's bar and the keys line
   * sit when nothing covers it. Across the whole width, tools or no tools: a
   * phone's tools reach far down one side, and the camera would otherwise
   * frame the surface into the narrow strip beside them.
   */
  function readingBox(): Part {
    const top = insetTop;
    const bottom = stageH - insetBottom - sheetTall;
    const middle = (top + bottom) / 2;
    const below = covered.filter((c) => c.top < middle).reduce((low, c) => Math.max(low, c.bottom), top);
    const low = bottom - Math.max(READ_GAP, READ_FOOT - insetBottom);
    return {
      left: READ_GAP,
      right: Math.max(READ_GAP + 1, stageW - insetRight - READ_GAP),
      top: Math.max(top, Math.min(below + READ_GAP, low - READ_LEAST)),
      bottom: low,
    };
  }

  /** The camera reading a surface: head-on, as near as lets all of it fit in what can be seen of the stage. */
  function readingFraming(id: string): Framing | undefined {
    const at = layer.placeOf(id);
    if (!at) return undefined;
    const box = readingBox();
    const high = Math.max(1, box.bottom - box.top);
    const distance = focusDistance(at.size, {
      fov: camera.fov,
      aspect: (box.right - box.left) / high,
      tall: high / stageH,
    });
    const f = focusFraming(at.center.toArray() as Vec3, at.normal.toArray() as Vec3, distance);
    return {
      target: new THREE.Vector3(...f.target),
      position: new THREE.Vector3(...f.position),
      azimuth: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      polar: [0, Math.PI],
    };
  }

  // While a surface high on a wall is read, the wall goes on up past the top of the stage: otherwise the dark over
  // the room shows in a band above it, cutting through the tools.
  let raised: THREE.Mesh | undefined;
  function raiseWall(id: string | undefined, f?: Framing) {
    raised?.removeFromParent();
    raised?.geometry.dispose();
    raised = undefined;
    const at = id ? layer.placeOf(id) : undefined;
    if (!at || !f) return;
    // Only a surface on, or square to, one of the two walls: one turned another way has the room round it.
    const which: Wall | undefined = at.normal.z > 0.98 ? "back" : at.normal.x > 0.98 ? "left" : undefined;
    if (!which) return;
    let wall: THREE.Mesh | undefined;
    furniture.traverse((o) => {
      if (o.userData.panel && o.userData.wall === which) wall = o as THREE.Mesh;
    });
    if (!wall) return;
    const box = readingBox();
    const distance = which === "back" ? f.position.z + room.depth / 2 : f.position.x + room.width / 2;
    const over = overWalls(
      f.target.y,
      distance,
      { fov: camera.fov, stageH, above: (box.top + box.bottom) / 2 },
      room.height,
    );
    if (over <= 0) return;
    const wide = which === "back" ? room.width + 0.1 : room.depth;
    const tall = over + 0.5;
    // In the wall's own colour, even while it is faded for being in the way.
    const material = fadeable.find((x) => x.group === wall)?.own?.get(wall) ?? wall.material;
    raised = new THREE.Mesh(new THREE.PlaneGeometry(wide, tall), material);
    if (which === "back") raised.position.set(-0.05, room.height + tall / 2, -room.depth / 2);
    else {
      raised.position.set(-room.width / 2, room.height + tall / 2, 0);
      raised.rotation.y = Math.PI / 2;
    }
    // Part of the room, taken down with it; nothing to bump into or click.
    furniture.add(raised);
  }

  /** Bring a surface up to read: the camera flies to it, head-on, and the keys and the pointer are its. */
  function bringUp(id: string) {
    // A kiosk is pressed where it stands, never brought up.
    if (editing || opts.still || layer.howUsed(id) !== "focus") return;
    if (!layer.placeOf(id)) return;
    if (!reading) readFrom = { position: camera.position.clone(), target: controls.target.clone() };
    reading = id;
    // Said first: the page's styles tidy the tools over the stage away for reading, and the surface is framed round
    // what is left of them, and of the strip a card beside it has.
    host.dataset.reading = id;
    applyStrip();
    measureOverlays();
    const f = readingFraming(id);
    if (!f) return;
    readBox = boxKey();
    layer.focus(id);
    held.clear();
    greeting = undefined;
    hover(undefined);
    hoverDoor(undefined);
    canvas.style.pointerEvents = "none";
    canvas.style.cursor = "";
    moveCamera(f);
    raiseWall(id, f);
    opts.onFocus?.(id);
  }

  /** What the box a surface is read in was, as a key: when the tools over the stage change it, it is framed again. */
  let readBox = "";
  const boxKey = () => {
    const b = readingBox();
    return [b.left, b.right, b.top, b.bottom].map(Math.round).join(" ");
  };

  /** Put the surface being read down, and go back to where you were; at once when the place is changing anyway. */
  function putDown(instant = false) {
    if (!reading) return;
    reading = undefined;
    // The strip kept for a card beside the surface goes back to the scene, unless something else needs it.
    if (applyStrip()) measureOverlays();
    raiseWall(undefined);
    layer.focus(undefined);
    canvas.style.pointerEvents = "";
    delete host.dataset.reading;
    for (const o of hidden) o.visible = true;
    hidden.clear();
    // The keyboard comes back out of the surface with you.
    const active = document.activeElement;
    if (active instanceof HTMLElement && layer.dom.contains(active)) active.blur();
    const back = readFrom;
    readFrom = undefined;
    if (back && !instant) moveCamera({ ...framing(view), position: back.position, target: back.target });
    else if (!tween) controls.enabled = true;
    opts.onFocus?.(undefined);
  }

  /**
   * While a surface is read, anyone standing between it and the camera is put
   * out of sight, and so is anyone just behind it, whose name and words over
   * their head would otherwise show through it, and anything tall in the way.
   */
  function clearView() {
    const at = reading ? layer.placeOf(reading) : undefined;
    if (!at) return;
    const center = at.center.toArray() as Vec3;
    const normal = at.normal.toArray() as Vec3;
    const distance = at.center.distanceTo(camera.position);
    for (const f of [me, ...companions.values(), ...departing.map((d) => d.fig)]) {
      const p = f.walker.place;
      const inWay =
        blocksView([p.x, 0, p.z], center, normal, at.size[0] / 2, distance) ||
        behindView([p.x, 0, p.z], center, normal, at.size[0] / 2);
      if (inWay && f.body.visible) {
        f.body.visible = false;
        hidden.add(f.body);
      } else if (!inWay && hidden.delete(f.body)) f.body.visible = true;
    }
    // And anything tall standing in the way: a display stand in front of a screen on the wall, say.
    for (const f of fadeable) {
      if (!f.solid) continue;
      const inWay = solidInWay(f.solid, center, normal, at.size[0] / 2, distance);
      if (inWay && f.group.visible) {
        f.group.visible = false;
        hidden.add(f.group);
      } else if (!inWay && hidden.delete(f.group)) f.group.visible = true;
    }
  }

  /**
   * The surface you face that F brings up: in front of your body as you
   * walk, otherwise where the camera looks. Never a kiosk, which is pressed.
   */
  const facedSurface = (): string | undefined => {
    const readable = layer.placed().filter((s) => layer.howUsed(s.id) === "focus");
    if (opts.visitor && travel === "walk") {
      const p = me.walker.place;
      return facingSurface([p.x, me.head().y, p.z], [Math.sin(p.facing), 0, Math.cos(p.facing)], readable);
    }
    const look = controls.target.clone().sub(camera.position);
    return facingSurface(camera.position.toArray() as Vec3, look.toArray() as Vec3, readable, FAR_FACE);
  };
  /** F brings up the surface you face, and puts it down again; Escape puts it down. */
  const onSurfaceKey = (e: KeyboardEvent) => {
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && reading) {
      // Something open over the stage (a task's card, say) is closed by this Escape, not the surface under it.
      if (host.parentElement?.querySelector("[role='dialog']")) return;
      e.preventDefault();
      putDown();
      return;
    }
    if (e.code !== "KeyF" || e.repeat || typing(e)) return;
    const id = reading ? undefined : facedSurface();
    if (!reading && !id) return;
    e.preventDefault();
    if (reading) putDown();
    else if (id) bringUp(id);
  };
  if (!opts.still) window.addEventListener("keydown", onSurfaceKey);

  /**
   * Whether something, or what it is part of, is faded for a body to be seen
   * past it: a surface on it isn't live while it is, and a click goes past it.
   */
  const fadedNow = (thing: THREE.Object3D) => {
    for (let o: THREE.Object3D | null = thing; o; o = o.parent) {
      const f = fadeable.find((x) => x.group === o);
      // Faded until it wears its own materials again, not just until it is nearly opaque.
      if (f) return f.level < 0.995 || f.own !== undefined;
    }
    return false;
  };

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

  /**
   * Show what an agent said, once, over its head: now, or when a reply is
   * timed to follow. Said down the phone, its bubble shows a phone. Said by
   * someone who isn't here, down the phone to someone here on a call with
   * it, it comes out of that one's phone: over its head, edged apart, in the
   * speaker's name. What it says anywhere else isn't heard here at all.
   */
  const hear = (agent: string, line: Line | undefined) => {
    if (!line) return;
    const own = figureOf(agent);
    const through = own ? undefined : heardThrough(agent, line, activities, [self, ...companions.keys()]);
    const f = own ?? (through ? figureOf(through) : undefined);
    if (!f || heard.get(agent) === line.at) return;
    heard.set(agent, line.at);
    const delay = Date.parse(line.at) - Date.now();
    if (!Number.isFinite(delay) || delay < -STALE_LINE_MS) return;
    const at = clock + Math.max(0, delay) / 1000;
    // A body with a tag has its name in the bubble: the tag is put away while it speaks.
    if (!own) f.say(line.text, at, nameOf(agent), { far: true });
    else
      f.say(line.text, at, f === me ? undefined : companions.get(agent)?.name, {
        phone: byPhone(line, activities[agent]?.talk),
      });
    if (opts.visitor && opts.onLine && (f !== me || !own) && !line.voiced)
      voices.push({ agent, text: line.text, at, ...(through ? { via: through } : {}) });
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
      // The far side of a call is heard from the phone it comes out of, down the line.
      const f = v.via ? figureOf(v.via) : companions.get(v.agent);
      if (!f) continue;
      const d = Math.hypot(f.walker.place.x - me.walker.place.x, f.walker.place.z - me.walker.place.z);
      if (travel === "walk" && d <= HEAR_AT) opts.onLine?.(v.agent, v.text, 1 - d / HEAR_AT, !!v.via);
    }
  };
  let speech: Record<string, Line> = {};

  /** The body an agent has in this room, if it has one here. */
  const figureOf = (agent: string): Figure | undefined => (agent === self ? me : companions.get(agent));
  /** An agent's body in the place: here, or on its way out of it, which is still here until it reaches the door. */
  const bodyOf = (agent: string): Figure | undefined =>
    figureOf(agent) ?? departing.find((d) => d.leaving && d.agent === agent)?.fig;
  /** Who is in the place, as last said to the page. */
  let present: string | undefined;
  /** Say who is in the place, when it has changed: those here, and those still walking out. */
  const sayPresent = () => {
    if (!opts.onPresent) return;
    const now = presentIn(companions.keys(), departing);
    if (now.join("\n") === present) return;
    present = now.join("\n");
    opts.onPresent(now);
  };

  /** Who is thinking with others round them this frame, whose sign and "thinking" one cue says for all (`poolThinking`). */
  let pooled = new Set<string>();
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
    // Thinking with others round it, one cue over them all says so (`poolThinking`): its tag is its name alone, and
    // it has no sign of its own, unless you point at it or stand by it.
    const together = pooled.has(agent) && behavior.sign === "think" && !close;
    f.signs.pool(together);
    const status = together
      ? undefined
      : behavior.label && (!behavior.quiet || close)
        ? close && activity?.doing === "asleep"
          ? `asleep · ${asleepWords(activity)}`
          : behavior.detail
            ? `${behavior.label} · ${behavior.detail}`
            : behavior.label
        : close
          ? (errands.get(f)?.errand.label ?? stayTag(agent, f) ?? "idle")
          : undefined;
    // The agent you talk to needs no name; the others always show theirs.
    f.label(
      f === me ? (opts.visitor ? "you" : undefined) : f.name,
      status,
      close ? aboutLines(activity) : [],
      !!behavior.phone,
    );
    if (was && sameBehavior(was.behavior, behavior)) return;
    // Your own body does nothing by itself but hold the phone, while you talk to someone somewhere else.
    if (f === me && opts.visitor) f.hold(behavior.prop, behavior.hold);
    shows.set(f, {
      behavior,
      doing: activity?.doing,
      checked: Number.NEGATIVE_INFINITY,
      faced: Number.NEGATIVE_INFINITY,
    });
    f.signs.set(behavior.sign, clock);
    f.doze(!!behavior.asleep);
    if (behavior.gesture && was?.doing !== activity?.doing)
      f.gesture(behavior.gesture, clock, undefined, { auto: true });
  }

  // When each body keeping someone company next moves its hands or nods, and how many times it has; and until when
  // each is making a gesture of its own. Weak, so a body gone from the stage is let go with it.
  const chats = new WeakMap<Figure, { n: number; at: number }>();
  const ownGesture = new WeakMap<Figure, number>();
  /**
   * Keeping someone company, sat down: now and then it talks with its hands,
   * nods along, or laughs. A gesture of its own comes first: one it chose
   * with the body tool, or one a person made from its card, plays out before
   * the chat goes on.
   */
  const chat = (f: Figure, agent: string, t: number) => {
    let c = chats.get(f);
    if (!c) chats.set(f, (c = { n: 0, at: t + chatPause(agent, 0) }));
    if (f.walker.busy) return;
    const move = chatDue(c, agent, t, ownGesture.get(f));
    // Never over a gesture kept going, as a doing's own gesture isn't.
    if (move) f.gesture(move, t, undefined, { auto: true });
  };

  /**
   * Each frame, what a body's activity asks of where it is: hold its thing
   * (not a laptop, at a desk — it types there), go to its desk, the task
   * board or a seat when one is free and nothing else has it walking, and
   * turn to whoever it is talking to when they are here. Idle and free, its
   * time is its own: whatever it is doing with it, at the spot it went to.
   */
  const attend = (f: Figure, agent: string, t: number, free: boolean, stay?: string) => {
    const s = shows.get(f);
    const b = s?.behavior;
    const spot = f.here ? spotById(room, f.here) : undefined;
    let e = errands.get(f);
    // Sent somewhere else, or busy now: whatever it was doing with its time is over. Staying at a spot it chose, or
    // waiting at another until that is free, nothing sends it on: what it does there ends with its own time, and
    // something else there follows.
    const own = free && !b?.stays;
    const staying = !!stay && f.here !== undefined;
    const last = e?.errand.id;
    const over = staying && e?.ends !== undefined && t >= e.ends;
    if (e && (!own || over || (f.current !== e.errand.spot && f.pending !== e.errand.spot))) {
      stopErrand(f);
      e = undefined;
    }
    // At a spot it went to some other way (put there, sent by a cue, staying there): something to do there.
    if (!e && own && f.here) {
      const found = errandAt(
        room,
        f.here,
        hourNow(),
        chanceFor(agent),
        likesFor(agent),
        staying ? { last } : undefined,
      );
      if (found) errands.set(f, (e = { errand: found, arrived: false }));
    }
    if (e && !e.arrived && f.here === e.errand.spot) {
      e.arrived = true;
      if (e.errand.gesture) f.gesture(e.errand.gesture, t, undefined, { auto: true });
      if (e.errand.doze) f.doze(true);
    }
    if (e?.arrived && staying && e.ends === undefined)
      e.ends = t + stayLength(e.errand, idleStyle(looksOf(agent)?.idle).stay, chanceFor(agent));
    const partner = b?.face ? figureOf(b.face) : undefined;
    const held = heldFor(b, { spotActivity: spot?.activity, partnerHere: !!partner && partner !== f });
    const errandHold = e?.arrived ? e.errand.hold : undefined;
    if (held.prop) f.hold(held.prop, held.hold);
    else f.hold(errandHold?.prop, errandHold?.how);
    if (!s || !b) return;
    // Its seat on an outing, its bed for the night: it goes there, and keeps to it. With someone else there (a host on
    // its couch, an agent come to talk, you), it sits at the nearest free seat instead, or stays sat where it is, and
    // takes its own once it is free.
    const seat = b.spot && b.spot !== f.current && spotById(room, b.spot) ? b.spot : undefined;
    if (seat && free && t - s.checked > 1.5 && !f.walker.busy) {
      s.checked = t;
      const to = seatToTake(
        seat,
        room.spots,
        { x: f.walker.place.x, z: f.walker.place.z, spotActivity: spot?.activity, ...(f.here ? { spot: f.here } : {}) },
        taken(f),
      );
      if (to && f === me) go(to);
      else if (to) f.go(room, to, waysFor(f));
    }
    // Chatting wherever it has settled: at its seat, the one it sat at instead, or about its home with guests round.
    if (chatsAt(b, f.here)) chat(f, agent, t);
    // In a meeting room everyone keeps their seat at the table: nobody leaves it for a desk to think at.
    const station = isMeeting(room) && b.station !== "seat" ? undefined : b.station;
    if (station && !seat && b.spot !== f.here && free && t - s.checked > 1.5 && !f.walker.busy && !f.pending) {
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

  /**
   * The way in and out for an agent coming from or going to `via`: the
   * threshold of the door to there when the room has one, a door someone put
   * in perhaps; else of the room's first door, when it has one.
   */
  const doorway = (via?: string) => {
    const door = doorTo(room, via) ?? room.doors?.[0];
    return door ? threshold(room, door) : undefined;
  };

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
    const outdoors = isOutdoors(room);
    for (const [agent, fig] of companions) {
      if (ids.has(agent)) continue;
      const way = opts.still || outdoors ? undefined : doorway(opts.wentBy?.(agent)?.to);
      turnedFor.delete(fig);
      errands.delete(fig);
      shows.delete(fig);
      standing.delete(fig);
      facedAt.delete(fig);
      companions.delete(agent);
      // Gone home, or somewhere else: out through the door, or simply gone from a room without one. Outdoors, it
      // walks to the door of where it is going, however far that is.
      const exit = outdoors && !opts.still ? opts.exitFor?.(agent) : way?.at;
      if (!exit) {
        fig.dispose();
        continue;
      }
      fig.doze(false);
      fig.hold(undefined, undefined);
      fig.label(fig.name, undefined);
      // Off to work, it says so over its head as it goes; back from an outing with nothing on, it shows nothing.
      fig.signs.set(behaviorFor(activities[agent]).sign, clock);
      fig.goTo(room, exit, ways());
      const far = Math.hypot(exit[0] - fig.walker.place.x, exit[1] - fig.walker.place.z);
      departing.push({
        fig,
        from: clock,
        agent,
        leaving: true,
        ...(outdoors ? { until: clock + (far * 1.6) / PASSING_PACE + 8 } : {}),
      });
    }
    sayPresent();
    // Arriving after the stage has settled in this place is coming in; any sooner, it was here already.
    const coming = !opts.still && performance.now() - placedAt > SETTLED_MS;
    const gen = placeGen;
    for (const c of company) {
      const fig = companions.get(c.agent);
      if (fig) {
        fig.name = c.name;
        // A new model, colour or size: made again where it stands. Anything else changes on the body as it is.
        if (fig.built !== builtKey(c.url, c.looks, c.agent)) rebody(c.agent);
        // Dressed again only when what it wears changed: the same list is nothing to do.
        fig.dress(c.wear);
        if (fig.carried !== carriageKey(c.looks)) {
          fig.carried = carriageKey(c.looks);
          fig.carry(carriageOf(c.looks));
        }
        show(c.agent, fig);
        playEmote(c.agent);
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
          // Its own seat, when its day gives it one here (`routines.ts`) and nobody has it; somewhere free otherwise.
          const own = behaviorFor(activities[c.agent]).spot;
          const kept = own && !taken().has(own) ? spotById(room, own) : undefined;
          const seat = kept ?? arrivalSpot();
          // Outdoors it comes from the door of where it was, when the page knows; indoors, through the door from
          // where it was when the room has one (a door someone put in, perhaps), else the room's first.
          const from = isOutdoors(room) ? still.from : undefined;
          const entrance =
            coming && gen === placeGen
              ? from
                ? { at: from, facing: seat ? Math.atan2(seat.at[0] - from[0], seat.at[1] - from[1]) : 0 }
                : isOutdoors(room)
                  ? undefined
                  : doorway(opts.wentBy?.(c.agent)?.from)
              : undefined;
          const start = entrance
            ? { id: "", name: "", place: "", at: entrance.at, facing: (entrance.facing * 180) / Math.PI }
            : seat;
          const figure = makeCompanion(model, still, start);
          // Built from what it was asked for, which may have changed while it loaded: then it is made again.
          figure.built = builtKey(c.url, c.looks, c.agent);
          scene.add(figure.body, figure.gaze);
          companions.set(c.agent, figure);
          rekeep();
          show(c.agent, figure);
          sayPresent();
          // Still where you came in: the shot of the room takes in whoever has just come.
          if (entering.holds) aimArrival();
          // The agent you came to see: you stand in front of it now that it is here.
          if (greeting === c.agent) standBefore(c.agent);
          // In through the door, and on to somewhere free.
          if (entrance && seat) figure.go(room, seat.id, ways());
          // What brought it here may be what it just said, in the room it came to say it in: that shows. Anything
          // older than a moment is old news, which `hear` leaves out.
          hear(c.agent, speech[c.agent]);
          playEmote(c.agent);
          if (figure.built !== builtKey(still.url, still.looks, still.agent)) rebody(c.agent);
        })
        .catch(() => {
          arriving.delete(c.agent);
        });
    }
    rekeep();
  };

  /** Another agent's body, built from a model as it chose to look, standing at `start`. */
  function makeCompanion(model: VRM, c: Companion, start: Spot | undefined) {
    const carriage = carriageOf(c.looks);
    const figure = new Figure(model, room, start, {
      reducedMotion: opts.reducedMotion,
      animations: c.animations,
      tint: tintOf(c.looks?.color, c.agent),
      ...(c.looks?.size ? { size: c.looks.size } : {}),
      carriage,
      wear: c.wear,
      // The town's streets are long: a body crossing it walks briskly, as one going by does, in its own way of walking.
      ...(isOutdoors(room) ? { pace: PASSING_PACE * (carriage.walk?.speed ?? 1) } : {}),
      ...(opts.still ? {} : { pick: pickFor(c.agent, () => companions.get(c.agent)) }),
    }) as Figure & { name?: string; built?: string; carried?: string };
    figure.name = c.name;
    figure.carried = carriageKey(c.looks);
    return figure;
  }

  /**
   * Where a body made again goes: the spot the old one stood at, sitting if
   * it sat; or the very place it stood, facing the same way, between spots.
   */
  const standIn = (fresh: Figure, old: Figure) => {
    if (old.here && fresh.current === old.here) return;
    fresh.placeAt([old.walker.place.x, old.walker.place.z], old.walker.place.facing);
  };
  /** Let go of what was kept about a body that has been made again. */
  const forget = (old: Figure) => {
    turnedFor.delete(old);
    errands.delete(old);
    shows.delete(old);
    standing.delete(old);
    facedAt.delete(old);
  };

  // Bodies being made again, by agent, and what each is being made from: only the latest ask is kept.
  const remaking = new Map<string, string>();
  /** Make another agent's body again, as it now chose to look, where the old one stands. */
  function rebody(agent: string) {
    const c = wanted.find((w) => w.agent === agent);
    if (!c) return;
    const key = builtKey(c.url, c.looks, agent);
    if (remaking.get(agent) === key) return;
    remaking.set(agent, key);
    loadModel(c.url)
      .then((model) => {
        const still = wanted.find((w) => w.agent === agent);
        const old = companions.get(agent);
        if (remaking.get(agent) === key) remaking.delete(agent);
        if (disposed || !still || !old || builtKey(still.url, still.looks, agent) !== key) {
          VRMUtils.deepDispose(model.scene);
          return;
        }
        const at = old.here ? spotById(room, old.here) : undefined;
        const fresh = makeCompanion(model, still, at);
        fresh.built = key;
        standIn(fresh, old);
        scene.add(fresh.body, fresh.gaze);
        forget(old);
        old.dispose();
        companions.set(agent, fresh);
        rekeep();
        show(agent, fresh);
      })
      .catch(() => {
        if (remaking.get(agent) === key) remaking.delete(agent);
      });
  }

  // What the body this stage shows wears now, for a body made again.
  let myWear = opts.wear;
  /**
   * The body this stage shows chose to look another way: a new model, colour
   * or size makes it again where it stands, the room and everyone in it left
   * as they are; how it carries itself changes on the body as it is.
   */
  const reclothe = (looks: BodyLooks) => {
    const was = carriageKey(myLooks);
    myLooks = looks;
    const key = builtKey(url, looks, self);
    if (key === myBuild) {
      if (carriageKey(looks) !== was) me.carry(carriageOf(looks));
      return;
    }
    myBuild = key;
    loadModel(looks.avatar ?? url)
      .then((model) => {
        if (disposed || key !== myBuild) {
          VRMUtils.deepDispose(model.scene);
          return;
        }
        const old = me;
        const at = old.here ? spotById(room, old.here) : undefined;
        const fresh = makeMe(model, at, myWear);
        standIn(fresh, old);
        scene.add(fresh.body, fresh.gaze);
        host.dataset.motion = "code";
        forget(old);
        old.dispose();
        me = fresh;
        host.dataset.model = looks.model ?? "";
        rekeep();
        show(self, me);
      })
      .catch(() => {
        // The model couldn't be loaded: the body stays as it was.
        if (key === myBuild) myBuild = "";
      });
  };

  // The gesture each agent is making, and the last one each body here made, by agent.
  let emotes: Record<string, EmoteRecord> = {};
  const madeEmote = new Map<string, string>();
  // Bodies turned to whoever they made a gesture for: the spot each turns back to facing, and when.
  const turnedFor = new Map<Figure, TurnBack>();
  /**
   * Who a gesture with no target is made for: you, watching, for the agent
   * this stage shows; for anyone else, the body near it (the agent shown, or
   * you on a visit), when there is one close enough to make it for.
   */
  const audienceOf = (f: Figure): THREE.Vector3 | undefined => {
    if (f === me) return camera.position.clone();
    const d = Math.hypot(me.walker.place.x - f.walker.place.x, me.walker.place.z - f.walker.place.z);
    return d <= AUDIENCE_AT && (!opts.visitor || travel === "walk") ? me.head() : undefined;
  };
  /**
   * Make the gesture an agent asked for, when its body is here and hasn't
   * made it yet: turned to someone or something here first when it said at
   * what, or else to whoever it is for, and back to what its spot faces once
   * it is done.
   */
  function playEmote(agent: string) {
    const f = figureOf(agent);
    if (!f || opts.still || (f === me && opts.visitor)) return;
    const now = emoteNow(emotes[agent], madeEmote.get(agent), Date.now());
    if (!now) return;
    madeEmote.set(agent, emotes[agent].at);
    const who = now.target ? (figureOf(now.target) ?? companionNamed(now.target)) : undefined;
    const where = now.target && !who ? lookTarget(room, now.target) : undefined;
    const at = who
      ? who.head()
      : where
        ? "viewer" in where
          ? camera.position.clone()
          : new THREE.Vector3(...where.at)
        : now.target
          ? undefined
          : audienceOf(f);
    // Where it stands, taken before it turns: a body turning is on the move, and at no spot until it has. Still
    // turning for a gesture before this one, it goes back to where that one had it.
    const back = at ? turnBackAfter(f.here ?? turnedFor.get(f)?.spot, clock, now.seconds ?? EMOTE_SECONDS) : undefined;
    if (now.name === "point") {
      if (at) f.aim(at, true, clock);
      else f.gesture("point", clock);
    } else {
      if (at) f.face(at, clock);
      f.gesture(now.name, clock, now.seconds);
    }
    ownGesture.set(f, clock + (now.seconds ?? EMOTE_SECONDS));
    if (back) turnedFor.set(f, back);
  }
  /** Bodies done with a gesture turn back to what their spot faces, if they are still standing at it. */
  const turnBack = (t: number) => {
    for (const [f, back] of turnedFor) {
      const next = turnBackNow(back, t, f);
      if (next === "wait") continue;
      turnedFor.delete(f);
      if (next === "turn") f.go(room, back.spot, waysFor(f));
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
      if (to) f.go(room, to, waysFor(f));
    } else if (f.currentAt && Math.hypot(spot.at[0] - f.currentAt[0], spot.at[1] - f.currentAt[1]) > 0.05) {
      // A walk from a spot to itself goes nowhere: from here, as if between spots.
      f.current = undefined;
      f.go(room, spot.id, waysFor(f));
    }
  };

  /**
   * Flying, the camera stays where you can fly (`flyBounds`): in a room,
   * between its floor and ceiling and within its walls; outdoors, over the
   * town. Taken out of them by the keys, the wheel or a turn, it is brought
   * straight back in, and the point it turns about with it, so the way it
   * looks doesn't change.
   */
  function keepFlying() {
    const p = camera.position;
    const [x, y, z] = keptIn([p.x, p.y, p.z], flyBounds(room));
    const moved = new THREE.Vector3(x - p.x, y - p.y, z - p.z);
    if (moved.lengthSq() < 1e-12) return;
    camera.position.add(moved);
    controls.target.add(moved);
  }

  /**
   * Starting to fly in a room, the camera comes down into it from wherever
   * the view following you was, to take off from your head a step back
   * (`takeOff`), looking on the way it looked, a little down, turning about
   * a point just ahead as flying does.
   */
  const liftOff = (): Framing => {
    const { fwd } = heading();
    const head = me.head();
    const at = new THREE.Vector3(...takeOff([head.x, head.y, head.z], [fwd.x, fwd.z], flyBounds(room)));
    const look = fwd.clone().setY(-0.3).normalize();
    return {
      target: at.clone().add(look.multiplyScalar(1.2)),
      position: at,
      azimuth: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      polar: [0.05, Math.PI - 0.05],
    };
  };
  /**
   * Starting to fly outdoors, the camera flies on from where it is, looking
   * the way it looks and turning about a point just ahead. The view following
   * you can stand further off than flying goes (`flyBounds`), above the sky's
   * limit or out over the sea, so it is brought in over the town first.
   */
  const flyFromHere = (): Framing => {
    const look = controls.target.clone().sub(camera.position).normalize();
    const p = camera.position;
    const at = new THREE.Vector3(...keptIn([p.x, p.y, p.z], flyBounds(room)));
    return {
      target: at.clone().add(look.multiplyScalar(1.2)),
      position: at,
      azimuth: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
      polar: [0.05, Math.PI - 0.05],
    };
  };
  /** Where flying starts: outdoors from where the camera is, in a room from your head. */
  const takingOff = (): Framing => (isOutdoors(room) ? flyFromHere() : liftOff());
  /** Flying on from somewhere new (another room, or face to face with someone): in a room, from your head. */
  const flyOn = () => settle(takingOff());

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
    const speed = travelSpeed(travel, running, !!town) * dt;
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
      keepFlying();
    }
  }

  /** Where your body stood last frame, so the camera moves exactly as far as you did. */
  let lastAt: [number, number] = [me.walker.place.x, me.walker.place.z];

  /** Face to face with an agent, at once, clear of the furniture: see `Stage.standBefore`. */
  function standBefore(agent: string) {
    if (!opts.visitor) return;
    putDown(true);
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
    dropLead();
    // The same view as on arriving anywhere, centred on where you now stand.
    tween = null;
    const shot = framing("room");
    const shift = me.head().sub(shot.target);
    shot.target.add(shift);
    shot.position.add(shift);
    settle(shot);
    if (travel === "fly") flyOn();
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
    if (tween || travel !== "walk" || editing || reading) return;
    // Walked off from where you came in: the camera comes back round to you, and in to the reach you zoomed to.
    entering.moved([p.x, p.z]);
    if (!entering.holds && lead.lengthSq() > 0) {
      const k = opts.reducedMotion ? 1 : 1 - Math.exp(-dt / LEAD_SECONDS);
      lead.multiplyScalar(1 - k);
      if (lead.lengthSq() < 1e-4) lead.set(0, 0, 0);
    }
    entering.settle(reachNow(), dt, opts.reducedMotion ? 0 : LEAD_SECONDS);
    const head = me.head().add(lead);
    const t = controls.target;
    const step = new THREE.Vector3(...keepUp([t.x, t.y, t.z], [head.x, head.y, head.z], moved, dt));
    controls.target.add(step);
    camera.position.add(step);
  }

  // When each body last found a new way round you, and where you stood then: it looks again only a few times a
  // second, and only once you have moved, since from the same place it would find the same way.
  const rerouted = new WeakMap<Figure, { t: number; you: [number, number] }>();
  /**
   * An agent on its way somewhere, whose way you have stepped into (or who
   * set off before you were there), goes round you instead.
   */
  function giveWay(t: number) {
    if (travel !== "walk") return;
    const you: [number, number] = [me.walker.place.x, me.walker.place.z];
    for (const f of [...companions.values(), ...departing.map((d) => d.fig)]) {
      if (!f.walker.way.length) continue;
      const last = rerouted.get(f);
      if (last && (t - last.t < REROUTE_SECONDS || Math.hypot(you[0] - last.you[0], you[1] - last.you[1]) < 0.1))
        continue;
      const here: [number, number] = [f.walker.place.x, f.walker.place.z];
      if (!inTheWay(here, f.walker.way, you, me.radius + f.radius + 0.1)) continue;
      rerouted.set(f, { t, you });
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
          if (!shows.get(c)?.behavior.stays) c.gesture("wave", t, undefined, { auto: true });
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
    // Only what hides you, on a visit, or the agent the chat page shows, and whoever you are with: the one you stand
    // by, and any a card is open beside. A cart beside you that hides someone else across the café stays as it is.
    // Flying, your body is put away: nothing need fade for it.
    const seen = new Set<Figure>();
    if (!(opts.visitor && travel !== "walk")) seen.add(me);
    for (const agent of [near, ...[...pins].map((p) => ("agent" in p.anchor ? p.anchor.agent : undefined))]) {
      const f = agent === undefined ? undefined : bodyOf(agent);
      if (f && f !== me) seen.add(f);
    }
    for (const f of seen) {
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
      const want = f.wall
        ? behind.has(f.wall)
          ? FADED_WALL
          : 1
        : hiding.has(f)
          ? (f.faint ?? f.ghost?.faded ?? FADED)
          : 1;
      // At rest and its own self, there is nothing to draw; faded, it is drawn every frame, keeping up.
      if (f.level === want && !f.own) continue;
      f.level = opts.reducedMotion ? want : ease(f.level, want, dt, SEE_THROUGH_SECONDS);
      paintFaded(f);
    }
  }

  /** The cue over each group thinking together, by who is in it: where over them it stands, and its size as last laid out. */
  const cues = new Map<string, { sprite: THREE.Sprite; at: THREE.Vector3; perPixel: number }>();
  /**
   * Who is thinking together this frame (`thinkingTogether`): three or more
   * round a table, or close by, thinking at once. Each group has one cue over
   * the middle of it saying how many are thinking, in place of a thought cloud
   * and "thinking" over every one of them; whoever joins or leaves a group
   * shows its own again, or gives them up. The cues, by group.
   */
  function poolThinking(): Map<string, { sprite: THREE.Sprite; at: THREE.Vector3; perPixel: number }> {
    const here: Thinker[] = [];
    const figures = new Map<string, Figure>();
    for (const [agent, f] of opts.visitor ? [...companions] : [[self, me] as [string, Figure], ...companions]) {
      if (!f.body.visible) continue;
      figures.set(agent, f);
      const thinking = shows.get(f)?.behavior.sign === "think" && !f.speaking(clock);
      here.push({ id: agent, at: [f.walker.place.x, f.walker.place.z], thinking });
    }
    const groups = opts.still ? [] : thinkingTogether(here);
    const now = new Set(groups.flat());
    const changed = [...new Set([...pooled, ...now])].filter((a) => pooled.has(a) !== now.has(a));
    pooled = now;
    for (const agent of changed) {
      const f = figureOf(agent);
      if (f) show(agent, f);
    }
    const keys = new Set(groups.map((g) => g.join(",")));
    for (const [key, cue] of cues)
      if (!keys.has(key)) {
        disposeSprite(cue.sprite);
        cues.delete(key);
      }
    for (const g of groups) {
      const key = g.join(",");
      let cue = cues.get(key);
      if (!cue) {
        cue = { sprite: thinkingCue(thinkingWords(g.length)), at: new THREE.Vector3(), perPixel: 0.005 };
        cues.set(key, cue);
        scene.add(cue.sprite);
      }
      // Over the middle of them, as high as the tallest head there.
      const crowns = g.flatMap((a) => {
        const f = figures.get(a);
        return f ? [f.crown()] : [];
      });
      cue.at.set(0, 0, 0);
      for (const c of crowns) cue.at.add(c);
      cue.at.divideScalar(Math.max(1, crowns.length));
      cue.at.y = Math.max(...crowns.map((c) => c.y));
      cue.sprite.position.copy(cue.at);
    }
    return cues;
  }
  /** Where things of some kinds in the room are on the stage: what is put up on its walls to be read, say. */
  const kindsOnStage = (kinds: ReadonlySet<string>): Box[] =>
    room.props.flatMap((p) => {
      if (!kinds.has(p.kind)) return [];
      const o = things.get(p.id);
      const at = o && thingOnStage(o);
      return at ? [at.box] : [];
    });
  /** A room's whiteboard and its task board, where they are on the stage, for faint tags to keep off. */
  const boardsOnStage = () => kindsOnStage(BOARD_KINDS);

  // A head's place on the screen, and its distance in front of the camera, worked out in this.
  const onScreen = new THREE.Vector3();
  /** What floats over each head on the stage this frame, by whose head: its tag, sign and bubble, as boxes. */
  let overheads = new Map<string, Box[]>();
  /** The corners of some boxes, for the box round all of them. */
  const boxCorners = (boxes: Box[]): [number, number][] =>
    boxes.flatMap((b): [number, number][] => [
      [b.left, b.top],
      [b.right, b.bottom],
    ]);
  /** A box `size` big on the stage, standing on `bottom` and centred on `x`. */
  const overBox = (x: number, bottom: number, [w, h]: [number, number]): Box => ({
    left: x - w / 2,
    right: x + w / 2,
    top: bottom - h,
    bottom,
  });
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
    // One cue over each group thinking together, laid out with the tags: last of all, so it goes up over theirs.
    for (const [key, cue] of poolThinking()) {
      const depth = -onScreen.copy(cue.at).applyMatrix4(camera.matrixWorldInverse).z;
      cue.sprite.visible = depth > 0.05;
      if (!cue.sprite.visible) continue;
      cue.perPixel = metresPerPixel(depth, camera.fov, stageH);
      onScreen.copy(cue.at).project(camera);
      columns.push({
        id: key,
        x: ((onScreen.x + 1) / 2) * stageW,
        y: ((1 - onScreen.y) / 2) * stageH,
        tag: fitSprite(cue.sprite, cue.perPixel, TAG_PX),
        rank: CUE_RANK,
        focus: true,
      });
    }
    for (const [id, f] of bodies) {
      // A body put away, like yours while you fly, shows nothing over its head for others to make way for.
      if (!f.body.visible) continue;
      const crown = f.crown();
      const depth = -onScreen.copy(crown).applyMatrix4(camera.matrixWorldInverse).z;
      // Behind the camera, nothing over its head is on the screen to lay out.
      if (depth <= 0.05) continue;
      onScreen.copy(crown).project(camera);
      const perPixel = metresPerPixel(depth, camera.fov, stageH);
      const over = f.fitOver(perPixel, clock);
      // Whoever is talking keeps its tag's place over its head, so its bubble's tail can reach it there; then the tag
      // under the pointer, or of the one you stand by; then the nearer.
      const close = closeTo(id);
      const speaking = f.speaking(clock);
      const rank = (speaking ? 2 : close ? 1 : 0) * 1000 - depth;
      const x = ((onScreen.x + 1) / 2) * stageW;
      const y = ((1 - onScreen.y) / 2) * stageH;
      // Its body down to its feet, for bubbles brought down beside a speaker to keep off, and tails to go round.
      const feet = onStage(f.body.position);
      const half = 0.3 / perPixel;
      const body = feet && { left: x - half, right: x + half, top: y, bottom: Math.max(y + half, feet[1]) };
      columns.push({ id, x, y, rank, focus: close || speaking, ...(body ? { body } : {}), ...over });
    }
    // The keys hint along the foot of the stage, walking or flying: what is said is read above it.
    const seen = stageW - insetRight;
    const foot = hints
      .filter((h) => h.top > stageH / 2 && h.right - h.left > seen / 2)
      .reduce((y, h) => Math.min(y, h.top), stageH - insetBottom);
    const laid = stack(columns, {
      left: 0,
      right: seen,
      top: insetTop,
      bottom: foot,
      covered,
      boards: boardsOnStage(),
    });
    for (const [key, cue] of cues) {
      const at = laid.get(key);
      if (!at || !cue.sprite.visible) continue;
      liftSprite(cue.sprite, at.tag, cue.perPixel, at.tagAcross);
      cue.sprite.visible = !at.hidden;
    }
    // Where each tag, sign and bubble is on the stage now, for the panels to keep off (`placePanels`).
    overheads = new Map();
    for (const c of columns) {
      const at = laid.get(c.id);
      if (!at) continue;
      const boxes: Box[] = [];
      if (c.tag && !at.hidden) boxes.push(overBox(c.x + at.tagAcross, c.y - at.tag, c.tag));
      if (c.sign && !c.bubble) boxes.push(overBox(c.x + at.tagAcross, c.y - at.sign, [c.sign, c.sign]));
      if (c.bubble && !at.gone) boxes.push(overBox(c.x + at.across, c.y - at.bubble, c.bubble));
      if (boxes.length) overheads.set(c.id, boxes);
    }
    const said = columns
      .filter((c) => c.bubble && !laid.get(c.id)?.gone)
      .sort((a, b) => (a.said ?? 0) - (b.said ?? 0))
      .map((c) => c.id);
    for (const [id, f] of bodies) {
      const at = laid.get(id);
      if (at) f.placeOver(at, dt, 12 + Math.max(0, said.indexOf(id)));
    }
  }

  // When the controls that step aside (`opts.fades`) were last looked at.
  let asideAt = 0;
  /**
   * A few times a second: mark each control over the stage that steps aside
   * (`opts.fades`) while what you are looking at is behind it, or the pointer
   * is, over the picture: your body and what is over its head (the agent's
   * in its own view), or the middle of the view while you fly.
   */
  function stepAside(now: number) {
    if (now - asideAt < ASIDE_MS) return;
    asideAt = now;
    const els = opts.fades?.() ?? [];
    if (!els.length) return;
    camera.updateMatrixWorld();
    const seen: Box[] = [];
    const body = me.body.visible ? bodyOnStage(me) : undefined;
    if (body) seen.push(body.box, ...(overheads.get(opts.visitor ? "you" : self) ?? []));
    else {
      const middle = onStage(controls.target);
      if (middle)
        seen.push({ left: middle[0] - 24, right: middle[0] + 24, top: middle[1] - 24, bottom: middle[1] + 24 });
    }
    const box = host.getBoundingClientRect();
    if (pointer) {
      const [x, y] = [pointer.clientX - box.left, pointer.clientY - box.top];
      seen.push({ left: x - 4, right: x + 4, top: y - 4, bottom: y + 4 });
    }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const k = {
        left: r.left - box.left,
        right: r.right - box.left,
        top: r.top - box.top,
        bottom: r.bottom - box.top,
      };
      const behind = seen.some((b) => b.left < k.right && k.left < b.right && b.top < k.bottom && k.top < b.bottom);
      if (behind !== el.hasAttribute("data-behind")) el.toggleAttribute("data-behind", behind);
    }
  }

  // When the town's doors were last shown or hidden by how near they are.
  let doorsAt = 0;
  /**
   * Each frame outdoors: the sky keeps round the camera; the street lamps
   * nearest you light up and the sun's shadows are drawn round you, each
   * moved on once you have walked a little way; and the doors further off
   * than `DOOR_SHOWN` aren't drawn, a few times a second.
   */
  function keepTown(t: number) {
    if (!town) return;
    town.sky.position.copy(camera.position);
    const p = me.walker.place;
    const here: [number, number] = travel === "walk" ? [p.x, p.z] : [controls.target.x, controls.target.z];
    const far = (a: [number, number] | undefined, by: number) => !a || Math.hypot(a[0] - here[0], a[1] - here[1]) > by;
    if (far(litAt, 3)) lightStreets(here);
    if (far(sunAt, 6)) aimSun(here);
    if (t - doorsAt > 0.3) {
      doorsAt = t;
      const at = controls.target;
      for (const d of townDoors) d.visible = Math.hypot(d.position.x - at.x, d.position.z - at.z) < DOOR_SHOWN;
    }
  }

  // --- Panels of the page's, kept beside what they are about (see `anchors.ts`) ---

  interface Pin extends PanelOptions {
    id: string;
    el: HTMLElement;
    anchor: Anchor;
    /** Its size in CSS pixels, as last measured. */
    size: [number, number];
    /** Where it was put last frame. */
    at?: Placed;
    /** Where you stood, where what it is about was, and how far apart, when it was first put beside it. */
    from?: { you: [number, number]; it: [number, number]; off: number };
    /** You walked away from it, and the page heard. */
    left?: boolean;
    watch?: ResizeObserver;
  }
  const pins = new Set<Pin>();
  let pinCount = 0;
  /** The panel that was the sheet over the stage's foot last frame, whose height the camera frames above. */
  let sheetOf: Pin | undefined;
  const onStageAt = new THREE.Vector3();
  /** Where a point in the room is on the stage, in CSS pixels; none when it is behind the camera. */
  const onStage = (p: THREE.Vector3): [number, number] | undefined => {
    if (-onStageAt.copy(p).applyMatrix4(camera.matrixWorldInverse).z <= 0.05) return undefined;
    onStageAt.copy(p).project(camera);
    return [((onStageAt.x + 1) / 2) * stageW, ((1 - onStageAt.y) / 2) * stageH];
  };
  /** A body on the stage: all of it, crown to feet, and its head, which a panel never covers. */
  const bodyOnStage = (f: Figure): PanelIn["target"] | undefined => {
    if (!f.body.visible) return undefined;
    const crown = f.crown();
    const top = onStage(crown);
    const foot = onStage(f.body.position);
    if (!top || !foot) return undefined;
    const perPixel = metresPerPixel(
      -onStageAt.copy(crown).applyMatrix4(camera.matrixWorldInverse).z,
      camera.fov,
      stageH,
    );
    const half = 0.34 / perPixel;
    return {
      box: { left: top[0] - half, right: top[0] + half, top: top[1], bottom: foot[1] },
      keep: {
        left: top[0] - half * 0.7,
        right: top[0] + half * 0.7,
        top: top[1] - 6,
        bottom: top[1] + 0.34 / perPixel,
      },
    };
  };
  /** Something in the room on the stage: the box round all of it, which a panel beside it never covers. */
  const thingOnStage = (o: THREE.Object3D): PanelIn["target"] | undefined => {
    const box = boxOnStage(new THREE.Box3().setFromObject(o));
    return box && { box, keep: box };
  };
  /** A box in the room on the stage: the box round its corners there, or none when it is partly behind the camera. */
  const boxOnStage = (b: THREE.Box3): Box | undefined => {
    if (b.isEmpty()) return undefined;
    const points: [number, number][] = [];
    for (const x of [b.min.x, b.max.x])
      for (const y of [b.min.y, b.max.y])
        for (const z of [b.min.z, b.max.z]) {
          const p = onStage(new THREE.Vector3(x, y, z));
          // Partly behind the camera, its box on the stage means nothing: it is off the screen.
          if (!p) return undefined;
          points.push(p);
        }
    return boxRound(points);
  };
  /**
   * What a body is with, on the stage: the bodies gathered round it (at its
   * table, on the bench beside it, round the cart), the thing it is at (its
   * seat, the board it works at) and anything tall it stands right by (the
   * cart). A panel about it goes beside all of them, not over them: they are
   * what you walked up to.
   */
  const withOnStage = (f: Figure): Box[] => {
    const p = f.walker.place;
    const out: Box[] = [];
    for (const c of companions.values()) {
      if (c === f || Math.hypot(c.walker.place.x - p.x, c.walker.place.z - p.z) > GATHERED) continue;
      const b = bodyOnStage(c);
      if (b) out.push(b.box);
    }
    // The thing it is at, by its spot; and whatever on the floor it stands right by, like a cart it walked up to.
    const spot = f.here ? spotById(room, f.here) : undefined;
    const thing = spot?.item ? things.get(spot.item) : undefined;
    const at = thing && thingOnStage(thing);
    if (at) out.push(at.box);
    for (const [id, b] of floorBoxes) {
      if (id === spot?.item) continue;
      const off = Math.hypot(Math.max(0, b.min.x - p.x, p.x - b.max.x), Math.max(0, b.min.z - p.z, p.z - b.max.z));
      if (off > BESIDE_THING || b.max.y < TALL) continue;
      const by = boxOnStage(b);
      if (by) out.push(by);
    }
    return out;
  };
  /**
   * What an anchor is on the stage this frame, and where on the floor, for
   * walking away from it. Gathered, what it is about takes in who and what
   * it is with, which the panel goes beside; whether it is in sight at all is
   * still the body's own box (`seen`), so a panel never points at someone
   * turned out of view because whoever was beside them still shows.
   */
  const anchorOnStage = (
    a: Anchor,
    gathered = false,
  ): { target?: PanelIn["target"]; floor?: [number, number]; seen?: Box } => {
    if ("held" in a) return {};
    if ("agent" in a || "you" in a) {
      // A card beside an agent stays beside it as it walks out, until it is gone through the door.
      const f = "you" in a ? (opts.visitor ? me : undefined) : bodyOf(a.agent);
      if (!f) return {};
      const body = bodyOnStage(f);
      // What is over its head is part of what the panel is about: its name, what it is doing, what it says. For your
      // conversation, so is whoever and whatever it is with, which it goes beside rather than over: the phone in your
      // hand keeps off what you walked up to, too.
      const over = overheads.get("you" in a ? "you" : a.agent) ?? [];
      const target = body && {
        box: gathered ? (boxRound(boxCorners([body.box, ...withOnStage(f)])) as Box) : body.box,
        keep: boxRound(boxCorners([body.keep, ...over])) as Box,
      };
      return { target, floor: [f.walker.place.x, f.walker.place.z], ...(body ? { seen: body.box } : {}) };
    }
    const o = "plaque" in a ? plaque?.group : things.get(a.thing);
    if (!o) return {};
    const p = o.getWorldPosition(new THREE.Vector3());
    return { target: thingOnStage(o), floor: [p.x, p.z] };
  };
  /**
   * Each frame, every panel beside what it is about (`layoutPanels`): in
   * what can be seen of the stage, the strip kept for panels included, clear
   * of the tools over it, of your own body and of a surface being read, and
   * of each other; then eased to where it goes (`follow`). A panel whose
   * thing is off the screen is held instead. One you walked away from is
   * said to the page, once.
   */
  function placePanels(dt: number) {
    if (!pins.size) {
      sheetOf = undefined;
      if (sheetTall) {
        sheetTall = 0;
        if (measureOverlays()) refit();
      }
      return;
    }
    camera.updateMatrixWorld();
    const view: Box = {
      left: EDGE,
      right: stageW - columnRight - EDGE,
      top: insetTop + EDGE,
      bottom: stageH - insetBottom - EDGE,
    };
    const avoid: Box[] = [];
    const walking = opts.visitor && travel === "walk";
    const yours = walking ? bodyOnStage(me) : undefined;
    if (yours) avoid.push(yours.box);
    // Your own head, and the tag over it, are never covered either: you always see where you are.
    const keepClear: Box[] = [...covered];
    if (yours) keepClear.push(boxRound(boxCorners([yours.keep, ...(overheads.get("you") ?? [])])) as Box);
    // Nor what is said over a head, or the tag saying who it is and what it is doing.
    for (const boxes of overheads.values()) avoid.push(...boxes);
    // Nor what hangs on the walls to be read, the calendar and the screens, if there is anywhere else to go.
    if (opts.visitor) avoid.push(...kindsOnStage(READ_ON_WALLS));
    // Nobody's face is covered if there is anywhere else to go: a panel about one agent keeps off the others'.
    for (const f of opts.visitor ? companions.values() : [me, ...companions.values()]) {
      const face = bodyOnStage(f)?.keep;
      if (face) avoid.push(face);
    }
    if (reading) avoid.push(readingBox());
    const floors = new Map<Pin, [number, number] | undefined>();
    const panels: PanelIn[] = [];
    for (const p of pins) {
      const { target, floor, seen } = anchorOnStage(p.anchor, !!p.gathered);
      floors.set(p, floor);
      const shown = target && inView(seen ?? target.box, view) ? target : undefined;
      const held = "held" in p.anchor ? p.anchor.held : (p.fallback ?? "front");
      panels.push({
        id: p.id,
        size: p.size,
        rank: p.rank ?? 0,
        ...(p.optional ? { optional: true } : {}),
        ...(p.at ? { was: p.at.side } : {}),
        ...(shown ? { target: shown } : { held }),
      });
    }
    const laid = layoutPanels(panels, view, avoid, stageW, keepClear, hints);
    let sheet: Pin | undefined;
    for (const p of pins) {
      const next = laid.get(p.id);
      if (!next) continue;
      const at = follow(p.at, next, dt);
      p.at = at;
      const el = p.el;
      if (el.dataset.side !== at.side) el.dataset.side = at.side;
      const loose = at.side === "sheet" || at.side === "away";
      const moved = loose ? "" : `translate3d(${Math.round(at.x)}px, ${Math.round(at.y)}px, 0)`;
      if (el.style.transform !== moved) el.style.transform = moved;
      const tail = `${at.tail}px`;
      if (el.style.getPropertyValue("--tail") !== tail) el.style.setProperty("--tail", tail);
      const room = `${Math.round(Math.max(160, view.bottom - view.top))}px`;
      if (el.style.getPropertyValue("--room-h") !== room) el.style.setProperty("--room-h", room);
      // Never wider than what can be seen: the whole chat open beside the world takes the rest.
      const across = `${Math.round(Math.max(200, view.right - view.left))}px`;
      if (el.style.getPropertyValue("--view-w") !== across) el.style.setProperty("--view-w", across);
      if (!("placed" in el.dataset)) el.dataset.placed = "";
      if (at.side === "sheet") sheet = p;
      // Walked off from what it is about, having stood somewhere else as it opened: the page is told, once.
      const floor = floors.get(p);
      if (p.onAway && !p.left && walking && floor && !loose) {
        const you: [number, number] = [me.walker.place.x, me.walker.place.z];
        const off = Math.hypot(floor[0] - you[0], floor[1] - you[1]);
        if (!p.from) p.from = { you, it: floor, off };
        else if (walkedAway(p.from.off, off, Math.hypot(p.from.it[0] - you[0], p.from.it[1] - you[1]))) {
          p.left = true;
          p.onAway();
        }
      }
    }
    // A sheet over the stage's foot covers it as a phone's chat does: the camera frames what is above. While the
    // same panel stays the sheet it only ever grows, so a reply coming in, or its oldest line going, never keeps
    // sliding the camera up and down.
    const tall = sheet ? (sheet === sheetOf ? Math.max(sheetTall, sheet.size[1]) : sheet.size[1]) : 0;
    sheetOf = sheet;
    if (Math.abs(tall - sheetTall) > 4) {
      sheetTall = tall;
      if (measureOverlays()) refit();
    }
  }
  /** Keep a panel beside what it is about: see `Stage.anchorPanel`. */
  const anchorPanel = (el: HTMLElement, anchor: Anchor, o: PanelOptions = {}) => {
    const pin: Pin = { ...o, id: `panel ${++pinCount}`, el, anchor, size: [el.offsetWidth, el.offsetHeight] };
    if (typeof ResizeObserver !== "undefined") {
      pin.watch = new ResizeObserver(() => {
        // Put away, it has no size of its own: the one it had stays, or it would fit anywhere and come back at once.
        if (el.offsetWidth && el.offsetHeight) pin.size = [el.offsetWidth, el.offsetHeight];
      });
      pin.watch.observe(el);
    }
    pins.add(pin);
    // Docked at the side for good, it has the strip kept for panels: the scene is framed in what is left.
    const docks = !o.optional && "held" in anchor && anchor.held === "dock";
    if (docks) docked++;
    const plaqued = "plaque" in anchor;
    if (plaqued) onPlaque++;
    if (docks && applyStrip() && measureOverlays()) refit();
    // Somewhere at once, rather than wherever it fell until the next frame.
    placePanels(0);
    return () => {
      pin.watch?.disconnect();
      pins.delete(pin);
      if (docks) docked--;
      if (plaqued) onPlaque--;
      if (docks && applyStrip() && measureOverlays()) refit();
    };
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
    } else if (!reading) {
      controls.update();
      // Turned past where you can fly, the camera comes back in; rearranging the room, it looks in from outside.
      if (opts.visitor && travel === "fly" && !editing) keepFlying();
    }
    if (opts.hour === undefined && hourNow() !== hour) {
      hour = hourNow();
      light(lightingFor(hour, lights));
    }
    // "Talked 5 min ago" goes on counting on the doors. The page writes the whiteboards again each minute.
    if (doorNotes.length && Math.floor(Date.now() / 60_000) !== notedMinute) noteDoors();
    // The screens turn to the next page as the clock comes round to it, and a clock on one keeps the time.
    if (screens.length) {
      const wall = Date.now();
      const page = pageAt(wall, cards.length);
      if (page !== shownPage || (cards[page]?.clock && Math.floor(wall / 60_000) !== shownMinute)) drawScreens();
    }
    const { state, loudness, engaged } = input();
    engagedNow = engaged;
    // A photo's frame is posed at the gesture's best moment exactly, however late this frame came.
    const peak = PEAK[opts.still?.gesture ?? ""] ?? 0.7;
    const shoot = !!opts.still && !readyFired && gestureAt !== undefined && t - gestureAt >= peak;
    const poseAt = shoot && gestureAt !== undefined ? gestureAt + peak : t;
    const here = me.here;
    const mine = shows.get(me)?.behavior;
    // Talking with someone here: it stays with them rather than wandering off.
    const myCompany = opts.visitor || opts.still ? undefined : kept.get(self);
    // A spot it chose to stay at, which it goes back to whenever nothing comes first (see `planFor`).
    const myStay = opts.visitor || opts.still ? undefined : stayFor(self);
    const myPlan = planFor({ talking: !!myCompany, working: !!mine?.stays, engaged, spot: !!myStay });
    if (myPlan === "spot" && myStay) keepTo(me, myStay);
    const next =
      asking || opts.still || opts.visitor || mine?.stays || myCompany || myPlan === "spot"
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
    if (!opts.still && !opts.visitor)
      attend(me, self, t, !engaged && !myCompany, myPlan === "spot" ? myStay : undefined);
    if (!opts.still && !opts.visitor && myPlan === "routine" && !asking) drift(me);
    // Talking with you comes first; otherwise it turns to whoever it is talking with here.
    if (myCompany && !engaged) keepCompany(me, myCompany.partner, myCompany.goes, t);
    if (opts.visitor) {
      if (!editing) visit(dt);
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
    if (wasBusy && !me.walker.busy && view === "close" && !tween && !editing && !reading && t - lastDragAt > 8)
      moveCamera(framing("close"));
    wasBusy = me.walker.busy;
    // The close-up keeps the torso in frame wherever the avatar goes, from
    // the angle the person last left the view at.
    if (view === "close" && !tween && !editing && !reading) {
      const follow = me
        .head()
        .sub(controls.target)
        .multiplyScalar(1 - Math.exp(-dt / 0.25));
      controls.target.add(follow);
      camera.position.add(follow);
    }
    // The chat page's view keeps the agent in frame as it moves round a room too big to see whole from near
    // enough, slowly; and comes in or backs off to the zoom quickly, from whatever angle it was turned to.
    if (view === "room" && !tween && !opts.visitor && !opts.still && !editing && !reading) {
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
    // Rearranging, the wheel and a pinch bring the camera nearer or take it back to the whole room, from wherever it
    // was turned and panned to; and panning goes no further than the room's edges.
    if (editing && !tween) {
      const want = roomDistance(room, visibleAspect(), visibleTall()) * editZoom;
      const offset = camera.position.clone().sub(controls.target);
      const away = offset.length();
      if (away > 1e-6 && Math.abs(away - want) > 1e-4)
        camera.position
          .copy(controls.target)
          .add(offset.setLength(opts.reducedMotion ? want : ease(away, want, dt, ZOOM_SECONDS)));
      const t0 = controls.target;
      const kept = new THREE.Vector3(
        Math.max(-room.width / 2, Math.min(room.width / 2, t0.x)),
        ROOM_TARGET[1],
        Math.max(-room.depth / 2, Math.min(room.depth / 2, t0.z)),
      );
      if (!kept.equals(t0)) {
        camera.position.add(kept.clone().sub(t0));
        t0.copy(kept);
      }
    }
    handles.update();
    // The others wander on their own, and keep an eye on the agent you are talking to.
    const meHead = me.head();
    for (const [agent, c] of companions) {
      const theirs = shows.get(c)?.behavior;
      if (!opts.still) {
        // Talking with someone here, a body stays with them: no wandering, no going off to a desk. Nothing on, it
        // goes back to a spot it chose, or about its own business.
        const company = kept.get(agent);
        const stay = stayFor(agent);
        const plan = planFor({ talking: !!company, working: !!theirs?.stays, engaged: false, spot: !!stay });
        if (plan === "spot" && stay) keepTo(c, stay);
        const move = plan === "routine" ? c.director.decide(t, c.here, false, taken(c)) : undefined;
        if (typeof move === "string") c.go(room, move, ways());
        attend(c, agent, t, !company, plan === "spot" ? stay : undefined);
        if (company) keepCompany(c, company.partner, company.goes, t);
        else if (plan === "routine") drift(c);
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
      const { fig, from, until } = departing[i];
      fig.step(room, ways(), poseAt, dt, { state: "idle", loudness: 0 }, meHead);
      if ((t - from > 0.5 && !fig.moving) || t > (until ?? from + LEAVING_SECONDS)) {
        fig.dispose();
        departing.splice(i, 1);
        sayPresent();
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
      // Where that moves the part the agent is framed in, a close-up is fitted to it again; the other views ease
      // there by themselves, frame by frame.
      // Coming into a room, the shot of it is fitted again to the part it is framed in now.
      if (measureOverlays() && (view === "close" || entering.holds)) refit();
      // Reading a surface, a tool coming or going over the stage (someone to talk to, say) frames it again round them.
      if (reading && boxKey() !== readBox) {
        readBox = boxKey();
        refit();
      }
      // What the renderer holds, for anyone inspecting the page, like `data-motion`: shapes and pictures on the
      // GPU. A count that keeps growing place after place is something not let go.
      const { geometries, textures } = renderer.info.memory;
      host.dataset.gpu = `${geometries} ${textures}`;
      // And what the last frame drew, for measuring a place's cost: draws and triangles.
      const { calls, triangles } = renderer.info.render;
      host.dataset.draws = `${calls} ${triangles}`;
    }
    if (opts.visitor) {
      noticeVisitor(t);
      sayAloud(t);
    }
    turnBack(t);
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
    if (town) keepTown(t);
    floatOver(dt);
    placePanels(dt);
    stepAside(now);
    seeThrough(dt);
    if (reading) clearView();
    renderer.render(scene, camera);
    layer.update(camera, stageH, fadedNow, now);
    lookAgain(now);
  });

  /** Leaving the place shown for another: its surfaces stay there, the one being read with them. */
  const leaveSurfaces = () => {
    putDown(true);
    surfacePlace++;
    layer.markStale(() => true);
    pinned.clear();
  };

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
    turnedFor.clear();
    kept = new Map();
    for (const d of departing.splice(0)) d.fig.dispose();
    sayPresent();
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
      if (next === view && !tween && !reading) return;
      putDown(true);
      view = next;
      moveCamera(framing(next));
    },
    setInsets({ right, top = 0, bottom = 0, panels = 0 }) {
      const was = insetRight;
      const moved = top !== insetTop || bottom !== insetBottom || Math.max(0, right) !== columnRight;
      columnRight = Math.max(0, right);
      panelRoom = Math.max(0, panels);
      insetTop = Math.max(0, top);
      insetBottom = Math.max(0, bottom);
      if (applyStrip() || moved || insetRight !== was) resize();
    },
    walkTo: go,
    cue: handleCue,
    setRoom(next, moved = false) {
      if (next === given && !moved) return;
      if (moved) {
        leavePlace();
        leaveSurfaces();
      }
      // The same place changing shows what changed: new things pop in, moved ones glide over. Another place is simply there.
      const changed = changesShown(given, next, !moved);
      const resized = next.width !== room.width || next.depth !== room.depth || next.height !== room.height;
      unfade();
      layer.release();
      scene.remove(furniture);
      disposeTree(furniture);
      appearing.length = 0;
      gliding.length = 0;
      given = next;
      room = next;
      camera.far = farFor(room);
      camera.near = isOutdoors(room) ? 0.15 : 0.05;
      camera.updateProjectionMatrix();
      // Rearranging, what you moved is where you put it already: it doesn't glide over from where it was.
      furnish(changed?.fresh, editing ? undefined : changed?.moved);
      // A surface being read that is still here is framed again where it is now; one taken away is put down.
      if (reading && !layer.howUsed(reading)) putDown();
      else if (reading) {
        // The wall raised over it went with the old furniture.
        raised = undefined;
        const f = readingFraming(reading);
        if (f) moveCamera(f);
        raiseWall(reading, f);
      }
      if (lit) light(lit);
      fitShadows();
      dropped = undefined;
      markEdit();
      // A visitor stays where they are standing: the room changing round them doesn't walk them anywhere.
      if (!opts.visitor) reseat(me, () => (spotById(room, room.start) ? room.start : undefined));
      for (const c of companions.values()) reseat(c, () => freeSpot(c)?.id);
      if (resized && !tween && !opts.visitor) moveCamera(framing(view));
      // Whoever is in the new place, at free spots in it.
      if (moved) meet(wanted);
    },
    enter(next, from) {
      // Everyone in the place you left stays there, and so does everything on its walls.
      leavePlace();
      leaveSurfaces();
      unfade();
      layer.release();
      scene.remove(furniture);
      disposeTree(furniture);
      appearing.length = 0;
      gliding.length = 0;
      given = next;
      room = next;
      camera.far = farFor(room);
      camera.near = isOutdoors(room) ? 0.15 : 0.05;
      camera.updateProjectionMatrix();
      furnish();
      if (lit) light(lit);
      fitShadows();
      markEdit();
      me.director.setRoom(room);
      paceFor();
      const door = doorTo(room, from);
      const first = spotById(room, room.start) ?? room.spots[0];
      const to = door
        ? arrivalAt(room, door, obstacles)
        : { at: first?.at ?? ([0, 0] as [number, number]), facing: rad(first?.facing ?? 0) };
      me.placeAt(to.at, to.facing);
      lastAt = [to.at[0], to.at[1]];
      // The camera shows what the room is gathered round as well as you, until you walk off from here.
      entering.begin([to.at[0], to.at[1]]);
      aimArrival();
      // You stop on the threshold; Shift still runs once you set off again.
      for (const key of [...held])
        if (key in MOVE_KEYS) {
          held.delete(key);
          waiting.add(key);
        }
      tween = null;
      // The same view as on arriving anywhere, centred on where you came in and what the room is gathered round;
      // flying, you turn about a point just ahead of you from there, as you did before the door.
      const f = framing("room");
      const shift = me.head().add(lead).sub(f.target);
      f.target.add(shift);
      f.position.add(shift);
      settle(f);
      if (travel === "fly") flyOn();
      // Whoever is in the new place, at free spots in it.
      meet(wanted);
      requestAnimationFrame(fadeIn);
    },
    setCompany: meet,
    addSurface(surface) {
      const { anchor: given, ...rest } = surface;
      let anchor: THREE.Object3D;
      if (given instanceof THREE.Object3D) anchor = given;
      else {
        // A place in the room: something of its own to lie on, there, kept until the surface goes.
        anchor = new THREE.Object3D();
        anchor.position.set(given.at[0], given.elevation, given.at[1]);
        anchor.rotation.y = rad(given.facing);
        pinned.add(anchor);
        anchor.updateWorldMatrix(true, false);
      }
      const laid = layer.add({ ...rest, anchor });
      // Only this laying of it: a surface laid again under the same id since, by the page, stays.
      return () => {
        layer.remove(rest.id, laid);
        if (anchor.parent === pinned) pinned.remove(anchor);
      };
    },
    onSurfaces: (listener) => layer.subscribe(listener),
    surfaceReady: (id) => layer.ready(id),
    focusSurface(id) {
      if (id) bringUp(id);
      else putDown();
    },
    surfacePoint(id, at) {
      aim(at);
      return layer.pointOn(id, ray.ray);
    },
    walkBy(walker) {
      const { agent } = walker;
      if (!isOutdoors(room) || opts.still || companions.has(agent) || arriving.has(agent) || passing.has(agent)) return;
      const gen = placeGen;
      passing.add(agent);
      loadModel(walker.url)
        .then((model) => {
          passing.delete(agent);
          if (disposed || gen !== placeGen) {
            VRMUtils.deepDispose(model.scene);
            return;
          }
          // Still on its last walk: that body goes, and this one sets out from the door it left by.
          for (let i = departing.length - 1; i >= 0; i--)
            if (departing[i].agent === agent) departing.splice(i, 1)[0].fig.dispose();
          sayPresent();
          const [dx, dz] = [walker.to[0] - walker.from[0], walker.to[1] - walker.from[1]];
          const start = { id: "", name: "", place: "", at: walker.from, facing: (Math.atan2(dx, dz) * 180) / Math.PI };
          const fig = new Figure(model, room, start, {
            reducedMotion: opts.reducedMotion,
            animations: walker.animations,
            // As it chose to look and carry itself, as it would in any room.
            tint: tintOf(walker.looks?.color, agent),
            ...(walker.looks?.size ? { size: walker.looks.size } : {}),
            carriage: carriageOf(walker.looks),
            wear: walker.wear,
            pace: PASSING_PACE,
          });
          scene.add(fig.body, fig.gaze);
          fig.label(walker.name, undefined);
          fig.goTo(room, walker.to, ways());
          // However far the streets take it, with time to spare, and then gone even if something held it up.
          departing.push({ fig, from: clock, until: clock + (Math.hypot(dx, dz) * 1.6) / PASSING_PACE + 8, agent });
        })
        .catch(() => {
          passing.delete(agent);
        });
    },
    where() {
      const p = me.walker.place;
      return travel === "walk" ? [p.x, p.z] : [controls.target.x, controls.target.z];
    },
    standing() {
      const shown = [...(me.body.visible ? [me] : []), ...companions.values()];
      return shown.map((f): [number, number] => [f.walker.place.x, f.walker.place.z]);
    },
    anchorPanel,
    setPlaque(words) {
      if (words === plaqueWords) return;
      plaqueWords = words;
      hangPlaque();
    },
    setWear(wear) {
      myWear = wear;
      me.dress(wear);
    },
    setLooks: reclothe,
    setEmotes(next) {
      emotes = next;
      for (const agent of Object.keys(next)) playEmote(agent);
    },
    standBefore,
    setActivities(next) {
      activities = next;
      rekeep();
      show(self, me);
      for (const [agent, c] of companions) show(agent, c);
      // One on its way out shows what it went to do, as that comes in.
      for (const d of departing) if (d.agent) d.fig.signs.set(behaviorFor(activities[d.agent]).sign, clock);
      lightDoors();
      // Outdoors, each house's windows follow its owner: lit while it works, dark once it sleeps. Only those whose
      // look changed are repainted.
      town?.setWindows(activities, hour, occupied);
      // A call heard of after what was said on it: the far side's words, waiting for a phone here to come out of.
      for (const [agent, line] of inOrder(speech)) hear(agent, line);
    },
    setTasks(next) {
      tasks = next;
      drawBoards();
    },
    setNotes(next) {
      const key = JSON.stringify(next ?? null);
      if (key === notesKey) return;
      notesKey = key;
      notes = next;
      drawWhiteboards();
    },
    setTalked(next) {
      talked = next;
      noteDoors();
    },
    setOccupied(next) {
      occupied = new Set(next);
      town?.setWindows(activities, hour, occupied);
    },
    setScreen(next) {
      const key = JSON.stringify(next);
      if (key === cardsKey) return;
      cards = next;
      cardsKey = key;
      drawScreens();
    },
    setCalendar(next) {
      const key = JSON.stringify(next);
      if (key === calendarKey) return;
      calendar = next;
      calendarKey = key;
      drawCalendars();
    },
    setGlances(next) {
      const key = JSON.stringify(next);
      if (key === glancesKey) return;
      glances = next;
      glancesKey = key;
      drawGlances();
    },
    setLights(next) {
      if (next === lights) return;
      lights = next;
      light(lightingFor(hour, lights));
    },
    setTravel(next) {
      if (!opts.visitor || next === travel) return;
      putDown(true);
      travel = next;
      held.clear();
      // Walking, the wheel zooms the camera following you; flying, it flies you along the way you look (`onWheel`).
      me.body.visible = next === "walk";
      if (next === "fly") {
        dropLead();
        // Outdoors you fly on from where the camera is; in a room, it comes down into the room to take off. Either
        // way it eases there, never a jump.
        moveCamera(takingOff());
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
      // In the order said, which isn't the order the lines came in: an answer timed to follow its question can
      // come first, and a body shows each in its turn.
      for (const [agent, line] of inOrder(next)) hear(agent, line);
    },
    setEditing(next) {
      const was = editing;
      editing = next;
      // What the page says now is where anything let go is shown.
      dropped = undefined;
      if (!was && next) {
        // The keys held to walk are let go, and the view takes in the whole room, panned with the right button. The
        // pointer is the picture's, for picking things up, even if it was a kiosk's a moment ago.
        putDown(true);
        canvas.style.pointerEvents = "";
        held.clear();
        hover(undefined);
        hoverDoor(undefined);
        controls.enablePan = true;
        controls.screenSpacePanning = false;
        editZoom = 1;
        moveCamera(editFraming());
      } else if (was && !next) {
        drag = undefined;
        controls.enablePan = false;
        canvas.style.cursor = "";
        // Back to the view you had: following you on a visit, the agent on the chat page; flying in a room, from
        // inside it again.
        moveCamera(opts.visitor && travel === "fly" ? takingOff() : framing(view));
      }
      markEdit();
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
      canvas.removeEventListener("pointerdown", onEditDown, { capture: true });
      canvas.removeEventListener("pointermove", onEditMove);
      canvas.removeEventListener("pointercancel", onEditCancel);
      handles.dispose();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onSurfaceKey);
      host.removeEventListener("pointermove", route);
      host.removeEventListener("pointerdown", onAwayDown);
      host.removeEventListener("pointerup", onAwayUp);
      layer.dom.removeEventListener("scroll", unscroll);
      layer.dispose();
      controls.dispose();
      me.dispose();
      for (const c of companions.values()) c.dispose();
      companions.clear();
      for (const d of departing.splice(0)) d.fig.dispose();
      for (const c of cues.values()) disposeSprite(c.sprite);
      cues.clear();
      shows.clear();
      unfade();
      // The renderer and all it drew, in the order that lets the page forget them (`shared.ts`).
      takeDown(renderer, scene);
    },
  };
}
