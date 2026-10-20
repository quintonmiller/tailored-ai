/**
 * An agent's body as it chose it: its colour, its model, its size and what
 * it wears; how it idles, stands and walks; what it likes doing
 * when idle; a gesture it is making; and a spot it chose to stay at. The
 * server keeps one `body` record per agent, written by the agent's `body`
 * tool or a person on its card, and an `emote` record for a gesture (see
 * core's `places-body.ts`); this turns them into what the stage draws.
 *
 * A body with nothing chosen looks and moves as it always has: a colour from
 * its name, its own model at its own size, wandering between what its room
 * offers. Pure, and free of three.js, so the agent's card and the map can use
 * it without loading the 3D code.
 */
import { hueFor } from "./doing";
import type { Room } from "./scene";

/** The world-state types the server keeps bodies and gestures in. */
export const BODY_TYPE = "body";
export const EMOTE_TYPE = "emote";

/** How a body idles, as the server names them. */
export const IDLES = ["calm", "lively", "focused", "sleepy"] as const;
export type Idle = (typeof IDLES)[number];
/** How a body stands when nothing else has it. */
export const POSTURES = ["upright", "slouched", "proud", "shy", "arms folded"] as const;
export type Posture = (typeof POSTURES)[number];
/** How a body walks. */
export const WALKS = ["brisk", "stroll", "bouncy", "sneak", "march", "swagger"] as const;
export type Walk = (typeof WALKS)[number];
/** The gestures a body makes when asked, as the server names them; `motion.ts` has a move for each. */
export const EMOTES = [
  "wave",
  "nod",
  "shake",
  "cheer",
  "clap",
  "dance",
  "bow",
  "shrug",
  "think",
  "point",
  "salute",
  "stretch",
  "jump",
  "laugh",
] as const;
export type Emote = (typeof EMOTES)[number];
/** What an idle body can like doing, by the names `idle.ts` gives them, with a word for each. */
export const ERRANDS: Record<string, string> = {
  coffee: "coffee",
  read: "reading",
  window: "the window",
  water: "plants",
  board: "the task board",
  fire: "the fire",
  tv: "TV",
  paint: "painting",
  tidy: "tidying",
  nap: "naps",
  stretch: "stretching",
  fish: "the fish",
  picture: "pictures",
  sit: "sitting",
};
/** How big a body can be made, relative to its model as made. */
export const SIZE_LIMITS: [number, number] = [0.6, 1.4];

/** Somewhere a body chose to be in a place: a spot, or by a thing; until when, if it said. */
export interface ChosenSpot {
  place: string;
  spot?: string;
  item?: string;
  name: string;
  until?: string;
}

/** What the server says to draw a body with: everything chosen, and what it wears worked out. */
export interface BodyLooks {
  /** "#rrggbb", instead of the colour its name gives it. */
  color?: string;
  colorName?: string;
  /** One of the deployment's models, by name, and where to load it from. */
  model?: string;
  avatar?: string;
  size?: number;
  wear?: string[];
  idle?: Idle;
  posture?: Posture;
  walk?: Walk;
  errands?: string[];
  spot?: ChosenSpot;
  away?: { place: string; until: string };
}

/** A gesture a body is making, as the server keeps it. */
export interface EmoteRecord {
  name: string;
  at: string;
  until?: string;
  target?: string;
  /**
   * When this page heard of it, by the page's own clock (`Date.now()`):
   * set on a record that came in while the page was open, so a viewer whose
   * clock is off from the server's still sees it fresh. None on one the page
   * found when it loaded.
   */
  heard?: number;
}

// --------------------------------------------------------------------------
// Colour
// --------------------------------------------------------------------------

/** The robot's own green, which every colour is turned from: the base the map's dots and the clothes use too. */
export const BASE_HUE = 145;
const BASE_SATURATION = 0.52;
const BASE_LIGHTNESS = 0.52;

/**
 * How a body's colours are turned from the model's own: round the colour
 * wheel by `hue` degrees, saturation and lightness scaled. 1 and 1 leave them
 * as the artist made them.
 */
export interface Tint {
  hue: number;
  saturation: number;
  lightness: number;
}

/** A colour as hue (degrees), saturation and lightness (0–1); undefined for anything but `#rrggbb`. */
export function hexToHsl(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * How to turn a body's colours: toward the colour it chose, so a teal body
 * is teal and a grey one grey, kept within what still looks like the model;
 * otherwise round the wheel by its name's own hue, as every body was before
 * it could choose. Undefined leaves the model's own colours (the default
 * agent, unless it chose).
 */
export function tintOf(color: string | undefined, agent: string): Tint | undefined {
  const hsl = color ? hexToHsl(color) : undefined;
  if (hsl) {
    const [h, s, l] = hsl;
    return {
      hue: (((h - BASE_HUE) % 360) + 360) % 360,
      saturation: clamp(s / BASE_SATURATION, 0, 1.6),
      lightness: clamp(l / BASE_LIGHTNESS, 0.4, 1.6),
    };
  }
  const hue = hueFor(agent);
  return hue === undefined ? undefined : { hue, saturation: 1, lightness: 1 };
}

/** The colour a dot for an agent is, on the map and its card: the one it chose, or the one its name gives it. */
export function dotColor(agent: string, color?: string): string {
  if (color && hexToHsl(color)) return color;
  return `hsl(${(BASE_HUE + (hueFor(agent) ?? 0)) % 360} 52% 52%)`;
}

// --------------------------------------------------------------------------
// How it carries itself
// --------------------------------------------------------------------------

/**
 * What an idle style does: how much the body fidgets (`drift`, 1 as before),
 * how long it keeps at one thing (`stay`, a factor on each errand's time),
 * how fast its idle animation plays, and what it is drawn to (a factor on
 * each errand by its name). No style is all ones.
 */
export interface IdleStyle {
  drift: number;
  stay: number;
  pace: number;
  likes: Record<string, number>;
}

const IDLE_STYLES: Record<Idle, IdleStyle> = {
  // Settled: long sits by the window and the fire, a book, little fidgeting.
  calm: { drift: 0.6, stay: 1.5, pace: 0.85, likes: { read: 1.5, window: 1.6, fire: 1.6, sit: 1.4, stretch: 0.5 } },
  // Up and about: quick to move on, stretching, coffee, watering, a bigger sway.
  lively: {
    drift: 1.7,
    stay: 0.55,
    pace: 1.2,
    likes: { stretch: 3, coffee: 1.6, water: 1.5, sit: 0.4, nap: 0.2, tv: 0.5 },
  },
  // On the work: the desk, the board and books, long at each, still.
  focused: {
    drift: 0.45,
    stay: 1.7,
    pace: 0.95,
    likes: { board: 2.5, tidy: 2.2, read: 2, paint: 1.5, tv: 0.2, nap: 0.2, sit: 0.6 },
  },
  // Heavy-lidded: naps wherever it can sit, slow to move, a slow sway.
  sleepy: { drift: 0.7, stay: 1.4, pace: 0.75, likes: { nap: 5, sit: 1.6, fire: 1.4, stretch: 0.6, board: 0.4 } },
};
const NO_STYLE: IdleStyle = { drift: 1, stay: 1, pace: 1, likes: {} };

export function idleStyle(idle: Idle | undefined): IdleStyle {
  return (idle && IDLE_STYLES[idle]) || NO_STYLE;
}

/**
 * What a way of walking does: how fast against its own pace, how much the
 * body bobs with each step (metres), how far it leans forward (radians), how
 * much the arms swing against a plain walk, how much the shoulders sway, and
 * the walk clip it plays instead of the plain one when the files have it.
 */
export interface WalkStyle {
  speed: number;
  bob: number;
  lean: number;
  swing: number;
  sway: number;
  clip?: "sneak" | "march";
}

const WALK_STYLES: Record<Walk, WalkStyle> = {
  brisk: { speed: 1.35, bob: 0.004, lean: 0.06, swing: 1.2, sway: 0 },
  stroll: { speed: 0.7, bob: 0, lean: -0.02, swing: 0.7, sway: 0.03 },
  bouncy: { speed: 1.05, bob: 0.045, lean: 0, swing: 1.3, sway: 0.02 },
  sneak: { speed: 0.6, bob: 0, lean: 0.28, swing: 0.4, sway: 0, clip: "sneak" },
  march: { speed: 1.1, bob: 0.012, lean: -0.04, swing: 1.8, sway: 0, clip: "march" },
  swagger: { speed: 0.85, bob: 0.01, lean: -0.05, swing: 1.1, sway: 0.12 },
};
const PLAIN_WALK: WalkStyle = { speed: 1, bob: 0, lean: 0, swing: 1, sway: 0 };

export function walkStyle(walk: Walk | undefined): WalkStyle {
  return (walk && WALK_STYLES[walk]) || PLAIN_WALK;
}

/**
 * How a body carries itself, for the stage to hand its figure: its idle
 * style and posture, how much it fidgets and how fast its idle plays, and how
 * it walks. Empty for a body that chose none of it.
 */
export function carriageOf(looks: BodyLooks | undefined): {
  idle?: Idle;
  posture?: Posture;
  drift?: number;
  pace?: number;
  walk?: WalkStyle;
} {
  if (!looks) return {};
  const style = idleStyle(looks.idle);
  return {
    ...(looks.idle ? { idle: looks.idle, drift: style.drift, pace: style.pace } : {}),
    ...(looks.posture ? { posture: looks.posture } : {}),
    ...(looks.walk ? { walk: walkStyle(looks.walk) } : {}),
  };
}

/** The same carriage, as words to compare: nothing to change when they match. */
export const carriageKey = (looks: BodyLooks | undefined) =>
  [looks?.idle ?? "", looks?.posture ?? "", looks?.walk ?? "", (looks?.errands ?? []).join(",")].join("\n");

// --------------------------------------------------------------------------
// Where it stays
// --------------------------------------------------------------------------

/** A spot it chose, while it stands: in the place shown, and not run out by `now`. */
export function chosenNow(
  spot: ChosenSpot | undefined,
  place: string | undefined,
  now: number,
): ChosenSpot | undefined {
  if (!spot || !place || spot.place !== place) return undefined;
  if (spot.until && !(Date.parse(spot.until) > now)) return undefined;
  return spot;
}

/**
 * The spot in the room a chosen place to stay means: the spot itself; by a
 * thing, its own spot, or one the page added in front of it (`idleSpots`),
 * or the nearest spot to it; and failing those, whatever spot its words
 * name. Undefined once nothing there fits: the thing was taken away.
 */
export function chosenSpotIn(room: Room, chosen: ChosenSpot): string | undefined {
  if (chosen.spot && room.spots.some((s) => s.id === chosen.spot)) return chosen.spot;
  const item = chosen.item ? room.props.find((p) => p.id === chosen.item) : undefined;
  if (item) {
    const own = room.spots.find((s) => s.item === item.id || s.id === `idle:${item.id}` || s.id === item.spot);
    if (own) return own.id;
    const near = room.spots
      .map((s) => ({ s, d: Math.hypot(s.at[0] - item.at[0], s.at[1] - item.at[1]) }))
      .filter((x) => x.d <= NEAR_ENOUGH)
      .sort((a, b) => a.d - b.d)[0];
    if (near) return near.s.id;
  }
  if (chosen.item) return undefined;
  const words = chosen.name.toLowerCase().replace(/^(on|at|by|in front of|in)\s+/, "");
  return room.spots.find((s) => s.place.toLowerCase() === words || s.name.toLowerCase() === chosen.name.toLowerCase())
    ?.id;
}
/** How far from a thing the nearest spot may be, in metres, to count as by it. */
const NEAR_ENOUGH = 2.2;

/** Where a body stays, for its tag: "staying at the window", "staying in the middle of the room". */
export function stayingWords(name: string): string {
  if (/^(on|at|by|in|near|beside|next to|in front of|under|behind|inside)\b/i.test(name)) return `staying ${name}`;
  return /^(the )?(middle|centre|center|corner)\b/i.test(name) ? `staying in ${name}` : `staying at ${name}`;
}

/**
 * Which rule has a body now, first to last: a conversation face to face with
 * someone here, its work (somewhere to be, something to hold), a person
 * talking to it on the page, the spot it chose to stay at, and only then its
 * own routine: errands and wandering.
 */
export type Plan = "talk" | "work" | "you" | "spot" | "routine";

export function planFor(at: { talking: boolean; working: boolean; engaged: boolean; spot: boolean }): Plan {
  if (at.talking) return "talk";
  if (at.working) return "work";
  if (at.engaged) return "you";
  return at.spot ? "spot" : "routine";
}

/** Each rule, last to first: the higher, the more it has a body. */
const PLAN_ORDER: readonly Plan[] = ["routine", "spot", "you", "work", "talk"];

/**
 * Whether a body at a spot, or on its way to it, makes room there for one
 * coming to it: only for a rule above its own. A body about its routine
 * makes room for one that chose the spot; one that chose it too, is at work
 * there, talking or with you, keeps it, and the other waits until it is free
 * rather than pushing in. Two that chose the same spot don't take turns.
 */
export function makesRoom(holder: Plan, comer: Plan): boolean {
  return PLAN_ORDER.indexOf(holder) < PLAN_ORDER.indexOf(comer);
}

// --------------------------------------------------------------------------
// Gestures
// --------------------------------------------------------------------------

/** A gesture older than this when the page first sees it was made before anyone was looking: it isn't made again. */
export const STALE_EMOTE_MS = 15_000;

/**
 * The gesture a record asks a body to make now, and for how many seconds it
 * keeps going (none for once): only one not made yet (`made`, the time of the
 * last one made), and only while it is fresh or still going. Undefined
 * otherwise. One the page heard come in is timed from when it heard it, on
 * its own clock, however far that is from the server's; only one it found on
 * loading is timed by the server's.
 */
export function emoteNow(
  record: EmoteRecord | undefined,
  made: string | undefined,
  now: number,
): { name: Emote; seconds?: number; target?: string } | undefined {
  if (!record || record.at === made || !(EMOTES as readonly string[]).includes(record.name)) return undefined;
  const sent = Date.parse(record.at);
  const at = record.heard ?? sent;
  const until = record.until ? at + (Date.parse(record.until) - sent) : Number.NaN;
  const going = Number.isFinite(until) && until > now;
  if (!going && !(now - at < STALE_EMOTE_MS)) return undefined;
  return {
    name: record.name as Emote,
    ...(going ? { seconds: (until - now) / 1000 } : {}),
    ...(record.target ? { target: record.target } : {}),
  };
}

/**
 * Whether a body makes a gesture by itself now (a wave to someone walking
 * up, a stretch on getting somewhere): not while one it was asked for is
 * kept going (`keptUntil`, on the same clock), which lasts as long as it was
 * asked to.
 */
export function makesOwnGesture(keptUntil: number | undefined, clock: number): boolean {
  return keptUntil === undefined || clock >= keptUntil;
}

/** A moment after a gesture before a body turns back, so the move is over first. */
const TURN_BACK_PAUSE = 0.4;

/** Where a body turned to make a gesture goes back to facing, and when: the spot it stood at. */
export interface TurnBack {
  spot: string;
  at: number;
}

/**
 * When a body that turns to make a gesture turns back to what its spot
 * faces: `seconds` after `clock`, once the move is over. Undefined when it
 * stood at no spot, with nothing to turn back to. Taken before it turns,
 * since a body turning is on the move and at no spot until it has.
 */
export function turnBackAfter(spot: string | undefined, clock: number, seconds: number): TurnBack | undefined {
  return spot === undefined ? undefined : { spot, at: clock + seconds + TURN_BACK_PAUSE };
}

/**
 * What a body due to turn back does at `t`: "wait" until its time, or
 * while it is still turning; "turn" back once standing at the same spot; and
 * "drop" it when it has gone somewhere else or sat down, which face their
 * own way.
 */
export function turnBackNow(
  turn: TurnBack,
  t: number,
  body: { current: string | undefined; moving: boolean; seated: number },
): "wait" | "turn" | "drop" {
  if (body.current !== turn.spot || body.seated >= 0.05) return "drop";
  if (t < turn.at || body.moving) return "wait";
  return "turn";
}

// --------------------------------------------------------------------------
// Changing it from the page
// --------------------------------------------------------------------------

/** A change a person makes on an agent's card: each field to set, or null to take it back to how it always was. */
export type BodyChange = { [K in keyof BodyLooks]?: BodyLooks[K] | null };

/** The fields a body record keeps; what the server works out besides (where to load a model from) never goes back. */
const KEPT = new Set([
  "color",
  "colorName",
  "model",
  "size",
  "wear",
  "idle",
  "posture",
  "walk",
  "errands",
  "spot",
  "away",
]);

/** A body record with a change made: fields set, those taken back gone, and nothing it doesn't keep. */
export function bodyWith(data: Record<string, unknown>, change: BodyChange): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) if (KEPT.has(key)) out[key] = value;
  for (const [key, value] of Object.entries(change)) {
    if (!KEPT.has(key)) continue;
    if (value === null) delete out[key];
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

// --------------------------------------------------------------------------
// When a body has to be made again
// --------------------------------------------------------------------------

/** What a body is built from: its file, its colours and its size. Anything else is changed on the body as it is. */
export function builtKey(url: string, looks: BodyLooks | undefined, agent: string): string {
  const tint = tintOf(looks?.color, agent);
  return [looks?.avatar ?? url, tint ? `${tint.hue}/${tint.saturation}/${tint.lightness}` : "", looks?.size ?? 1].join(
    "\n",
  );
}
