/**
 * What an idle body does with its time: small things, with what its room
 * actually has. It reads at a bookshelf, waters a plant, looks out of a
 * window, studies the task board, makes a coffee at the sideboard, stretches,
 * tidies the desk, sits by the fire, and naps on the couch late at night.
 * Each lasts a while, then it moves on to something else.
 *
 * The choice is weighted by the hour, so mornings smell of coffee and late
 * nights are for napping, and drawn from a seed per agent, so two agents in
 * the same room don't do the same thing at the same time. No model is asked:
 * this is how a body passes the time between the turns that are the agent's
 * own. When the page does ask the agent (`/api/live/idle`, for the agent you
 * are with), its choice of where to go stands, and {@link errandAt} says what
 * it does once it gets there.
 *
 * Furniture that brings no spot of its own (a plant, the task board, a
 * sideboard) gets one here, in front of it and clear of everything else, so
 * there is somewhere to stand to water it or read it. Those spots are the
 * page's alone; the room the agent changes with its `place` tool is
 * untouched. Pure, so it is tested without a GPU.
 */
import type { Hold } from "./doing";
import type { Obstacle } from "./locomotion";
import type { Activity, Prop, Room, Spot } from "./scene";

/** Something an idle body does: where, how, with what in its hand, and for how long. */
export interface Errand {
  /** What it is, so the next pick can be something else: "coffee", "read", "water". */
  id: string;
  /** In a few words, for its tag: "making a coffee". */
  label: string;
  /** The spot it does it at. */
  spot: string;
  /** What it does there: sits, types, looks, browses, or stands when undefined. */
  activity?: Activity;
  hold?: { prop: string; how: Hold };
  /** A gesture once it gets there. */
  gesture?: string;
  /** Eyes shut: a nap. */
  doze?: boolean;
  /** Seconds it keeps at it, [shortest, longest]. */
  seconds: [number, number];
}

/** Numbers in [0, 1) from a string: the same seed gives the same run, so two agents' days differ but each is steady. */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------------
// Somewhere to stand by things that bring no spot
// --------------------------------------------------------------------------

type For = NonNullable<Spot["for"]>;

/**
 * Things worth going up to that bring no spot, what for, and how far in front
 * of the thing's middle to stand. A thing flat to a wall is stood in front of;
 * a round one, on its side toward the middle of the room.
 */
const TENDED: Record<string, { for: For; reach: number; round?: boolean }> = {
  plant: { for: "plant", reach: 0.55, round: true },
  tall_plant: { for: "plant", reach: 0.6, round: true },
  palm: { for: "plant", reach: 0.65, round: true },
  cactus: { for: "plant", reach: 0.55, round: true },
  board: { for: "board", reach: 1.0 },
  sideboard: { for: "counter", reach: 0.65 },
  picture: { for: "picture", reach: 0.95 },
  painting: { for: "picture", reach: 1.05 },
};

/** What the spot is called, by what it is for. */
const SPOT_WORDS: Record<For, string> = {
  plant: "by",
  board: "at",
  counter: "at",
  fish: "by",
  picture: "in front of",
};

/** How much room a body needs round where it stands. */
const BODY = 0.22;
/** How near an added spot may come to one the room already has. */
const APART = 0.55;
/** Most plants watered in one room: a jungle doesn't need a spot by every pot. */
const PLANTS = 3;

const round = (n: number) => Math.round(n * 100) / 100;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Spots in front of the things in a room that bring none of their own: a
 * plant to water, the task board to study, a sideboard to make a coffee at
 * (or watch the fish on it), a picture to look at. Each stands clear of the
 * furniture (`obstacles`, as built) and of the room's own spots, facing the
 * thing; a thing with nowhere clear in front of it gets none.
 */
export function idleSpots(room: Room, obstacles: Obstacle[]): Spot[] {
  const out: Spot[] = [];
  let plants = 0;
  const clear = ([x, z]: [number, number]) =>
    Math.abs(x) <= room.width / 2 - 0.35 &&
    Math.abs(z) <= room.depth / 2 - 0.35 &&
    !obstacles.some((o) => x > o.minX - BODY && x < o.maxX + BODY && z > o.minZ - BODY && z < o.maxZ + BODY) &&
    ![...room.spots, ...out].some((s) => Math.hypot(s.at[0] - x, s.at[1] - z) < APART);
  for (const prop of room.props) {
    const tended = TENDED[prop.kind];
    if (!tended || prop.on || room.spots.some((s) => s.item === prop.id)) continue;
    if (tended.for === "plant" && plants >= PLANTS) continue;
    const at = standBy(prop, tended, clear);
    if (!at) continue;
    if (tended.for === "plant") plants++;
    const fish = tended.for === "counter" && room.props.some((p) => p.on === prop.id && p.kind === "aquarium");
    const what: For = fish ? "fish" : tended.for;
    out.push({
      id: `idle:${prop.id}`,
      name: `${SPOT_WORDS[what]} ${prop.name}`,
      place: prop.name,
      at,
      facing: round(deg(Math.atan2(prop.at[0] - at[0], prop.at[1] - at[1]))),
      ...(what === "board" || what === "picture" ? { activity: "look" as const } : {}),
      for: what,
    });
  }
  return out;
}

/** Where to stand by a thing: straight out in front, then a little either way round it, the first point that is clear. */
function standBy(
  prop: Prop,
  tended: { reach: number; round?: boolean },
  clear: (at: [number, number]) => boolean,
): [number, number] | undefined {
  const out = (prop.facing * Math.PI) / 180;
  // A round thing faces nowhere in particular: the side toward the middle of the room is its front.
  const front = tended.round && Math.hypot(...prop.at) > 0.3 ? Math.atan2(-prop.at[0], -prop.at[1]) : out;
  const reach = tended.reach * (prop.scale ?? 1);
  const turns = tended.round ? [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8] : [0, 0.25, -0.25];
  for (const turn of turns) {
    const a = front + turn;
    const at: [number, number] = [round(prop.at[0] + reach * Math.sin(a)), round(prop.at[1] + reach * Math.cos(a))];
    if (clear(at)) return at;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// What there is to do, and choosing
// --------------------------------------------------------------------------

/** Kinds of place in a room an idle body can go to. */
type Where =
  | For
  | "shelf"
  | "window"
  | "fire"
  | "tv"
  | "easel"
  | "desk"
  | "couch"
  | "seat"
  | "stool"
  | "bed"
  | "middle"
  | "table";

interface Doing {
  id: string;
  label: string;
  /** What it does there: "spot" keeps what the spot is for (sitting, looking out); undefined stands. */
  activity?: Activity | "spot";
  hold?: { prop: string; how: Hold };
  gesture?: string;
  doze?: boolean;
  seconds: [number, number];
  /** How likely, at an hour of the day (0–23). */
  weight: (hour: number) => number;
}

const morning = (h: number) => h >= 6 && h < 11;
const workday = (h: number) => h >= 9 && h < 18;
const evening = (h: number) => h >= 18 && h < 23;
const night = (h: number) => h >= 23 || h < 6;

const BOOK = { prop: "book", how: "chest" } as const;
const MUG = { prop: "mug", how: "chest" } as const;
const sitAndRead: Doing = {
  id: "read",
  label: "reading",
  activity: "spot",
  hold: BOOK,
  seconds: [60, 140],
  weight: (h) => (evening(h) ? 1.3 : night(h) ? 0.3 : 0.7),
};
const nap = (label: string, nightly: number): Doing => ({
  id: "nap",
  label,
  activity: "spot",
  doze: true,
  seconds: [200, 600],
  weight: (h) => (night(h) ? nightly : h >= 13 && h < 15 ? 0.5 : 0.03),
});

/** What there is to do at each kind of place, and how likely it is at each hour. */
const DOINGS: Record<Where, Doing[]> = {
  shelf: [
    {
      id: "read",
      label: "reading by the bookshelf",
      hold: BOOK,
      seconds: [50, 120],
      weight: (h) => (evening(h) || (h >= 13 && h < 18) ? 1.4 : night(h) ? 0.3 : 0.8),
    },
    { id: "browse", label: "looking for a book", activity: "spot", seconds: [15, 30], weight: () => 0.5 },
  ],
  window: [
    {
      id: "window",
      label: "looking out of the window",
      activity: "spot",
      seconds: [25, 60],
      weight: (h) => (night(h) ? 0.4 : 1.2),
    },
  ],
  board: [
    {
      id: "board",
      label: "studying the task board",
      activity: "spot",
      seconds: [30, 70],
      weight: (h) => (workday(h) ? 1.6 : 0.4),
    },
  ],
  plant: [
    {
      id: "water",
      label: "watering the plant",
      hold: { prop: "watering_can", how: "out" },
      seconds: [18, 35],
      weight: (h) => (morning(h) ? 1.6 : night(h) ? 0.05 : 0.7),
    },
  ],
  counter: [
    {
      id: "coffee",
      label: "making a coffee",
      hold: MUG,
      seconds: [30, 60],
      weight: (h) => (morning(h) ? 2.4 : h >= 14 && h < 16 ? 1.3 : night(h) ? 0.15 : 0.6),
    },
  ],
  fish: [{ id: "fish", label: "watching the fish", seconds: [20, 45], weight: () => 0.8 }],
  picture: [
    { id: "picture", label: "looking at the pictures", activity: "spot", seconds: [12, 25], weight: () => 0.4 },
  ],
  fire: [
    {
      id: "fire",
      label: "warming up by the fire",
      activity: "spot",
      seconds: [60, 140],
      weight: (h) => (evening(h) || night(h) ? 1.8 : 0.5),
    },
  ],
  tv: [
    {
      id: "tv",
      label: "watching TV",
      activity: "spot",
      seconds: [60, 160],
      weight: (h) => (evening(h) ? 1.6 : 0.3),
    },
  ],
  easel: [
    { id: "paint", label: "painting", activity: "spot", seconds: [45, 110], weight: (h) => (workday(h) ? 1.2 : 0.4) },
  ],
  desk: [
    {
      id: "tidy",
      label: "tidying the desk",
      hold: { prop: "folder", how: "chest" },
      seconds: [25, 50],
      weight: (h) => (workday(h) ? 1.0 : 0.3),
    },
  ],
  couch: [
    { id: "sit", label: "having a coffee", activity: "spot", hold: MUG, seconds: [45, 100], weight: () => 0.9 },
    sitAndRead,
    nap("napping on the couch", 3),
  ],
  seat: [
    { id: "sit", label: "taking a break", activity: "spot", seconds: [40, 90], weight: () => 0.8 },
    sitAndRead,
    nap("dozing", 1.2),
  ],
  // Somewhere to perch, not to nap.
  stool: [
    { id: "sit", label: "taking a break", activity: "spot", seconds: [30, 70], weight: () => 0.6 },
    { ...sitAndRead, weight: () => 0.4 },
  ],
  bed: [nap("asleep in bed", 4), { ...sitAndRead, weight: () => 0.3 }],
  middle: [{ id: "stretch", label: "stretching", gesture: "stretch", seconds: [8, 14], weight: () => 0.5 }],
  // A meeting room's seats: while it is there, a body mostly sits in on the conversation.
  table: [{ id: "listen", label: "sitting in", activity: "spot", seconds: [90, 240], weight: () => 6 }],
};

/** The kinds of furniture whose own spot means a place to go, by kind. */
const KIND_WHERE: Partial<Record<string, Where>> = {
  bookshelf: "shelf",
  window: "window",
  fireplace: "fire",
  tv: "tv",
  easel: "easel",
  desk: "desk",
  bed: "bed",
  couch: "couch",
  stool: "stool",
};

/** What kind of place a spot is, to an idle body; undefined when there is nothing for it to do there. */
function whereOf(room: Room, spot: Spot): Where | undefined {
  if (spot.for) return spot.for;
  if (/^seat-\d+$/.test(spot.id)) return "table";
  const kind = spot.item ? room.props.find((p) => p.id === spot.item)?.kind : undefined;
  const known = kind ? KIND_WHERE[kind] : undefined;
  if (known) return known;
  if (spot.activity === "sit") return "seat";
  if (spot.id === room.start) return "middle";
  return undefined;
}

/** Whether a room is a meeting room: seats round a table, which bodies there sit in on. */
export const isMeeting = (room: Room) => room.spots.some((s) => /^seat-\d+$/.test(s.id));

/** A doing at a spot, as an errand. */
function errand(spot: Spot, d: Doing): Errand {
  const activity = d.activity === "spot" ? spot.activity : d.activity;
  return {
    id: d.id,
    label: d.label,
    spot: spot.id,
    ...(activity ? { activity } : {}),
    ...(d.hold ? { hold: d.hold } : {}),
    ...(d.gesture ? { gesture: d.gesture } : {}),
    ...(d.doze ? { doze: true } : {}),
    seconds: d.seconds,
  };
}

/** One of several things, each as likely as its weight says; undefined when none has any. */
function draw<T>(options: { item: T; weight: number }[], random: () => number): T | undefined {
  const total = options.reduce((sum, o) => sum + Math.max(0, o.weight), 0);
  if (total <= 0) return undefined;
  let r = random() * total;
  for (const o of options) {
    r -= Math.max(0, o.weight);
    if (r < 0) return o.item;
  }
  return options.at(-1)?.item;
}

/** What it did last counts this much less, so it moves on to something else. */
const AGAIN = 0.15;
/** What an agent says it likes doing counts this much more. */
export const LIKED = 3;

/**
 * How much more or less likely each thing is for one body, by its name: what
 * its idle style draws it to (`idleStyle` in `body.ts`), and what it said it
 * likes doing, several times over. Empty for a body that chose neither.
 */
export function likesOf(style: Record<string, number>, liked: string[] = []): Record<string, number> {
  const out = { ...style };
  for (const id of liked) out[id] = (out[id] ?? 1) * LIKED;
  return out;
}

/**
 * Something for an idle body to do next, from everything its room offers:
 * weighted by the hour and by what it likes (`likes`, by name), less likely
 * to be what it did last or where it is now, never at a spot someone else
 * has. Undefined when the room offers nothing (or all of it is taken).
 */
export function chooseErrand(
  room: Room,
  at: {
    hour: number;
    random: () => number;
    last?: string;
    here?: string;
    taken?: ReadonlySet<string>;
    likes?: Record<string, number>;
  },
): Errand | undefined {
  const options: { item: Errand; weight: number }[] = [];
  for (const spot of room.spots) {
    if (at.taken?.has(spot.id)) continue;
    const where = whereOf(room, spot);
    if (!where) continue;
    for (const d of DOINGS[where]) {
      const weight =
        d.weight(at.hour) *
        (at.likes?.[d.id] ?? 1) *
        (d.id === at.last ? AGAIN : 1) *
        (spot.id === at.here ? AGAIN : 1);
      options.push({ item: errand(spot, d), weight });
    }
  }
  return draw(options, at.random);
}

/**
 * What an idle body does at a spot it was sent to or found itself at: a book
 * at the bookshelf, a coffee on the couch, a nap there late at night.
 * Undefined at a spot with nothing to do.
 *
 * `staying`, for a body that chose to stay at the spot: one thing after
 * another, so only what lasts (no stretch, which is a one-off gesture that
 * would be made over and over), and less likely what it did `last`.
 */
export function errandAt(
  room: Room,
  spotId: string,
  hour: number,
  random: () => number,
  likes: Record<string, number> = {},
  staying?: { last?: string },
): Errand | undefined {
  const spot = room.spots.find((s) => s.id === spotId);
  const where = spot ? whereOf(room, spot) : undefined;
  if (!spot || !where) return undefined;
  const doings = staying ? DOINGS[where].filter((d) => !d.gesture) : DOINGS[where];
  return draw(
    doings.map((d) => ({
      item: errand(spot, d),
      weight: d.weight(hour) * (likes[d.id] ?? 1) * (staying && d.id === staying.last ? AGAIN : 1),
    })),
    random,
  );
}

/**
 * How long a body keeps at an errand at a spot it chose to stay at, in
 * seconds: somewhere in the errand's own span, longer or shorter as its idle
 * style has it (`stay`). Nothing else moves it on there, so this does.
 */
export function stayLength(errand: Errand, stay: number, random: () => number): number {
  const [lo, hi] = errand.seconds;
  return (lo + (hi - lo) * random()) * stay;
}
