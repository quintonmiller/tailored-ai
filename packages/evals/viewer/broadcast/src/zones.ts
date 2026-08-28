/**
 * What each zone is made of, and what each room has standing in it.
 *
 * The stage used to draw one room and tint its stone by floor number, which
 * meant fifteen floors of descent looked like the same corridor with the
 * brightness turned down. The simulation has always named five zones and given
 * every room a kind and an environment; none of it reached the picture. This
 * file is that data, and only that data — the decision of what a place looks
 * like, kept apart from the canvas calls that draw it.
 *
 * ## Why it is a leaf, and pure
 *
 * `stage.ts` is a browser module: it opens with `document.createElement` and
 * closes over a canvas. Nothing here touches the DOM, so a test running under
 * Node can import it and assert that the Ash Foundry is warm and the Null Chapel
 * is not — which is the only half of a renderer that can be checked without
 * agreeing on pixels.
 *
 * ## Why the palettes are literals
 *
 * Every colour below is a constant string rather than something derived at
 * paint time. A gradient stop computed per frame is garbage generated sixty
 * times a second for a value that changes when the party changes room, and the
 * five palettes are a design decision that wants to be read as one table rather
 * than as arithmetic.
 *
 * ## The one rule the palettes obey
 *
 * A zone may change the light, the stone, the air and the props. It may not
 * change anything the viewer reads as state — health, mana, statuses,
 * telegraphs, nameplates and beats keep their own colours in every zone, and
 * where a zone's floor is bright enough to fight a bar, the bar wins and the
 * floor gets a scrim underneath it. See docs/broadcast-viewer.md.
 */

/**
 * A stable small number from a string.
 *
 * Lives here rather than in `stage.ts` because both halves want it: the stage
 * for an unknown enemy family, and every piece of per-room jitter below. Room
 * ids repeat across floors — every floor has an `r0` — so callers hash the
 * floor in with the id, which is what {@link roomSeed} exists to make hard to
 * forget.
 */
export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** The stonework's jitter, seeded so a room looks the same on every frame and every replay. */
export function roomSeed(roomId: string, floor: number): number {
  return hash(`${roomId}|${floor}`);
}

/**
 * A tiny deterministic sequence from one seed.
 *
 * Rubble, cracks and scattered packs want a dozen numbers each and want the
 * same dozen every time the room is rebuilt. `Math.random()` would give a room
 * a different floor on every resize, which is the one thing a viewer notices
 * immediately and cannot explain.
 */
export function jitter(seed: number): () => number {
  let s = (Math.floor(seed * 4294967295) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * How a zone is lit, which is most of how it is recognised.
 *
 * Palette alone gets a picture halfway there and then stalls: a green room and
 * a green room lit from below are different places. Each rig is a different
 * arrangement of sources rather than a different colour of the same two
 * sconces, so the zones differ in where the light comes from as well as in what
 * colour it is.
 */
export type LightRig =
  | /** Two wall torches. The surface, and anything with no zone. */ "sconces"
  | /** A cold shaft from a grate overhead, and torches the damp has nearly won. */ "shaft"
  | /** Bioluminescent caps at the wall base: many small sources, no flame. */ "glowcaps"
  | /** An ember trough in the floor. Everything is rim-lit from below. */ "forge"
  | /** No fire at all: cold ambient off the walls, and edges that fringe. */ "refracted"
  | /** One weak lamp, and dark two metres from it. */ "guttered";

/** What the wall is made of. Masonry is the default; the rest are as different as they sound. */
export type Dressing =
  | /** Jointed courses, the way the stage has always drawn stone. */ "masonry"
  | /** Courses with mineral seep running down them, and standing water at the base. */ "seep"
  | /** Soft, close, veined with mycelium, under a ceiling that sags. */ "growth"
  | /** Riveted plate. Rectilinear, hard-edged, no mortar anywhere. */ "iron"
  | /** Faceted crystal set into the wall, throwing prismatic fringes. */ "facets"
  | /** Nothing. The wall is simply where the light stops. */ "bare";

/** Ambient particles: how many, what colour, and which way they go. */
export interface MoteSpec {
  count: number;
  colour: string;
  /** Pixel size at `ts === 1`. */
  size: number;
  /** Screen heights per second. Negative falls, positive rises. */
  rise: number;
  /** Sideways drift, screen widths per second. */
  drift: number;
  /** How far a mote wanders off its drift line, in screen widths. */
  wobble: number;
  alpha: number;
}

export interface ZoneTheme {
  id: string;
  name: string;
  /** Wall gradient, from the top of the panel down to the skirting. */
  wall: readonly [string, string, string];
  /** Floor gradient, from the skirting down to the bottom of the panel. */
  floor: readonly [string, string, string];
  /** Course lines, and how tall a course is as a fraction of panel height. */
  joint: string;
  course: number;
  /** The perspective lines drawn on the floor, and how heavy they are. */
  slab: string;
  slabWidth: number;
  rig: LightRig;
  dressing: Dressing;
  /** The zone's own colour, for its props and for anything else that wants to agree with the stage. */
  accent: string;
  /** The flame or filament at the light source, and the halo around it. */
  fire: { core: string; body: string; glow: string };
  /** The wash the key light lays over the floor: colour, strength, and how far back it sits. */
  pool: { rgb: string; alpha: number; depth: number };
  /**
   * How hard the light gives up, 0 to 1.
   *
   * Feeds the vignette's outer stop only. The inner radius is fixed across
   * every zone on purpose: pulling it in would darken the band the party stands
   * in, and a health bar that is harder to read in one zone than another is
   * exactly the trade this page is not allowed to make.
   */
  falloff: number;
  motes: MoteSpec | null;
  /** Caustic ripples over the floor, 0 to 1. The Sunken Gate is the only zone with weather. */
  caustics: number;
  /** Heat haze over the back wall, 0 to 1. */
  shimmer: number;
  /** A floor bright enough that state drawn over it needs its own scrim. */
  brightFloor: boolean;
}

/**
 * The room with no zone.
 *
 * Reached by the surface outfitter, by any trace written before floor maps
 * existed, and by a zone name this file has never heard of. It is deliberately
 * the stage's old look: cold grey stone and two torches, so the fallback is a
 * room rather than an error.
 */
export const NEUTRAL_ZONE: ZoneTheme = {
  id: "neutral",
  name: "",
  wall: ["#080b11", "#141821", "#232734"],
  floor: ["#1a1c25", "#0f141c", "#080b11"],
  joint: "rgba(0,0,0,0.30)",
  course: 0.052,
  slab: "rgba(255,255,255,0.035)",
  slabWidth: 1,
  rig: "sconces",
  dressing: "masonry",
  accent: "#c8b48a",
  fire: { core: "rgba(255,226,150,0.95)", body: "rgba(240,150,60,0.85)", glow: "240,160,75" },
  pool: { rgb: "255,186,112", alpha: 0.12, depth: 0.55 },
  falloff: 0.45,
  motes: null,
  caustics: 0,
  shimmer: 0,
  brightFloor: false,
};

/**
 * The five, in the order the simulation cycles them.
 *
 * Each one is meant to be named from a still frame with the caption covered.
 * The test beside this file asserts the properties that carry that — warm
 * against cold, lit from below against lit from above, particles against none —
 * because those are the differences a viewer reads, and a palette that drifted
 * back toward the middle would still typecheck.
 */
export const ZONE_THEMES: readonly ZoneTheme[] = [
  {
    // Drowned stone. The light arrives from a grate overhead and everything
    // under it is wet: green-black courses, silt in the air, a floor that
    // ripples. The torches are still here and are visibly losing.
    id: "sunken-gate",
    name: "The Sunken Gate",
    wall: ["#04090a", "#0d1c1d", "#193331"],
    floor: ["#14292a", "#0a1a1c", "#040c0e"],
    joint: "rgba(0,0,0,0.34)",
    course: 0.05,
    slab: "rgba(150,220,210,0.05)",
    slabWidth: 1,
    rig: "shaft",
    dressing: "seep",
    accent: "#7fd4c8",
    fire: { core: "rgba(214,255,244,0.9)", body: "rgba(120,200,190,0.7)", glow: "110,200,190" },
    pool: { rgb: "120,205,195", alpha: 0.13, depth: 0.34 },
    falloff: 0.5,
    motes: { count: 26, colour: "#9fd9cf", size: 1.6, rise: -0.012, drift: 0.006, wobble: 0.02, alpha: 0.22 },
    caustics: 1,
    shimmer: 0,
    brightFloor: false,
  },
  {
    // Organic and close. No flame anywhere: the light is a scatter of glowcaps
    // at the wall base, ochre with a violet cast, and the ceiling sags into the
    // top of the frame so the room reads as low before anything moves.
    id: "fungal-hollows",
    name: "The Fungal Hollows",
    wall: ["#0f0b12", "#221a1e", "#35272b"],
    floor: ["#2b211a", "#1a1410", "#0b0a09"],
    joint: "rgba(0,0,0,0.22)",
    course: 0.075,
    slab: "rgba(215,180,120,0.04)",
    slabWidth: 1,
    rig: "glowcaps",
    dressing: "growth",
    accent: "#c9a24a",
    fire: { core: "rgba(255,236,178,0.9)", body: "rgba(201,162,74,0.75)", glow: "196,150,80" },
    pool: { rgb: "186,150,92", alpha: 0.13, depth: 0.5 },
    falloff: 0.55,
    motes: { count: 34, colour: "#d9c48a", size: 2.2, rise: -0.008, drift: 0.012, wobble: 0.05, alpha: 0.28 },
    caustics: 0,
    shimmer: 0,
    brightFloor: false,
  },
  {
    // Heat and iron. The only zone lit from below — an ember trough runs across
    // the floor and rims every silhouette from underneath — and the only one
    // with no mortar: riveted plate, hard shadows, ash going up rather than
    // down.
    id: "ash-foundry",
    name: "The Ash Foundry",
    wall: ["#090807", "#191513", "#261d17"],
    floor: ["#241b14", "#15100e", "#090707"],
    joint: "rgba(0,0,0,0.5)",
    course: 0.062,
    slab: "rgba(255,150,80,0.06)",
    slabWidth: 1.4,
    rig: "forge",
    dressing: "iron",
    accent: "#f07a30",
    fire: { core: "rgba(255,236,190,0.95)", body: "rgba(240,120,45,0.85)", glow: "240,120,45" },
    pool: { rgb: "255,124,54", alpha: 0.15, depth: 0.22 },
    falloff: 0.4,
    motes: { count: 30, colour: "#c9b3a3", size: 1.8, rise: 0.016, drift: 0.003, wobble: 0.015, alpha: 0.3 },
    caustics: 0,
    shimmer: 1,
    brightFloor: false,
  },
  {
    // Hard, bright, refractive, and still. Joints are bright hairlines rather
    // than dark mortar, the key comes in high from the left so shadows run long,
    // and the air is empty apart from the occasional glint.
    id: "crystal-catacombs",
    name: "The Crystal Catacombs",
    wall: ["#0b1420", "#20303f", "#33475a"],
    floor: ["#2a3844", "#18222b", "#0b1116"],
    joint: "rgba(184,228,255,0.10)",
    course: 0.058,
    slab: "rgba(200,235,255,0.085)",
    slabWidth: 1,
    rig: "refracted",
    dressing: "facets",
    accent: "#a8e0f5",
    fire: { core: "rgba(240,252,255,0.95)", body: "rgba(168,224,245,0.7)", glow: "180,225,255" },
    pool: { rgb: "190,228,255", alpha: 0.12, depth: 0.55 },
    falloff: 0.28,
    motes: { count: 10, colour: "#dff3ff", size: 1.8, rise: 0.002, drift: 0.002, wobble: 0.01, alpha: 0.35 },
    caustics: 0,
    shimmer: 0,
    brightFloor: true,
  },
  {
    // Absence. Near-monochrome, one weak lamp, no particles, and a floor whose
    // perspective lines fade out before they reach the edge of the frame — so
    // the room has no readable extent, which is the whole of the effect.
    id: "null-chapel",
    name: "The Null Chapel",
    wall: ["#050607", "#0c0d0f", "#141517"],
    floor: ["#1a1b1c", "#0e0e0f", "#050505"],
    joint: "rgba(0,0,0,0.6)",
    course: 0.055,
    slab: "rgba(255,255,255,0.02)",
    slabWidth: 1,
    rig: "guttered",
    dressing: "bare",
    accent: "#9a9a94",
    fire: { core: "rgba(226,224,214,0.8)", body: "rgba(150,148,140,0.55)", glow: "170,168,160" },
    pool: { rgb: "156,156,152", alpha: 0.1, depth: 0.44 },
    falloff: 0.92,
    motes: null,
    caustics: 0,
    shimmer: 0,
    brightFloor: false,
  },
];

/**
 * Zone name to theme, tolerating everything a trace can hand over.
 *
 * The names come off the wire, so this matches on a normalised form rather than
 * on identity: an old trace, a renamed zone or a null map all land on the
 * neutral room instead of throwing in a render loop that has no way to recover.
 */
const BY_NAME = new Map<string, ZoneTheme>(ZONE_THEMES.map((z) => [normaliseZone(z.name), z]));

function normaliseZone(name: string): string {
  return name.trim().toLowerCase().replace(/^the\s+/, "");
}

export function themeForZone(zone: string | null | undefined): ZoneTheme {
  if (typeof zone !== "string" || !zone) return NEUTRAL_ZONE;
  return BY_NAME.get(normaliseZone(zone)) ?? NEUTRAL_ZONE;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * What is standing in the room, over and above the zone it is in.
 *
 * A room kind is currently a word in a panel, which means a merchant and a boss
 * gate are the same picture. These are the props that make the kind readable
 * from the stage alone, and they are drawn against the back wall on purpose:
 * anything nearer the camera would have to negotiate with eleven sprites, five
 * health bars and four speech bubbles for the same pixels.
 */
export type PropKind =
  | "none"
  | /** Where the party came in: an arch, and stairs going back up. */ "entrance"
  | /** A lamp on a pole, an awning between two posts, and crates. */ "market"
  | /** A plinth, an offering step, and a standing column of light. */ "shrine"
  | /** A dead expedition's kit: packs, a planted spear, a helmet. */ "cache"
  | /** A ring scored into the floor and the scarring around it. */ "arena"
  | /** A threshold: two heavy leaves, a raised step, chains. */ "gate"
  | /** A shaft going down, with air moving in it. */ "stairs"
  | /** Nothing but what the last fight left. */ "rubble";

/** What the floor and the air are doing, which is what an environment is. */
export type FloorKind =
  | "none"
  | /** Standing water over the whole floor. */ "flooded"
  | /** Ground fog, and far more in the air. */ "spores"
  | /** A lit disc set into the floor, breathing. */ "well"
  | /** A span, with the near corners dropped away. */ "bridge"
  | /** A step across the party's half, raising the back rank. */ "ledge";

export interface Staging {
  prop: PropKind;
  floor: FloorKind;
  /** The room's own label, for the caption and the arrival card. */
  label: string;
  /** Per-room jitter, from the room id *and* the floor: every floor has an `r0`. */
  seed: number;
  /** Everything the baked room canvas depends on, so it is rebuilt exactly when it must be. */
  key: string;
}

export const NO_STAGING: Staging = { prop: "none", floor: "none", label: "", seed: 0, key: "-" };

const PROP_BY_KIND: Record<string, PropKind | undefined> = {
  entrance: "entrance",
  market: "market",
  shrine: "shrine",
  cache: "cache",
  elite: "arena",
  boss: "gate",
  stairs: "stairs",
  combat: "rubble",
  empty: "rubble",
};

const FLOOR_BY_ENVIRONMENT: Record<string, FloorKind | undefined> = {
  flooded: "flooded",
  "spore-cloud": "spores",
  "arcane-well": "well",
  "narrow-bridge": "bridge",
  "high-ground": "ledge",
};

/** The half of a room the scene actually carries. Optional throughout: old traces are shorter. */
export interface StageableRoom {
  id?: string;
  label?: string;
  kind?: string;
  cleared?: boolean;
  environment?: { kind?: string } | null;
}

/**
 * The props and floor for one room.
 *
 * An elite room that has been cleared keeps its arena — the scarring is what
 * happened there — so `cleared` is in the cache key rather than in the choice.
 * A kind or environment this file has no prop for degrades to bare stone, which
 * is the same fallback an unknown zone gets and for the same reason.
 */
export function stagingFor(room: StageableRoom | null | undefined, floor: number): Staging {
  if (!room) return NO_STAGING;
  const id = typeof room.id === "string" ? room.id : "?";
  const kind = typeof room.kind === "string" ? room.kind : "";
  const env = typeof room.environment?.kind === "string" ? room.environment.kind : "";
  const prop = PROP_BY_KIND[kind] ?? "none";
  const floorKind = FLOOR_BY_ENVIRONMENT[env] ?? "none";
  return {
    prop,
    floor: floorKind,
    label: typeof room.label === "string" ? room.label : "",
    seed: roomSeed(id, floor),
    key: `${id}:${prop}:${floorKind}:${room.cleared ? 1 : 0}`,
  };
}

/** The room the party is standing in, or nothing — which is most of a run's first minute. */
export function currentRoom<T extends StageableRoom>(
  map: { currentRoom?: string; rooms?: T[] } | null | undefined,
): T | null {
  if (!map || !Array.isArray(map.rooms)) return null;
  return map.rooms.find((room) => room.id === map.currentRoom) ?? null;
}
