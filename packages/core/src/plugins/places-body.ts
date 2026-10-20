/**
 * Bodies: an agent with an avatar in charge of its own.
 *
 * The `body` tool lets an agent see itself and choose how it looks and
 * carries itself: its colour, the model it is drawn in, its size and what it
 * wears; how it passes the quiet (an idle style), how it stands, how it
 * walks, and what it likes doing when it has nothing to do. It can make a
 * gesture now, once or for a while, and go somewhere: a spot in the place it
 * is in, in words ("by the window", "sit on the couch"), or another place,
 * staying until it chooses otherwise or a time it gives runs out. Work and
 * conversations still come first: its body goes to its desk to work, or to
 * whoever it is talking to, and back to its spot after.
 *
 * What it chooses is one `body` record per agent, in its own scope, kept like
 * any record, so a restart keeps it; a person chooses the same things on the
 * agent's card. A gesture is an `emote` record, kept in memory: it lasts
 * seconds. The page draws both as they change. An agent that never uses the
 * tool has no record, and looks and moves as it always did.
 *
 * What a body wears used to be a `wear` record of its own, chosen with the
 * `place` tool's `room` action. It is the body record's `wear` now: the place
 * tool's `wear` still works, writing here, and an old `wear` record is read
 * until the body record says what it wears (see {@link wornBy}).
 *
 * Pure apart from the tool, which is handed what it needs from the places
 * plugin (where the agent is, how to go somewhere), so nothing here imports
 * it.
 */
import type { StateCaller, StateService } from "../state/service.js";
import { StateConflictError, StateError } from "../state/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { agentStateCaller } from "../tools/state.js";
import { findItem, findSpot, type Place, parseColor } from "./places-layout.js";
import { aOrAn, parseWear, type Role, WEAR, WEAR_MOST, wearWords } from "./places-roles.js";

export const BODY_TYPE = "body";
export const EMOTE_TYPE = "emote";

// --------------------------------------------------------------------------
// What a body can be
// --------------------------------------------------------------------------

/** How a body passes the quiet: what it is drawn to, how long it stays, how much it fidgets. */
export const IDLES = ["calm", "lively", "focused", "sleepy"] as const;
export type Idle = (typeof IDLES)[number];

/** How a body stands when nothing else has it: its back, shoulders and head, or its arms folded. */
export const POSTURES = ["upright", "slouched", "proud", "shy", "arms folded"] as const;
export type Posture = (typeof POSTURES)[number];

/** How a body walks: its pace and its step. */
export const WALKS = ["brisk", "stroll", "bouncy", "sneak", "march", "swagger"] as const;
export type Walk = (typeof WALKS)[number];

/** Gestures a body can make now, once or for a while. The page has a move for each (`motion.ts`). */
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

/** Other words for the same gestures. */
const EMOTE_WORDS: Record<string, Emote> = {
  hi: "wave",
  hello: "wave",
  bye: "wave",
  yes: "nod",
  no: "shake",
  "head shake": "shake",
  celebrate: "cheer",
  hooray: "cheer",
  yay: "cheer",
  applaud: "clap",
  applause: "clap",
  boogie: "dance",
  groove: "dance",
  ponder: "think",
  hmm: "think",
  hop: "jump",
  giggle: "laugh",
  chuckle: "laugh",
};

/** Things an idle body does, by the page's own names (`idle.ts`), and the words for each. */
export const ERRANDS: Record<string, string[]> = {
  coffee: ["coffee", "tea", "a coffee", "drinks"],
  read: ["reading", "read", "books", "a book"],
  window: ["the window", "window", "looking out"],
  water: ["plants", "the plants", "watering", "gardening"],
  board: ["the task board", "board", "tasks"],
  fire: ["the fire", "fire", "fireplace"],
  tv: ["tv", "television", "watching tv"],
  paint: ["painting", "paint", "the easel"],
  tidy: ["tidying", "tidy", "the desk"],
  nap: ["naps", "napping", "sleep", "sleeping", "dozing"],
  stretch: ["stretching", "stretch", "exercise"],
  fish: ["the fish", "fish", "the aquarium"],
  picture: ["pictures", "the pictures", "art", "paintings"],
  sit: ["sitting", "sit", "breaks", "taking breaks", "resting"],
};
/** The words the tool offers for each, in the same order. */
const ERRAND_SAID = [
  "coffee",
  "reading",
  "the window",
  "plants",
  "the task board",
  "the fire",
  "TV",
  "painting",
  "tidying",
  "naps",
  "stretching",
  "the fish",
  "pictures",
  "sitting",
];
const errandSaid = (id: string) => ERRAND_SAID[Object.keys(ERRANDS).indexOf(id)] ?? id;

/** How big a body can be, relative to its model as made. */
export const SIZE_LIMITS: [number, number] = [0.6, 1.4];
/** The longest a gesture is kept going. */
export const EMOTE_MOST_MS = 5 * 60_000;
/** The longest a body is told to stay somewhere for; longer is until it chooses otherwise. */
export const STAY_MOST_MS = 24 * 60 * 60_000;

/** Somewhere a body chose to be in a place: a spot, or by a thing; until when, if it said. */
export interface ChosenSpot {
  /** The place it is in, by id. */
  place: string;
  /** The spot, by id, when it is one the place has. */
  spot?: string;
  /** The thing it is by, by id, when it has no spot of its own. */
  item?: string;
  /** In words: "on the couch", "by the window". */
  name: string;
  until?: string;
}

/** One agent's body as it chose it, or a person did: each part it hasn't chosen is as it always was. */
export interface BodyData {
  /** "#rrggbb", instead of the colour its name gives it. */
  color?: string;
  /** The words the colour was given in, when it was a name. */
  colorName?: string;
  /** One of the deployment's models, by name, instead of its own. */
  model?: string;
  size?: number;
  wear?: string[];
  idle?: Idle;
  posture?: Posture;
  walk?: Walk;
  /** What it likes doing when idle, by the page's names. */
  errands?: string[];
  spot?: ChosenSpot;
  /** Gone to another place for a while: back home when the time runs out. */
  away?: { place: string; until: string };
}

export const BODY_SCHEMA = {
  type: "object",
  properties: {
    color: { type: "string", pattern: "^#[0-9a-f]{6}$" },
    colorName: { type: "string", maxLength: 40 },
    model: { type: "string", maxLength: 128 },
    size: { type: "number", minimum: SIZE_LIMITS[0], maximum: SIZE_LIMITS[1] },
    wear: { type: "array", maxItems: WEAR_MOST, items: { type: "string", enum: Object.keys(WEAR) } },
    idle: { type: "string", enum: [...IDLES] },
    posture: { type: "string", enum: [...POSTURES] },
    walk: { type: "string", enum: [...WALKS] },
    errands: { type: "array", maxItems: 6, items: { type: "string", enum: Object.keys(ERRANDS) } },
    spot: {
      type: "object",
      required: ["place", "name"],
      properties: {
        place: { type: "string", maxLength: 128 },
        spot: { type: "string", maxLength: 128 },
        item: { type: "string", maxLength: 128 },
        name: { type: "string", maxLength: 120 },
        until: { type: "string" },
      },
    },
    away: {
      type: "object",
      required: ["place", "until"],
      properties: { place: { type: "string", maxLength: 128 }, until: { type: "string" } },
    },
  },
} as const;

/** A gesture being made: which, since when, until when if it goes on, and at whom or what. */
export interface EmoteData {
  name: Emote;
  at: string;
  until?: string;
  target?: string;
}

export const EMOTE_SCHEMA = {
  type: "object",
  required: ["name", "at"],
  properties: {
    name: { type: "string", enum: [...EMOTES] },
    at: { type: "string" },
    until: { type: "string" },
    target: { type: "string", maxLength: 80 },
  },
} as const;

// --------------------------------------------------------------------------
// Reading what was asked
// --------------------------------------------------------------------------

const plain = (v: unknown) =>
  typeof v === "string"
    ? v
        .trim()
        .toLowerCase()
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^(a|an|the|my)\s+/, "")
    : "";

/** Words that take a choice back to what it was before anyone chose. */
const DEFAULT = /^(default|normal|usual|reset|none|own|my own|original)$/;

const given = (v: unknown) => v !== undefined && v !== null && v !== "";

/** One of a list of words, or another way of saying it; the problem when it is none of them. */
function oneOf<T extends string>(v: unknown, words: readonly T[], what: string): T | null | { problem: string } {
  const t = plain(v);
  if (DEFAULT.test(t) || t === "relaxed") return null;
  const found = words.find((w) => w === t || `${w}s` === t || t.startsWith(`${w} `) || t === w.replace(" ", ""));
  return found ?? { problem: `"${String(v)}" isn't ${what}. It is one of: ${words.join(", ")}; or default.` };
}

/** A gesture by its name or another word for it ("waves", "waving", "hooray"); undefined when it is none. */
export function emoteFrom(v: unknown): Emote | undefined {
  const t = plain(v);
  if (!t) return undefined;
  if ((EMOTES as readonly string[]).includes(t)) return t as Emote;
  if (EMOTE_WORDS[t]) return EMOTE_WORDS[t];
  for (const stem of [t.replace(/(ing|ed|es|s)$/, ""), t.replace(/(ing|ed|s)$/, ""), `${t.replace(/(ing|ed)$/, "")}e`])
    if ((EMOTES as readonly string[]).includes(stem)) return stem as Emote;
  return undefined;
}

/** Favourite things to do when idle, from words ("coffee and reading"); none at all for "none". */
export function errandsFrom(v: unknown): string[] | { problem: string } {
  const parts = (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/,|;|&|\+|\/|\band\b/i) : [])
    .map(plain)
    .filter(Boolean);
  if (!parts.length || (parts.length === 1 && /^(none|nothing|anything|default)$/.test(parts[0]))) return [];
  const out: string[] = [];
  for (const part of parts) {
    const id = Object.keys(ERRANDS).find((k) => k === part || ERRANDS[k].includes(part));
    if (!id) return { problem: `"${part}" isn't something to do when idle. You can like: ${ERRAND_SAID.join(", ")}.` };
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > 6) return { problem: "Choose at most six things you like doing." };
  return out;
}

/**
 * How long, from words: "30s", "20 seconds", "2 min", "half an hour",
 * "1.5 hours"; a bare number is in `unit`. The problem as a sentence when it
 * is no length of time.
 */
export function durationFrom(v: unknown, unit: "seconds" | "minutes"): number | { problem: string } {
  const ms = { s: 1000, m: 60_000, h: 3_600_000 };
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v * (unit === "seconds" ? ms.s : ms.m) : bad(v);
  const t = plain(v).replace(/^for\s+/, "");
  if (/^(an|one) hour$/.test(t)) return ms.h;
  if (/^half an hour$/.test(t)) return 30 * ms.m;
  if (/^a (minute|moment)$/.test(t)) return ms.m;
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/.exec(t);
  if (!m) return bad(v);
  const n = Number(m[1]);
  const u = m[2]?.[0] ?? (unit === "seconds" ? "s" : "m");
  return n > 0 ? n * ms[u as keyof typeof ms] : bad(v);
}
const bad = (v: unknown) => ({
  problem: `"${String(v)}" isn't a length of time. Say it like "30s", "20 min" or "2 hours".`,
});

/** What a change asks for, read and checked: the record's new fields, a field set to null taken back. */
export type BodyChange = { [K in keyof BodyData]?: BodyData[K] | null };

/**
 * The parts of a body a `change` asks for, checked: each one given becomes a
 * field to set, or null to take back ("default"). The first problem stops it,
 * so nothing is half changed. `models` are the names it can be drawn in.
 */
export function changeFrom(
  args: Record<string, unknown>,
  models: string[],
): { change: BodyChange; said: string[] } | { problem: string } {
  const change: BodyChange = {};
  const said: string[] = [];
  if (given(args.color)) {
    const t = plain(args.color);
    if (DEFAULT.test(t)) {
      change.color = null;
      change.colorName = null;
      said.push("you're in your own colour again");
    } else {
      const hex = parseColor(String(args.color));
      if (!hex)
        return {
          problem: `"${String(args.color)}" isn't a colour I know. Use a name like "teal" or "dark red", or #rrggbb.`,
        };
      change.color = hex;
      change.colorName = hex === String(args.color).trim().toLowerCase() ? null : t;
      said.push(`you're ${change.colorName ?? hex}`);
    }
  }
  if (given(args.model)) {
    const t = String(args.model).trim();
    if (DEFAULT.test(plain(t))) {
      change.model = null;
      said.push("you're drawn in your own model again");
    } else {
      const lower = t.toLowerCase().replace(/\.vrm$/, "");
      const name = models.find(
        (m) => m.toLowerCase() === t.toLowerCase() || m.toLowerCase().replace(/\.vrm$/, "") === lower,
      );
      if (!name)
        return {
          problem: models.length
            ? `There's no model called "${t}". You can be drawn in: ${models.join(", ")}.`
            : "There are no models to choose from here.",
        };
      change.model = name;
      said.push(`you're drawn in ${name}`);
    }
  }
  if (given(args.size)) {
    const n = typeof args.size === "number" ? args.size : Number(args.size);
    const [lo, hi] = SIZE_LIMITS;
    if (!Number.isFinite(n) || n < lo || n > hi) return { problem: `\`size\` is ${lo} to ${hi}, where 1 is normal.` };
    const size = Math.round(n * 100) / 100;
    change.size = size === 1 ? null : size;
    said.push(size === 1 ? "you're your normal size" : `you're ${size} times your normal size`);
  }
  if (given(args.wear)) {
    const asked = parseWear(args.wear);
    if ("problem" in asked) return { problem: asked.problem };
    if ("suited" in asked) {
      change.wear = null;
      said.push("you wear what suits you");
    } else {
      change.wear = asked.wear;
      said.push(`you wear ${wearWords(asked.wear)}`);
    }
  }
  for (const [key, words, what] of [
    ["idle", IDLES, "an idle style"],
    ["posture", POSTURES, "a posture"],
    ["walk", WALKS, "a way to walk"],
  ] as const) {
    if (!given(args[key])) continue;
    const found = oneOf(args[key], words as readonly string[], what);
    if (found && typeof found === "object") return found;
    (change as Record<string, unknown>)[key] = found;
    said.push(found === null ? `your ${CARRIAGE_WORDS[key]} is as it always was` : carriageWords(key, found));
  }
  if (given(args.errands)) {
    const liked = errandsFrom(args.errands);
    if (!Array.isArray(liked)) return liked;
    change.errands = liked.length ? liked : null;
    said.push(
      liked.length ? `when idle you like ${listWords(liked.map(errandSaid))}` : "when idle you do whatever comes",
    );
  }
  return { change, said };
}

/** "a, b and c". */
function listWords(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
}

/** What each way of carrying itself is called, for the agent. */
const CARRIAGE_WORDS = { idle: "idle style", posture: "posture", walk: "walk" } as const;

/** A way of carrying itself, in words: "you pass the quiet sleepily", "you walk with a brisk step". */
function carriageWords(key: keyof typeof CARRIAGE_WORDS, value: string): string {
  if (key === "idle")
    return `you pass the quiet ${{ calm: "calmly", lively: "in a lively way", focused: "focused", sleepy: "sleepily" }[value] ?? value}`;
  if (key === "posture") return value === "arms folded" ? "you stand with your arms folded" : `you stand ${value}`;
  return value === "sneak" || value === "march" || value === "swagger"
    ? `you ${value} when you walk`
    : `you walk with a ${value} step`;
}

/** The record with a change made: fields set, fields taken back gone. */
export function bodyWith(body: BodyData, change: BodyChange): BodyData {
  const out: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete out[key];
    else if (value !== undefined) out[key] = value;
  }
  return out as BodyData;
}

// --------------------------------------------------------------------------
// Where, in words
// --------------------------------------------------------------------------

/** Words that only say how to get there: "go and sit on", "walk over to", "stand by". */
const LEADING =
  /^(?:(?:go|walk|head|move|run|wander|sit|stand|wait|stay|lie|lay|be|hang out|relax|curl up|settle)(?:\s+(?:down|over|up|out|back|around|and))*\s+)*(?:(?:in front of|next to|up to|across from|onto|into|to|by|at|on|in|near|beside|over|under|behind)\s+)*/;

/** The words that name the thing in "sit on the couch", "over by the big window". */
export function spotWords(words: string): string {
  return words
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(LEADING, "")
    .replace(/^(the|a|an|your|my)\s+/, "")
    .trim();
}

/**
 * Where in a place words mean: one of its spots ("the couch", "by the
 * window", "sit on the couch"), or a thing in it that has none of its own,
 * to stand by ("by the plant"). Undefined when the place has neither.
 */
export function spotIn(place: Place, words: string): { spot?: string; item?: string; name: string } | undefined {
  const t = spotWords(words);
  if (!t) return undefined;
  const exact = findSpot(place, t) ?? findSpot(place, words);
  if (exact) return { spot: exact.id, name: exact.name };
  const item = findItem(place, t);
  if (item) {
    const own = place.spots.find((s) => s.item === item.id || s.id === item.spot);
    return own ? { spot: own.id, name: own.name } : { item: item.id, name: `by ${item.name}` };
  }
  const near = place.spots.find((s) => {
    const n = spotWords(s.place);
    return n.includes(t) || t.includes(n);
  });
  return near ? { spot: near.id, name: near.name } : undefined;
}

/** Where a body stays, as it follows "stay": "on the couch", "at the window", "in the middle of the room". */
export function stayWords(name: string): string {
  if (/^(on|at|by|in|near|beside|next to|in front of|under|behind|inside)\b/i.test(name)) return name;
  return /^(the )?(middle|centre|center|corner)\b/i.test(name) ? `in ${name}` : `at ${name}`;
}

/** What a body chose is still where it is: in that place, and not run out. */
export function chosenNow(body: BodyData | undefined, place: string, now: number): ChosenSpot | undefined {
  const spot = body?.spot;
  if (!spot || spot.place !== place) return undefined;
  const until = spot.until ? Date.parse(spot.until) : Number.NaN;
  return spot.until && !(until > now) ? undefined : spot;
}

/** Whether a stay somewhere has run out by `now`; one with no end never does. */
export const ranOut = (until: string | undefined, now: number) => !!until && !(Date.parse(until) > now);

// --------------------------------------------------------------------------
// What a body wears, and how it looks to the page
// --------------------------------------------------------------------------

/**
 * What a body wears: what its body record says, while that still makes
 * sense; else an old `wear` record from before what it wears moved there;
 * else what suits its role.
 */
export function wornBy(body: BodyData | undefined, legacy: unknown, role: Role | undefined): string[] {
  for (const chosen of [body?.wear, legacy]) {
    if (chosen === undefined) continue;
    const asked = parseWear(chosen);
    if ("wear" in asked) return asked.wear;
  }
  return role?.wear ?? [];
}

/** Every body as chosen, with the old `wear` choices, by agent: what the map and the scenes are drawn from. */
export interface Chosen {
  bodies: Map<string, BodyData>;
  wear: Map<string, unknown>;
}

/** What the page draws an agent's body with: what it is, wears and looks like, and how it carries itself. */
export function looksOf(agent: string, role: Role | undefined, chosen: Chosen) {
  const { wear: _wear, ...body } = chosen.bodies.get(agent) ?? {};
  const wore = chosen.bodies.get(agent)?.wear !== undefined || chosen.wear.has(agent);
  return {
    ...(role ? { role: role.word } : {}),
    wear: wornBy(chosen.bodies.get(agent), chosen.wear.get(agent), role),
    ...(wore ? { wearChosen: true as const } : {}),
    ...body,
  };
}

// --------------------------------------------------------------------------
// In words, for the agent
// --------------------------------------------------------------------------

/** What it looks like and how it carries itself, in a few sentences. */
export function selfWords(body: BodyData, worn: string, model: string | undefined): string {
  const colour = body.color ? `${body.colorName ?? body.color}` : "your own colour";
  const size = body.size ? `, ${body.size} times your normal size` : "";
  const lines = [
    `You are drawn in ${body.model ?? model ?? "your own model"}, in ${colour}${size}. ${worn}`,
    `You pass the quiet ${body.idle ?? "as you always have"}, stand ${body.posture ?? "relaxed"} and walk ${body.walk ? `with a ${body.walk} step` : "at your own pace"}.`,
  ];
  if (body.errands?.length) lines.push(`When idle you like ${listWords(body.errands.map(errandSaid))}.`);
  return lines.join(" ");
}

/** What it can choose, for `look`. */
export function choicesWords(models: string[]): string {
  return [
    "You can change: color (a name or #rrggbb)",
    models.length > 1 ? `model (${models.join(", ")})` : "",
    `size (${SIZE_LIMITS[0]} to ${SIZE_LIMITS[1]})`,
    `wear (${Object.keys(WEAR).join(", ")})`,
    `idle (${IDLES.join(", ")})`,
    `posture (${POSTURES.join(", ")})`,
    `walk (${WALKS.join(", ")})`,
    `errands, what you like doing when idle (${ERRAND_SAID.join(", ")}).`,
  ]
    .filter(Boolean)
    .join(", ")
    .concat(` Emotes: ${EMOTES.join(", ")}.`);
}

/** How long, in words: "30 seconds", "20 minutes", "2 hours". */
function lengthWords(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)} seconds`;
  if (ms < 2 * 3_600_000) return `${Math.round(ms / 60_000)} minutes`;
  return `${Math.round(ms / 360_000) / 10} hours`;
}

// --------------------------------------------------------------------------
// The record
// --------------------------------------------------------------------------

/**
 * What a body wore before it was the body record's: a record of its own,
 * `{ wear: [...] }`, chosen with the place tool. Read until the body record
 * says what it wears, and taken away once it does, so it can never bring an
 * old choice back. Nothing writes one now.
 */
export const WEAR_TYPE = "wear";

export const WEAR_SCHEMA = {
  type: "object",
  required: ["wear"],
  properties: {
    wear: { type: "array", maxItems: WEAR_MOST, items: { type: "string", enum: Object.keys(WEAR) } },
  },
} as const;

/**
 * Change an agent's body record by `change`: made if there is none, and
 * taken away when nothing is left in it. A change to what it wears takes the
 * old `wear` record away too. Read again once if someone changed it a moment
 * ago (a person on its card), since a change names only what it changes.
 */
export async function changeBody(
  service: StateService,
  caller: StateCaller,
  agent: string,
  change: BodyChange,
): Promise<void> {
  const ref = { type: BODY_TYPE, id: agent };
  for (let attempt = 0; ; attempt++) {
    const found = await service.get(caller, ref).catch(() => null);
    const next = bodyWith((found?.data ?? {}) as BodyData, change);
    try {
      if (!Object.keys(next).length) {
        if (found) await service.delete(caller, ref, found.version);
      } else {
        await service.put(
          caller,
          { ...ref, scope: `agent:${agent}`, data: next as Record<string, unknown> },
          found?.version ?? 0,
        );
      }
      break;
    } catch (err) {
      if (err instanceof StateConflictError && attempt === 0) continue;
      throw err;
    }
  }
  if (change.wear === undefined) return;
  const old = { type: WEAR_TYPE, id: agent };
  if (await service.get(caller, old).catch(() => null)) await service.delete(caller, old).catch(() => null);
}

// --------------------------------------------------------------------------
// The tool
// --------------------------------------------------------------------------

const ACTIONS = ["look", "change", "emote", "go"] as const;

/** Words for going nowhere in particular: the spot it chose is let go. */
const ROAM = /^(anywhere|roam|wander|free|nowhere|around|wherever|anywhere you like)$/;
const HOME = /^(home|my room|your room|back home)$/;

/** What the tool needs from the places plugin. */
export interface BodyWorld {
  hasBody(agent: string | undefined): boolean;
  /** The place the agent lives in now: its id, what it is like, and in words ("You are at home."). */
  here(service: StateService, caller: StateCaller, agent: string): Promise<{ id: string; place: Place; words: string }>;
  /** Go to another place by name; undefined when there is no such place, so the words may mean a spot. */
  go(
    service: StateService,
    caller: StateCaller,
    agent: string,
    to: string,
  ): Promise<{ ok: boolean; text: string; id?: string } | undefined>;
  /** The models a body can be drawn in, by name, and the one this agent is drawn in unless it chooses. */
  models(agent: string): { names: string[]; own?: string };
  /** What each agent is for: what it wears unless it chooses. */
  role(agent: string): Role | undefined;
  now?: () => number;
}

const fail = (error: string): ToolResult => ({ success: false, output: "", error });

export class BodyTool implements Tool {
  name = "body";
  description =
    "See and choose your 3D body: colour, model, size, what you wear, how you idle, stand and walk; make a gesture now; or walk somewhere and stay there. Start with look.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          "look: see yourself and what you can choose. change: how you look and carry yourself. emote: a gesture now. go: walk somewhere and stay.",
      },
      color: {
        type: "string",
        description: 'change: a colour name ("teal", "dark red") or #rrggbb; "default" for your own.',
      },
      model: { type: "string", description: "change: the model you're drawn in, from look." },
      size: { type: "number", description: `change: ${SIZE_LIMITS[0]} to ${SIZE_LIMITS[1]}; 1 is normal.` },
      wear: {
        type: "string",
        description: `change: what you wear, from: ${Object.keys(WEAR).join(", ")}; or "none", or "default".`,
      },
      idle: { type: "string", enum: [...IDLES, "default"], description: "change: how you pass the quiet." },
      posture: { type: "string", enum: [...POSTURES, "default"], description: "change: how you stand." },
      walk: { type: "string", enum: [...WALKS, "default"], description: "change: how you walk." },
      errands: { type: "string", description: 'change: what you like doing when idle, e.g. "coffee, reading".' },
      emote: { type: "string", enum: [...EMOTES], description: "emote: the gesture." },
      at: { type: "string", description: "emote: who or what to point or look at." },
      to: {
        type: "string",
        description:
          'go: a spot here ("by the window", "the couch"), another place ("home", a shared place, a room you talk in), or "anywhere" to roam again.',
      },
      for: {
        type: "string",
        description:
          'emote: how long to keep it going ("20s"). go: how long to stay ("30 min"). Leave out for once, or until you choose.',
      },
    },
    required: ["action"],
  };

  constructor(
    private readonly getService: () => StateService,
    private readonly world: BodyWorld,
  ) {}

  private now(): number {
    return this.world.now?.() ?? Date.now();
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!this.world.hasBody(context.agentName)) return fail("You have no body to see or change.");
    const agent = context.agentName ?? "default";
    const service = this.getService();
    const caller = agentStateCaller(context, "body");
    const action = plain(args.action);
    try {
      if (action === "look") return { success: true, output: await this.look(service, caller, agent) };
      if (action === "change") return await this.change(service, caller, agent, args);
      if (action === "emote") return await this.emote(service, caller, agent, args);
      if (action === "go") return await this.go(service, caller, agent, args);
      return fail(`\`action\` is one of: ${ACTIONS.join(", ")}.`);
    } catch (err) {
      if (err instanceof StateError || err instanceof StateConflictError) return fail(err.message);
      throw err;
    }
  }

  private async read(service: StateService, caller: StateCaller, agent: string): Promise<BodyData> {
    const found = await service.get(caller, { type: BODY_TYPE, id: agent }).catch(() => null);
    return (found?.data ?? {}) as BodyData;
  }

  private async legacy(service: StateService, caller: StateCaller, agent: string): Promise<unknown> {
    const found = await service.get(caller, { type: WEAR_TYPE, id: agent }).catch(() => null);
    return found?.data.wear;
  }

  private async look(service: StateService, caller: StateCaller, agent: string): Promise<string> {
    const body = await this.read(service, caller, agent);
    const role = this.world.role(agent);
    const old = await this.legacy(service, caller, agent);
    const worn = wearWords(wornBy(body, old, role));
    const wore =
      body.wear !== undefined || old !== undefined || !role
        ? `You wear ${worn}.`
        : `You wear ${worn}, as suits ${aOrAn(role.word)}.`;
    const { names, own } = this.world.models(agent);
    const here = await this.world.here(service, caller, agent);
    const now = this.now();
    const chosen = chosenNow(body, here.id, now);
    const staying = chosen
      ? ` You're staying ${stayWords(chosen.name)} ${chosen.until ? `for another ${lengthWords(Date.parse(chosen.until) - now)}` : "until you choose otherwise"}; work and conversations come first.`
      : "";
    const away =
      body.away && !ranOut(body.away.until, now)
        ? ` You go home in ${lengthWords(Date.parse(body.away.until) - now)}.`
        : "";
    const spots = here.place.spots.map((s) => s.place).filter((p, i, all) => p && all.indexOf(p) === i);
    return [
      `${here.words}${staying}${away}`,
      selfWords(body, wore, own),
      choicesWords(names),
      spots.length ? `Spots here to go to: ${spots.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async change(
    service: StateService,
    caller: StateCaller,
    agent: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const read = changeFrom(args, this.world.models(agent).names);
    if ("problem" in read) return fail(read.problem);
    if (!read.said.length)
      return fail("Say what to change: color, model, size, wear, idle, posture, walk or errands. `look` lists them.");
    await changeBody(service, caller, agent, read.change);
    let text = `Done: ${listWords(read.said)}.`;
    if (read.change.wear === null)
      text = text.replace(
        "you wear what suits you",
        `you wear ${wearWords(this.world.role(agent)?.wear ?? [])}, what suits you`,
      );
    return { success: true, output: text };
  }

  private async emote(
    service: StateService,
    caller: StateCaller,
    agent: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = emoteFrom(args.emote ?? args.to);
    if (!name)
      return fail(
        given(args.emote)
          ? `"${String(args.emote)}" isn't a gesture you can make. You can: ${EMOTES.join(", ")}.`
          : `Say which with \`emote\`: ${EMOTES.join(", ")}.`,
      );
    const now = this.now();
    let until: number | undefined;
    if (given(args.for)) {
      const long = durationFrom(args.for, "seconds");
      if (typeof long !== "number") return fail(long.problem);
      until = now + Math.min(long, EMOTE_MOST_MS);
    }
    const target = typeof args.at === "string" && args.at.trim() ? args.at.trim().slice(0, 80) : undefined;
    const data: EmoteData = {
      name,
      at: new Date(now).toISOString(),
      ...(until ? { until: new Date(until).toISOString() } : {}),
      ...(target ? { target } : {}),
    };
    await service.put(caller, {
      type: EMOTE_TYPE,
      id: agent,
      scope: "global",
      data: data as unknown as Record<string, unknown>,
    });
    const verb = name === "think" ? "think it over" : name === "point" ? "point" : name;
    return {
      success: true,
      output: `You ${verb}${target ? ` at ${target}` : ""}${until ? ` for ${lengthWords(until - now)}` : ""}.`,
    };
  }

  private async go(
    service: StateService,
    caller: StateCaller,
    agent: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const to = typeof args.to === "string" ? args.to.trim() : "";
    if (!to)
      return fail(
        'Say where with `to`: a spot here ("by the window"), another place ("home", a shared place), or "anywhere".',
      );
    const now = this.now();
    let until: number | undefined;
    if (given(args.for)) {
      const long = durationFrom(args.for, "minutes");
      if (typeof long !== "number") return fail(long.problem);
      until = now + Math.min(long, STAY_MOST_MS);
    }
    const lasting = until ? `for ${lengthWords(until - now)}` : "until you choose otherwise";
    if (ROAM.test(spotWords(to)) || ROAM.test(to.toLowerCase())) {
      await changeBody(service, caller, agent, { spot: null });
      return { success: true, output: "You're free to go where you like again." };
    }
    // Home is a place, never a spot called that.
    const homeward = HOME.test(to.toLowerCase());
    const here = await this.world.here(service, caller, agent);
    const spot = homeward ? undefined : spotIn(here.place, to);
    if (spot) {
      const chosen: ChosenSpot = {
        place: here.id,
        ...spot,
        ...(until ? { until: new Date(until).toISOString() } : {}),
      };
      await changeBody(service, caller, agent, { spot: chosen });
      return {
        success: true,
        output: `You go and stay ${stayWords(chosen.name)} ${lasting}. Work and conversations still come first; you come back after.`,
      };
    }
    const went = await this.world.go(service, caller, agent, to);
    if (!went) {
      const spots = here.place.spots.map((s) => s.place).filter((p, i, all) => p && all.indexOf(p) === i);
      return fail(
        `There's no spot or place called "${to}".${spots.length ? ` Spots here: ${spots.join(", ")}.` : ""} The place tool's places action lists where you can go.`,
      );
    }
    if (!went.ok) return fail(went.text);
    // A spot belongs to the place it is in; a stay somewhere else ends with going home.
    const back = until && !homeward && went.id ? until : undefined;
    await changeBody(service, caller, agent, {
      spot: null,
      away: back && went.id ? { place: went.id, until: new Date(back).toISOString() } : null,
    });
    return { success: true, output: back ? `${went.text} You go home in ${lengthWords(back - now)}.` : went.text };
  }
}
