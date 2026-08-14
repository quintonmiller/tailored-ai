/**
 * The stage: a lit room, two lines facing each other, and everything that
 * happens between them.
 *
 * This is the one panel a viewer with no context is expected to read, so it is
 * drawn rather than listed. The developer viewer at `/` already renders the same
 * run as text and is better at it; what text cannot do is make somebody who has
 * never heard of the benchmark feel a boss wind up.
 *
 * ## Canvas, not DOM
 *
 * A round produces up to a dozen simultaneous things — a lunge, four damage
 * numbers, a death, a shield — on top of a floor, torchlight and up to eleven
 * sprites. As DOM that is a hundred elements mutating at 60fps and a layout pass
 * every frame; as canvas it is one element and a draw call. It also means the
 * whole stage is one thing to reason about: nothing here can be restyled from
 * outside, so nothing here can be broken from outside.
 *
 * ## Sprites are procedural
 *
 * Nineteen PNGs would be nineteen files to keep in sync with a bestiary that is
 * still being balanced, and a family added to `content.ts` tomorrow would render
 * as a missing-image box. Every silhouette below is canvas primitives, and an
 * unrecognised family still gets a shape derived from its name — see
 * {@link spriteUnknown}. What matters is silhouette: at streaming bitrates the
 * reader tells a guardian from a mage by outline, never by a label.
 *
 * ## Beats are queued, not applied
 *
 * `scene.beats` arrives as a batch — the whole round at once. Playing them
 * simultaneously produces one frame of chaos and no information, so they are
 * scheduled across ~1.5s and played in order. That is also why this module keeps
 * its own clock: `render(state)` means "new data arrived", and the animation
 * between two arrivals is entirely this file's business.
 *
 * ## This module never touches the server
 *
 * It reads a scene and returns pixels. The broadcast has to be incapable of
 * changing what it watches — see docs/broadcast-viewer.md.
 */

import { derive } from "./state.js";
import type {
  BroadcastState,
  ClassId,
  Derived,
  DamageElement,
  Renderer,
  Said,
  Scene,
  SceneBeat,
  SceneEnemy,
  ScenePartyMember,
  SceneStatus,
} from "./types.js";

const TAU = Math.PI * 2;

/**
 * A table with known keys and unknown queries.
 *
 * Everything below is indexed by something the scene chose — a class id, a
 * family, an element, a status — so a miss is ordinary and has to type as
 * `undefined`, which is exactly what the `??` at every lookup is for. The keys
 * written out in each table stay checked against the contract regardless.
 */
type Table<K extends string, V> = Record<K, V> & Record<string, V | undefined>;

/** A spot on the floor in room space: `x` across the room, `d` toward the camera. */
interface Mark {
  x: number;
  d: number;
}

/** Fonts are the CSS stacks, spelled out: canvas needs a string, not a token. */
const SANS = 'system-ui, -apple-system, "Segoe UI", Inter, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

/**
 * Where each class stands, in room space, and it never changes.
 *
 * `x` runs 0 (left wall) to 1 (right wall); `d` runs 0 (back wall) to 1 (nearest
 * the camera). A viewer learns this layout in the first fight and then reads the
 * stage positionally — "the gold one on the front line is hurt" — which only
 * works if the gold one is always on the front line. So the marks are constants,
 * dead members keep their spot as a husk, and nothing reorders them.
 *
 * The guardian holds the largest `x` because it is the one meant to be nearest
 * the enemy; the mage and ranger hold the smallest for the same reason.
 */
const PARTY_MARKS: Table<ClassId, Mark> = {
  guardian: { x: 0.335, d: 0.58 },
  rogue: { x: 0.285, d: 0.87 },
  cleric: { x: 0.175, d: 0.44 },
  mage: { x: 0.105, d: 0.7 },
  ranger: { x: 0.205, d: 0.15 },
};

/** Typed loosely because it is searched with whatever an agent happened to be called. */
const CLASSES: readonly string[] = ["guardian", "mage", "rogue", "cleric", "ranger"] satisfies readonly ClassId[];

/**
 * Enemy formations by headcount.
 *
 * Hand-placed rather than computed from an arc, because the two things a
 * formation has to do fight each other: spread wide enough that six silhouettes
 * do not merge, and stay clustered enough that the group reads as one encounter.
 * Every entry is `[x, d]`, mirroring the party's half of the room.
 */
const FORMATIONS = [
  [],
  [[0.78, 0.5]],
  [
    [0.72, 0.72],
    [0.85, 0.36],
  ],
  [
    [0.7, 0.8],
    [0.85, 0.54],
    [0.73, 0.24],
  ],
  [
    [0.68, 0.84],
    [0.83, 0.62],
    [0.7, 0.38],
    [0.87, 0.18],
  ],
  [
    [0.66, 0.88],
    [0.8, 0.68],
    [0.68, 0.46],
    [0.86, 0.34],
    [0.74, 0.12],
  ],
  [
    [0.65, 0.9],
    [0.78, 0.74],
    [0.67, 0.54],
    [0.87, 0.44],
    [0.72, 0.26],
    [0.89, 0.1],
  ],
];

/** A boss takes the middle of its half and pushes everything else to the edges. */
const BOSS_MARK: Mark = { x: 0.79, d: 0.42 };
const ATTENDANT_MARKS = [
  [0.62, 0.78],
  [0.94, 0.62],
  [0.64, 0.26],
  [0.95, 0.2],
  [0.78, 0.94],
];

/**
 * Damage is coloured by element, and only by element.
 *
 * The one thing a viewer should be able to do without reading is tell "the mage
 * is burning it" from "the mage is freezing it", because that is the difference
 * between a party that inspected the enemy and one that did not — the whole
 * first wall of the dungeon. Physical is deliberately the dullest of the six.
 */
const ELEMENT_COLOUR: Table<DamageElement, string> = {
  physical: "#e4d9c4",
  fire: "#f08840",
  frost: "#79cfe8",
  lightning: "#f5df6a",
  shadow: "#a674e8",
  holy: "#ffe9a8",
};

const HEAL_COLOUR = "#5fb98a";
const SHIELD_COLOUR = "#7cc7e8";
const WASTED_COLOUR = "#71809a";

/** The statuses this file has a colour and a glyph for. Anything else gets the fallbacks. */
type StatusKind =
  | "burn"
  | "poison"
  | "freeze"
  | "sleep"
  | "stun"
  | "shield"
  | "taunt"
  | "mark"
  | "weaken"
  | "regen"
  | "antiheal"
  | "guard";

/** Status colours, kept apart from element colours so the two never read alike. */
const STATUS_COLOUR: Table<StatusKind, string> = {
  burn: "#f08840",
  poison: "#8fc65a",
  freeze: "#79cfe8",
  sleep: "#a674e8",
  stun: "#f5df6a",
  shield: "#7cc7e8",
  taunt: "#d9564f",
  mark: "#ff9d5c",
  weaken: "#9aa3bb",
  regen: "#5fb98a",
  antiheal: "#b9455f",
  guard: "#d8b45a",
};

/**
 * One look per family: two body tones, a glow, and a height.
 *
 * `h` is the silhouette's height as a fraction of the stage's nominal figure, so
 * the bestiary's own sense of scale survives into the picture — a wisp is half a
 * person, a bell is taller than one, and a boss is two and a bit. `float` lifts
 * a body off the floor and shrinks its shadow, which is most of what separates a
 * crystal from a carapace before either has moved.
 */
interface FamilyLook {
  body: string;
  dark: string;
  glow?: string;
  h: number;
  float?: boolean;
}

const FAMILY_LOOK: Record<string, FamilyLook | undefined> = {
  husk: { body: "#7a7166", dark: "#3d3830", h: 0.88 },
  beast: { body: "#8c4c33", dark: "#48261a", h: 0.62 },
  carapace: { body: "#5d6a7a", dark: "#2c343e", h: 0.6 },
  warden: { body: "#4a5680", dark: "#232a44", glow: "#7b8ff5", h: 0.98 },
  shaman: { body: "#6b7f4a", dark: "#313b23", glow: "#c9e07a", h: 0.82 },
  bonewright: { body: "#d6cfb8", dark: "#8a8168", glow: "#9fe0ff", h: 0.96 },
  crystal: { body: "#8fd6e8", dark: "#3d6c7e", glow: "#d8f6ff", h: 0.94, float: true },
  wisp: { body: "#ffb257", dark: "#a3521a", glow: "#ffe1a8", h: 0.44, float: true },
  bell: { body: "#b0894a", dark: "#5a4322", glow: "#f0d99b", h: 1.06 },
  void: { body: "#3c3050", dark: "#171122", glow: "#b47bff", h: 1.08, float: true },
  "saint-attendant": { body: "#e0d7c0", dark: "#8d8368", glow: "#ffe9a8", h: 0.54 },
  "iron-saint": { body: "#bda469", dark: "#5c4d2d", glow: "#ffe9a8", h: 2.05 },
  "hollow-choir": { body: "#cfc7b4", dark: "#39324a", glow: "#a674e8", h: 2.0, float: true },
  "gate-warden": { body: "#6e7683", dark: "#2f3640", glow: "#7b8ff5", h: 2.15 },
  "ashen-alpha": { body: "#6b5a52", dark: "#2d2622", glow: "#f08840", h: 1.5 },
};

/** Class silhouettes differ in build as well as in kit; this is the build half. */
const CLASS_HEIGHT: Table<ClassId, number> = { guardian: 1.06, mage: 0.98, rogue: 0.84, cleric: 0.95, ranger: 0.97 };

/** How long a whole round's worth of beats takes to play out, in ms. */
const BEAT_WINDOW = 1500;

/** How long a speech bubble stays up. Long enough to read a sentence twice. */
const BUBBLE_MS = 6000;

/** How long a corpse takes to become a husk, and how long the husk lingers. */
const DEATH_MS = 900;
const GHOST_MS = 1700;

/**
 * A scene is published after every agent turn, but combat resolves only once
 * per tick. JSON parsing gives every publication a new object identity, so
 * object equality cannot tell a new beat batch from another copy of the old
 * one. The simulation supplies `beatsTick` for exactly this boundary.
 */
export function isNewBeatBatch(previous: number | null, next: number): boolean {
  return next >= 0 && next !== previous;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Ease-out cubic: fast start, settled end — the shape most hits want. */
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** A single rise-and-fall, for anything that pulses once. */
const arch = (t: number) => Math.sin(clamp(t, 0, 1) * Math.PI);

/**
 * Colour arithmetic, memoised.
 *
 * Every sprite wants a darker and a lighter version of its body colour and wants
 * them every frame; parsing the same six hex strings sixty times a second is
 * pure waste, and the cache is bounded by the palette rather than by time.
 */
const shadeCache = new Map<string, string>();
function shade(hex: string, amount: number): string {
  const key = `${hex}|${amount}`;
  let out = shadeCache.get(key);
  if (out) return out;
  const n = Number.parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  r = Math.round(lerp(r, target, t));
  g = Math.round(lerp(g, target, t));
  b = Math.round(lerp(b, target, t));
  out = `rgb(${r},${g},${b})`;
  shadeCache.set(key, out);
  return out;
}

const alphaCache = new Map<string, string>();
function fade(hex: string, a: number): string {
  const key = `${hex}|${a}`;
  let out = alphaCache.get(key);
  if (out) return out;
  const n = Number.parseInt(hex.slice(1), 16);
  out = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  alphaCache.set(key, out);
  return out;
}

/** A stable small number from a string, so an unknown family looks consistent. */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * A drawing context, or nothing to draw on.
 *
 * `getContext` is allowed to return null, and every one of the forty draw calls
 * below would otherwise have to say so. A browser that cannot give us a 2d
 * context cannot show a stage at all, so the check happens once, here, and the
 * rest of the file gets a context that exists.
 */
function require2d(c: CanvasRenderingContext2D | null): CanvasRenderingContext2D {
  if (!c) throw new Error("stage: this browser has no 2d canvas context");
  return c;
}

/** Text with a dark outline. Anything over a lit floor needs one to survive a stream. */
function inkText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string, width: number) {
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = "rgba(6,9,14,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

// ---------------------------------------------------------------------------
// Class sprites
// ---------------------------------------------------------------------------
//
// Every sprite draws with its feet at the origin, its head at `-h`, and facing
// +x. The caller flips x for the enemy side, so a family only has to be drawn
// once and always looks into the fight rather than out of it.

/** Everything a sprite needs to be drawn: two body tones, a highlight, a glow and a height. */
interface SpriteLook {
  body: string;
  dark: string;
  light: string;
  glow: string;
  h: number;
  /** Lifts the body off the floor and shrinks its shadow. Read by the stage, not by the sprite. */
  float?: boolean;
}

/**
 * The signature every silhouette shares.
 *
 * `t` is the frame's clock, for the ones that breathe; `family` is only wanted
 * by {@link spriteUnknown}, which derives a shape from the name. A sprite that
 * needs neither simply declares fewer parameters.
 */
type SpriteFn = (ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number, family?: string) => void;

/** The tallest silhouette, the widest shoulders, and the only shield. */
function spriteGuardian(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark, light } = look;
  ctx.fillStyle = dark;
  ctx.fillRect(-0.15 * h, -0.34 * h, 0.11 * h, 0.34 * h);
  ctx.fillRect(0.04 * h, -0.32 * h, 0.12 * h, 0.32 * h);

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.21 * h, -0.75 * h);
  ctx.lineTo(0.21 * h, -0.75 * h);
  ctx.lineTo(0.16 * h, -0.3 * h);
  ctx.lineTo(-0.16 * h, -0.3 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = dark;
  ctx.fillRect(-0.17 * h, -0.42 * h, 0.34 * h, 0.055 * h);

  // Pauldrons. The shoulder line is what makes this one read as heavy infantry
  // at fifty pixels, so it is deliberately wider than the hips.
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.ellipse(-0.2 * h, -0.72 * h, 0.095 * h, 0.075 * h, 0, 0, TAU);
  ctx.ellipse(0.2 * h, -0.72 * h, 0.105 * h, 0.08 * h, 0, 0, TAU);
  ctx.fill();

  // Helm, visor slit, crest.
  ctx.fillStyle = light;
  roundRect(ctx, -0.1 * h, -0.96 * h, 0.2 * h, 0.21 * h, 0.075 * h);
  ctx.fill();
  ctx.fillStyle = "#0b0f16";
  ctx.fillRect(-0.02 * h, -0.885 * h, 0.12 * h, 0.038 * h);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.03 * h, -0.97 * h);
  ctx.quadraticCurveTo(0.02 * h, -1.12 * h, 0.13 * h, -1.0 * h);
  ctx.quadraticCurveTo(0.05 * h, -0.99 * h, 0.02 * h, -0.955 * h);
  ctx.closePath();
  ctx.fill();

  // The kite shield, held forward. Large on purpose: it is the single prop that
  // has to survive being re-encoded at a low bitrate.
  ctx.fillStyle = light;
  ctx.strokeStyle = dark;
  ctx.lineWidth = Math.max(1, 0.016 * h);
  ctx.beginPath();
  ctx.moveTo(0.2 * h, -0.78 * h);
  ctx.lineTo(0.42 * h, -0.68 * h);
  ctx.lineTo(0.4 * h, -0.3 * h);
  ctx.lineTo(0.28 * h, -0.12 * h);
  ctx.lineTo(0.18 * h, -0.32 * h);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.arc(0.3 * h, -0.46 * h, 0.05 * h, 0, TAU);
  ctx.fill();
}

/** Robed, hooded, and carrying the only thing on stage taller than its owner. */
function spriteMage(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, light, glow } = look;

  // Robe: a bell with no legs showing. Nothing else on the party silhouettes
  // this way, so the outline alone separates the casters from the fighters.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.08 * h, -0.7 * h);
  ctx.lineTo(0.08 * h, -0.7 * h);
  ctx.lineTo(0.22 * h, -0.02 * h);
  ctx.quadraticCurveTo(0, 0.05 * h, -0.22 * h, -0.02 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(0.05 * h, -0.68 * h);
  ctx.lineTo(0.19 * h, -0.44 * h);
  ctx.lineTo(0.12 * h, -0.4 * h);
  ctx.lineTo(0.0, -0.6 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(-0.13 * h, -0.68 * h);
  ctx.quadraticCurveTo(-0.09 * h, -1.02 * h, 0.03 * h, -1.06 * h);
  ctx.quadraticCurveTo(0.13 * h, -0.94 * h, 0.13 * h, -0.68 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#090d14";
  ctx.beginPath();
  ctx.ellipse(0.015 * h, -0.8 * h, 0.075 * h, 0.06 * h, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.fillRect(0.02 * h, -0.815 * h, 0.045 * h, 0.014 * h);

  // Staff and orb. The orb breathes even between rounds, which is most of what
  // stops the idle stage looking like a still frame.
  ctx.strokeStyle = "#6b5334";
  ctx.lineWidth = 0.03 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0.2 * h, 0.0);
  ctx.lineTo(0.25 * h, -1.02 * h);
  ctx.stroke();
  const pulse = 0.85 + 0.15 * Math.sin(t * 0.003);
  ctx.fillStyle = fade(glow, 0.22);
  ctx.beginPath();
  ctx.arc(0.255 * h, -1.05 * h, 0.13 * h * pulse, 0, TAU);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0.255 * h, -1.05 * h, 0.055 * h * pulse, 0, TAU);
  ctx.fill();
}

/** Small, crouched, and hooded — the only party outline that leans forward. */
function spriteRogue(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark, light } = look;

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.02 * h, -0.82 * h);
  ctx.quadraticCurveTo(-0.36 * h, -0.52 * h, -0.27 * h, -0.02 * h);
  ctx.lineTo(-0.04 * h, -0.12 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shade(body, -0.5);
  ctx.fillRect(-0.13 * h, -0.3 * h, 0.1 * h, 0.3 * h);
  ctx.fillRect(0.05 * h, -0.28 * h, 0.1 * h, 0.28 * h);

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.16 * h, -0.72 * h);
  ctx.lineTo(0.14 * h, -0.66 * h);
  ctx.lineTo(0.13 * h, -0.28 * h);
  ctx.lineTo(-0.14 * h, -0.3 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(-0.12 * h, -0.68 * h);
  ctx.quadraticCurveTo(-0.04 * h, -0.98 * h, 0.16 * h, -0.88 * h);
  ctx.quadraticCurveTo(0.18 * h, -0.74 * h, 0.09 * h, -0.66 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#090d14";
  ctx.beginPath();
  ctx.ellipse(0.06 * h, -0.79 * h, 0.06 * h, 0.045 * h, -0.2, 0, TAU);
  ctx.fill();

  // Two daggers, held low and back — the reverse grip is the silhouette.
  ctx.strokeStyle = "#cfd8e6";
  ctx.lineWidth = 0.028 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0.12 * h, -0.44 * h);
  ctx.lineTo(0.3 * h, -0.3 * h);
  ctx.moveTo(-0.1 * h, -0.42 * h);
  ctx.lineTo(-0.24 * h, -0.52 * h);
  ctx.stroke();
}

/** Robed like the mage, but crowned and swinging a censer on a chain. */
function spriteCleric(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, light, glow } = look;

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.09 * h, -0.68 * h);
  ctx.lineTo(0.09 * h, -0.68 * h);
  ctx.lineTo(0.2 * h, -0.02 * h);
  ctx.quadraticCurveTo(0, 0.04 * h, -0.2 * h, -0.02 * h);
  ctx.closePath();
  ctx.fill();

  // Tabard: a vertical band, the one flat graphic element in the party.
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(-0.05 * h, -0.68 * h);
  ctx.lineTo(0.05 * h, -0.68 * h);
  ctx.lineTo(0.07 * h, -0.06 * h);
  ctx.lineTo(-0.07 * h, -0.06 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(-0.14 * h, -0.66 * h, 0.075 * h, 0.06 * h, 0, 0, TAU);
  ctx.ellipse(0.14 * h, -0.66 * h, 0.075 * h, 0.06 * h, 0, 0, TAU);
  ctx.fill();

  ctx.fillStyle = shade(body, 0.4);
  ctx.beginPath();
  ctx.arc(0.01 * h, -0.79 * h, 0.085 * h, 0, TAU);
  ctx.fill();

  // Halo, drawn as a ring in perspective rather than a disc, so it reads as
  // metal above the head instead of a second head.
  ctx.strokeStyle = glow;
  ctx.lineWidth = 0.022 * h;
  ctx.beginPath();
  ctx.ellipse(0.01 * h, -0.93 * h, 0.11 * h, 0.032 * h, 0, 0, TAU);
  ctx.stroke();

  const swing = Math.sin(t * 0.0022) * 0.55;
  const cx = 0.18 * h + Math.sin(swing) * 0.16 * h;
  const cy = -0.5 * h + Math.cos(swing) * 0.22 * h;
  ctx.strokeStyle = shade(glow, -0.35);
  ctx.lineWidth = 0.014 * h;
  ctx.beginPath();
  ctx.moveTo(0.15 * h, -0.6 * h);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.fillStyle = fade(glow, 0.25);
  ctx.beginPath();
  ctx.arc(cx, cy, 0.1 * h, 0, TAU);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, 0.045 * h, 0, TAU);
  ctx.fill();
}

/** Lean, quivered, and carrying an arc — the only curve in the party. */
function spriteRanger(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark, light } = look;

  ctx.strokeStyle = shade(body, -0.55);
  ctx.lineWidth = 0.024 * h;
  ctx.beginPath();
  ctx.moveTo(-0.1 * h, -0.72 * h);
  ctx.lineTo(0.1 * h, -0.5 * h);
  ctx.moveTo(-0.14 * h, -0.66 * h);
  ctx.lineTo(0.06 * h, -0.44 * h);
  ctx.stroke();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.1 * h, -0.72 * h);
  ctx.lineTo(-0.19 * h, -0.82 * h);
  ctx.lineTo(-0.13 * h, -0.68 * h);
  ctx.moveTo(-0.14 * h, -0.66 * h);
  ctx.lineTo(-0.23 * h, -0.76 * h);
  ctx.lineTo(-0.17 * h, -0.62 * h);
  ctx.fill();

  ctx.fillStyle = shade(body, -0.5);
  ctx.fillRect(-0.14 * h, -0.32 * h, 0.1 * h, 0.32 * h);
  ctx.fillRect(0.05 * h, -0.3 * h, 0.1 * h, 0.3 * h);

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.15 * h, -0.74 * h);
  ctx.lineTo(0.15 * h, -0.74 * h);
  ctx.lineTo(0.12 * h, -0.3 * h);
  ctx.lineTo(-0.12 * h, -0.3 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.arc(0.01 * h, -0.84 * h, 0.08 * h, 0, TAU);
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.05 * h, -0.86 * h);
  ctx.quadraticCurveTo(-0.18 * h, -0.8 * h, -0.16 * h, -0.62 * h);
  ctx.quadraticCurveTo(-0.08 * h, -0.72 * h, -0.04 * h, -0.8 * h);
  ctx.closePath();
  ctx.fill();

  // Bow and string. The string is drawn straight and the limb bowed, which is
  // what makes a static frame still look like a drawn bow.
  ctx.strokeStyle = "#8a6a3e";
  ctx.lineWidth = 0.026 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0.2 * h, -0.94 * h);
  ctx.quadraticCurveTo(0.46 * h, -0.52 * h, 0.2 * h, -0.1 * h);
  ctx.stroke();
  ctx.strokeStyle = "rgba(230,238,250,0.55)";
  ctx.lineWidth = 0.008 * h;
  ctx.beginPath();
  ctx.moveTo(0.2 * h, -0.94 * h);
  ctx.quadraticCurveTo(0.13 * h, -0.52 * h, 0.2 * h, -0.1 * h);
  ctx.stroke();
}

const CLASS_SPRITE: Table<ClassId, SpriteFn> = {
  guardian: spriteGuardian,
  mage: spriteMage,
  rogue: spriteRogue,
  cleric: spriteCleric,
  ranger: spriteRanger,
};

// ---------------------------------------------------------------------------
// Enemy sprites
// ---------------------------------------------------------------------------
//
// Same contract as the classes: feet at the origin, facing +x, and the caller
// flips. The families are drawn to separate along one axis each — husk stoops,
// beast is horizontal, carapace is a dome, crystal is angular, wisp is round,
// bell is a hanging object, void has no feet — because a viewer sorting eleven
// shapes at speed is doing it by one difference, not by six.

/** Shambling, tattered, arms hanging past its knees. */
function spriteHusk(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark, glow } = look;
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.16 * h, -0.36 * h);
  ctx.lineTo(0.16 * h, -0.36 * h);
  ctx.lineTo(0.13 * h, 0);
  ctx.lineTo(0.06 * h, -0.06 * h);
  ctx.lineTo(0, 0);
  ctx.lineTo(-0.07 * h, -0.05 * h);
  ctx.lineTo(-0.14 * h, 0.01 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.19 * h, -0.72 * h);
  ctx.lineTo(0.17 * h, -0.78 * h);
  ctx.lineTo(0.16 * h, -0.34 * h);
  ctx.lineTo(-0.17 * h, -0.34 * h);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = body;
  ctx.lineWidth = 0.055 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0.14 * h, -0.7 * h);
  ctx.quadraticCurveTo(0.3 * h, -0.5 * h, 0.24 * h, -0.24 * h);
  ctx.moveTo(-0.16 * h, -0.68 * h);
  ctx.quadraticCurveTo(-0.28 * h, -0.46 * h, -0.2 * h, -0.22 * h);
  ctx.stroke();

  // The head sits forward of the shoulders, not on top of them.
  ctx.fillStyle = shade(body, 0.15);
  ctx.beginPath();
  ctx.ellipse(0.08 * h, -0.84 * h, 0.085 * h, 0.075 * h, 0.25, 0, TAU);
  ctx.fill();
  ctx.fillStyle = glow ?? "#c9743a";
  ctx.beginPath();
  ctx.arc(0.12 * h, -0.85 * h, 0.016 * h, 0, TAU);
  ctx.arc(0.04 * h, -0.87 * h, 0.016 * h, 0, TAU);
  ctx.fill();
}

/** Four legs and a long spine: the only horizontal silhouette in the bestiary. */
function spriteBeast(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark, glow } = look;
  const w = h * 1.5;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 0.09 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-0.28 * w, -0.42 * h);
  ctx.lineTo(-0.3 * w, -0.02 * h);
  ctx.moveTo(-0.16 * w, -0.42 * h);
  ctx.lineTo(-0.12 * w, -0.02 * h);
  ctx.moveTo(0.14 * w, -0.44 * h);
  ctx.lineTo(0.12 * w, -0.02 * h);
  ctx.moveTo(0.26 * w, -0.44 * h);
  ctx.lineTo(0.3 * w, -0.02 * h);
  ctx.stroke();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, -0.56 * h, 0.34 * w, 0.2 * h, -0.04, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = body;
  ctx.lineWidth = 0.05 * h;
  ctx.beginPath();
  ctx.moveTo(-0.32 * w, -0.6 * h);
  ctx.quadraticCurveTo(-0.48 * w, -0.72 * h, -0.44 * w, -0.9 * h);
  ctx.stroke();

  // Neck, muzzle and ears carried forward and low, which is what makes it read
  // as something coming at the party rather than standing in front of them.
  ctx.fillStyle = shade(body, 0.12);
  ctx.beginPath();
  ctx.moveTo(0.2 * w, -0.68 * h);
  ctx.lineTo(0.42 * w, -0.78 * h);
  ctx.lineTo(0.56 * w, -0.64 * h);
  ctx.lineTo(0.42 * w, -0.54 * h);
  ctx.lineTo(0.22 * w, -0.46 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(0.3 * w, -0.8 * h);
  ctx.lineTo(0.34 * w, -0.98 * h);
  ctx.lineTo(0.4 * w, -0.79 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0.44 * w, -0.7 * h, 0.022 * h, 0, TAU);
  ctx.fill();
}

/** A low armoured dome on six legs. Nothing else on stage is wider than tall. */
function spriteCarapace(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark } = look;
  const w = h * 1.35;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 0.06 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) {
    if (i === 0) continue;
    const x = i * 0.14 * w;
    ctx.moveTo(x, -0.3 * h);
    ctx.lineTo(x + 0.06 * w, -0.01 * h);
  }
  ctx.stroke();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, -0.34 * h, 0.44 * w, 0.6 * h, 0, Math.PI, TAU);
  ctx.fill();

  // Plate seams. Three of them, because two reads as a bug and four as noise.
  ctx.strokeStyle = shade(dark, 0.1);
  ctx.lineWidth = 0.03 * h;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.ellipse(i * 0.13 * w, -0.34 * h, 0.44 * w - Math.abs(i) * 0.06 * w, 0.6 * h, 0, Math.PI, TAU);
    ctx.stroke();
  }

  ctx.fillStyle = shade(body, 0.2);
  ctx.beginPath();
  ctx.ellipse(0.42 * w, -0.3 * h, 0.12 * w, 0.16 * h, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 0.035 * h;
  ctx.beginPath();
  ctx.moveTo(0.5 * w, -0.34 * h);
  ctx.lineTo(0.66 * w, -0.42 * h);
  ctx.moveTo(0.5 * w, -0.24 * h);
  ctx.lineTo(0.66 * w, -0.16 * h);
  ctx.stroke();
}

/** An upright ward-pillar with glyphs orbiting it. The runes are the tell. */
function spriteWarden(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.1 * h, -0.82 * h);
  ctx.lineTo(0.1 * h, -0.82 * h);
  ctx.lineTo(0.22 * h, -0.02 * h);
  ctx.quadraticCurveTo(0, 0.04 * h, -0.22 * h, -0.02 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.14 * h, -0.8 * h);
  ctx.lineTo(0.14 * h, -0.8 * h);
  ctx.lineTo(0.1 * h, -0.52 * h);
  ctx.lineTo(-0.1 * h, -0.52 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shade(body, 0.3);
  ctx.beginPath();
  ctx.ellipse(0.01 * h, -0.9 * h, 0.09 * h, 0.11 * h, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#0a0e15";
  ctx.beginPath();
  ctx.ellipse(0.03 * h, -0.9 * h, 0.055 * h, 0.075 * h, 0, 0, TAU);
  ctx.fill();

  // Three glyphs on a slow orbit. Cheap, and it makes "spells slide off it"
  // legible before anybody has cast anything at it.
  ctx.fillStyle = glow;
  for (let i = 0; i < 3; i++) {
    const a = t * 0.0012 + (i * TAU) / 3;
    const rx = 0.3 * h * Math.cos(a);
    const ry = -0.6 * h + 0.1 * h * Math.sin(a);
    ctx.globalAlpha = 0.4 + 0.45 * (0.5 + 0.5 * Math.sin(a));
    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(a);
    ctx.fillRect(-0.028 * h, -0.028 * h, 0.056 * h, 0.056 * h);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/** Hunched, small-bodied, and dwarfed by the totem it carries. */
function spriteShaman(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark, glow } = look;
  ctx.fillStyle = dark;
  ctx.fillRect(-0.13 * h, -0.26 * h, 0.09 * h, 0.26 * h);
  ctx.fillRect(0.04 * h, -0.26 * h, 0.09 * h, 0.26 * h);

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(-0.02 * h, -0.44 * h, 0.2 * h, 0.24 * h, -0.18, 0, TAU);
  ctx.fill();

  ctx.fillStyle = shade(body, 0.2);
  ctx.beginPath();
  ctx.ellipse(0.09 * h, -0.66 * h, 0.11 * h, 0.1 * h, 0.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#0a0e15";
  ctx.beginPath();
  ctx.arc(0.14 * h, -0.66 * h, 0.02 * h, 0, TAU);
  ctx.arc(0.06 * h, -0.69 * h, 0.02 * h, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "#57452b";
  ctx.lineWidth = 0.035 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0.2 * h, 0);
  ctx.lineTo(0.26 * h, -0.94 * h);
  ctx.stroke();
  ctx.fillStyle = "#ddd6bf";
  ctx.beginPath();
  ctx.ellipse(0.27 * h, -1.0 * h, 0.075 * h, 0.085 * h, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#0a0e15";
  ctx.beginPath();
  ctx.arc(0.31 * h, -1.02 * h, 0.022 * h, 0, TAU);
  ctx.arc(0.23 * h, -1.02 * h, 0.022 * h, 0, TAU);
  ctx.fill();
  ctx.fillStyle = fade(glow, 0.5);
  ctx.beginPath();
  ctx.arc(0.27 * h, -1.0 * h, 0.13 * h, 0, TAU);
  ctx.fill();
}

/** Bone, drilled and rigid: straight lines where the husk has curves. */
function spriteBonewright(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook) {
  const { body, dark, glow } = look;
  ctx.strokeStyle = body;
  ctx.lineWidth = 0.045 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-0.08 * h, -0.4 * h);
  ctx.lineTo(-0.09 * h, 0);
  ctx.moveTo(0.07 * h, -0.4 * h);
  ctx.lineTo(0.08 * h, 0);
  ctx.stroke();

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.13 * h, -0.46 * h);
  ctx.lineTo(0.13 * h, -0.46 * h);
  ctx.lineTo(0.1 * h, -0.36 * h);
  ctx.lineTo(-0.1 * h, -0.36 * h);
  ctx.closePath();
  ctx.fill();

  // Ribs: five bars on a tapered cage, drawn as strokes so the gaps show.
  ctx.strokeStyle = body;
  ctx.lineWidth = 0.032 * h;
  for (let i = 0; i < 5; i++) {
    const y = -0.5 * h - i * 0.06 * h;
    const w = 0.13 * h + i * 0.012 * h;
    ctx.beginPath();
    ctx.moveTo(-w, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.lineWidth = 0.03 * h;
  ctx.beginPath();
  ctx.moveTo(0, -0.5 * h);
  ctx.lineTo(0, -0.8 * h);
  ctx.stroke();

  ctx.fillStyle = shade(body, 0.15);
  ctx.beginPath();
  ctx.ellipse(0.02 * h, -0.88 * h, 0.085 * h, 0.09 * h, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0.06 * h, -0.9 * h, 0.022 * h, 0, TAU);
  ctx.arc(-0.02 * h, -0.9 * h, 0.022 * h, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "#b9c2d0";
  ctx.lineWidth = 0.03 * h;
  ctx.beginPath();
  ctx.moveTo(0.14 * h, -0.62 * h);
  ctx.lineTo(0.34 * h, -0.98 * h);
  ctx.stroke();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.arc(-0.2 * h, -0.56 * h, 0.13 * h, 0, TAU);
  ctx.fill();
}

/** Angular, faceted and hovering — the hard-edged counterpart to the wisp. */
function spriteCrystal(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  const bob = Math.sin(t * 0.0016) * 0.02 * h;
  ctx.save();
  ctx.translate(0, bob);

  ctx.fillStyle = fade(glow, 0.14);
  ctx.beginPath();
  ctx.arc(0, -0.5 * h, 0.42 * h, 0, TAU);
  ctx.fill();

  // Shards first, so the main prism sits in front of them.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.3 * h, -0.32 * h);
  ctx.lineTo(-0.16 * h, -0.62 * h);
  ctx.lineTo(-0.07 * h, -0.26 * h);
  ctx.closePath();
  ctx.moveTo(0.3 * h, -0.42 * h);
  ctx.lineTo(0.17 * h, -0.76 * h);
  ctx.lineTo(0.08 * h, -0.34 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(0, -1.0 * h);
  ctx.lineTo(0.2 * h, -0.62 * h);
  ctx.lineTo(0.12 * h, -0.14 * h);
  ctx.lineTo(-0.12 * h, -0.14 * h);
  ctx.lineTo(-0.2 * h, -0.62 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shade(body, 0.35);
  ctx.beginPath();
  ctx.moveTo(0, -1.0 * h);
  ctx.lineTo(0.2 * h, -0.62 * h);
  ctx.lineTo(0.06 * h, -0.4 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(dark, -0.15);
  ctx.beginPath();
  ctx.moveTo(0, -1.0 * h);
  ctx.lineTo(-0.2 * h, -0.62 * h);
  ctx.lineTo(-0.05 * h, -0.36 * h);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = fade(glow, 0.55 + 0.35 * Math.sin(t * 0.004));
  ctx.lineWidth = 0.02 * h;
  ctx.beginPath();
  ctx.moveTo(0, -0.86 * h);
  ctx.lineTo(0.02 * h, -0.3 * h);
  ctx.stroke();
  ctx.restore();
}

/** A soft round flame with a tail. Small, floating, and never straight-edged. */
function spriteWisp(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, glow } = look;
  const bob = Math.sin(t * 0.0035) * 0.05 * h;
  ctx.save();
  ctx.translate(0, -0.5 * h + bob);

  ctx.fillStyle = fade(glow, 0.16);
  ctx.beginPath();
  ctx.arc(0, 0, 0.62 * h, 0, TAU);
  ctx.fill();

  // Tail streams behind (away from the party), so even a still frame has a
  // direction of travel.
  ctx.fillStyle = fade(body, 0.5);
  ctx.beginPath();
  ctx.moveTo(-0.06 * h, -0.16 * h);
  ctx.quadraticCurveTo(-0.6 * h, -0.1 * h + Math.sin(t * 0.005) * 0.08 * h, -0.85 * h, 0.08 * h);
  ctx.quadraticCurveTo(-0.5 * h, 0.12 * h, -0.06 * h, 0.18 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, 0.3 * h, 0, TAU);
  ctx.fill();
  ctx.fillStyle = shade(glow, 0.35);
  ctx.beginPath();
  ctx.arc(0.04 * h, -0.05 * h, 0.16 * h, 0, TAU);
  ctx.fill();

  ctx.fillStyle = fade(glow, 0.8);
  for (let i = 0; i < 3; i++) {
    const a = t * 0.003 + (i * TAU) / 3;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 0.44 * h, Math.sin(a) * 0.22 * h, 0.035 * h, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** A hanging bell in a frame: an object rather than a creature, and it sways. */
function spriteBell(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  const swing = Math.sin(t * 0.0011) * 0.08;

  ctx.strokeStyle = shade(dark, -0.2);
  ctx.lineWidth = 0.05 * h;
  ctx.beginPath();
  ctx.moveTo(-0.3 * h, 0);
  ctx.lineTo(-0.2 * h, -0.92 * h);
  ctx.moveTo(0.3 * h, 0);
  ctx.lineTo(0.2 * h, -0.92 * h);
  ctx.moveTo(-0.24 * h, -0.9 * h);
  ctx.lineTo(0.24 * h, -0.9 * h);
  ctx.stroke();

  ctx.save();
  ctx.translate(0, -0.9 * h);
  ctx.rotate(swing);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.06 * h, 0.02 * h);
  ctx.lineTo(0.06 * h, 0.02 * h);
  ctx.lineTo(0.09 * h, 0.14 * h);
  ctx.quadraticCurveTo(0.34 * h, 0.34 * h, 0.32 * h, 0.66 * h);
  ctx.lineTo(-0.32 * h, 0.66 * h);
  ctx.quadraticCurveTo(-0.34 * h, 0.34 * h, -0.09 * h, 0.14 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(body, 0.25);
  ctx.beginPath();
  ctx.moveTo(-0.14 * h, 0.2 * h);
  ctx.quadraticCurveTo(-0.24 * h, 0.4 * h, -0.2 * h, 0.64 * h);
  ctx.lineTo(-0.08 * h, 0.64 * h);
  ctx.quadraticCurveTo(-0.1 * h, 0.4 * h, -0.04 * h, 0.2 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.fillRect(-0.34 * h, 0.62 * h, 0.68 * h, 0.09 * h);
  ctx.fillStyle = shade(glow, -0.2);
  ctx.beginPath();
  ctx.arc(0, 0.74 * h, 0.06 * h, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Tall, hovering, faceless. The robe never reaches the floor. */
function spriteVoid(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  const bob = Math.sin(t * 0.0014) * 0.02 * h;
  ctx.save();
  ctx.translate(0, bob);

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.12 * h, -0.84 * h);
  ctx.lineTo(0.12 * h, -0.84 * h);
  ctx.lineTo(0.22 * h, -0.2 * h);
  ctx.lineTo(0.14 * h, -0.1 * h);
  ctx.lineTo(0.06 * h, -0.2 * h);
  ctx.lineTo(-0.02 * h, -0.08 * h);
  ctx.lineTo(-0.11 * h, -0.2 * h);
  ctx.lineTo(-0.2 * h, -0.12 * h);
  ctx.closePath();
  ctx.fill();

  // Sleeves held wide. It is the only thing in the room with open arms, which
  // is exactly the wrong feeling and the right one for a void priest.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.1 * h, -0.8 * h);
  ctx.quadraticCurveTo(-0.42 * h, -0.66 * h, -0.36 * h, -0.36 * h);
  ctx.lineTo(-0.24 * h, -0.42 * h);
  ctx.quadraticCurveTo(-0.24 * h, -0.6 * h, -0.06 * h, -0.66 * h);
  ctx.closePath();
  ctx.moveTo(0.1 * h, -0.8 * h);
  ctx.quadraticCurveTo(0.42 * h, -0.66 * h, 0.36 * h, -0.36 * h);
  ctx.lineTo(0.24 * h, -0.42 * h);
  ctx.quadraticCurveTo(0.24 * h, -0.6 * h, 0.06 * h, -0.66 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#05060a";
  ctx.beginPath();
  ctx.ellipse(0.01 * h, -0.92 * h, 0.1 * h, 0.13 * h, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = fade(glow, 0.7);
  ctx.lineWidth = 0.016 * h;
  ctx.beginPath();
  ctx.ellipse(0.01 * h, -0.92 * h, 0.1 * h, 0.13 * h, 0, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = glow;
  for (let i = 0; i < 3; i++) {
    const a = t * 0.0009 + (i * TAU) / 3;
    ctx.globalAlpha = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(a * 2));
    ctx.beginPath();
    ctx.arc(0.01 * h + Math.cos(a) * 0.045 * h, -0.92 * h + Math.sin(a) * 0.06 * h, 0.012 * h, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** A kneeling acolyte with a candle. Half height, and it never looks dangerous. */
function spriteAttendant(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.1 * h, -0.6 * h);
  ctx.lineTo(0.1 * h, -0.6 * h);
  ctx.lineTo(0.26 * h, -0.02 * h);
  ctx.quadraticCurveTo(0, 0.05 * h, -0.26 * h, -0.02 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(0.02 * h, -0.68 * h, 0.09 * h, 0.1 * h, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = fade(glow, 0.3);
  ctx.beginPath();
  ctx.arc(0.02 * h, -0.92 * h, 0.13 * h, 0, TAU);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.ellipse(0.02 * h, -0.92 * h, 0.032 * h, 0.055 * h + Math.sin(t * 0.008) * 0.008 * h, 0, 0, TAU);
  ctx.fill();
}

/**
 * A family the bestiary grew after this file was written.
 *
 * Derived from the name rather than hardcoded, so `content.ts` can add a family
 * tomorrow and get a consistent silhouette instead of a missing-image box —
 * which is most of the argument for procedural sprites in the first place. Two
 * bits of the hash pick horns and stance; the hue comes from the same number, so
 * the same family always looks the same way.
 */
function spriteUnknown(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, _t: number, family?: string) {
  const seed = hash(family ?? "?");
  const horns = seed > 0.55;
  const { body, dark } = look;
  ctx.fillStyle = dark;
  ctx.fillRect(-0.13 * h, -0.3 * h, 0.1 * h, 0.3 * h);
  ctx.fillRect(0.04 * h, -0.3 * h, 0.1 * h, 0.3 * h);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.18 * h, -0.74 * h);
  ctx.lineTo(0.18 * h, -0.74 * h);
  ctx.lineTo(0.15 * h, -0.28 * h);
  ctx.lineTo(-0.15 * h, -0.28 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(body, 0.2);
  ctx.beginPath();
  ctx.arc(0.02 * h, -0.85 * h, 0.1 * h, 0, TAU);
  ctx.fill();
  if (horns) {
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(-0.06 * h, -0.92 * h);
    ctx.lineTo(-0.14 * h, -1.06 * h);
    ctx.lineTo(-0.02 * h, -0.94 * h);
    ctx.moveTo(0.1 * h, -0.92 * h);
    ctx.lineTo(0.18 * h, -1.06 * h);
    ctx.lineTo(0.06 * h, -0.94 * h);
    ctx.fill();
  }
  ctx.fillStyle = "#0a0e15";
  ctx.beginPath();
  ctx.arc(0.06 * h, -0.86 * h, 0.02 * h, 0, TAU);
  ctx.arc(-0.02 * h, -0.87 * h, 0.02 * h, 0, TAU);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Bosses
// ---------------------------------------------------------------------------
//
// Twice the height of anything else and drawn with more mass than detail: at
// this size the reader's eye goes to the outline and the halo, never to a rivet.

/** The Iron Saint: armour, a planted greatsword, and rings of light behind it. */
function spriteIronSaint(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  ctx.strokeStyle = fade(glow, 0.3);
  for (let i = 0; i < 3; i++) {
    ctx.lineWidth = 0.012 * h;
    ctx.beginPath();
    ctx.arc(0, -0.82 * h, (0.2 + i * 0.09) * h + Math.sin(t * 0.0015 + i) * 0.008 * h, 0, TAU);
    ctx.stroke();
  }

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.24 * h, -0.4 * h);
  ctx.lineTo(0.24 * h, -0.4 * h);
  ctx.lineTo(0.3 * h, 0);
  ctx.lineTo(-0.3 * h, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.26 * h, -0.72 * h);
  ctx.lineTo(0.26 * h, -0.72 * h);
  ctx.lineTo(0.2 * h, -0.36 * h);
  ctx.lineTo(-0.2 * h, -0.36 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(body, 0.28);
  ctx.beginPath();
  ctx.ellipse(-0.28 * h, -0.7 * h, 0.14 * h, 0.1 * h, 0, 0, TAU);
  ctx.ellipse(0.28 * h, -0.7 * h, 0.15 * h, 0.11 * h, 0, 0, TAU);
  ctx.fill();

  ctx.fillStyle = shade(body, 0.15);
  roundRect(ctx, -0.11 * h, -0.94 * h, 0.22 * h, 0.22 * h, 0.06 * h);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.fillRect(-0.03 * h, -0.86 * h, 0.13 * h, 0.03 * h);

  // The sword is planted, not swung: this one waits, and counts.
  ctx.fillStyle = "#c3ccd9";
  ctx.beginPath();
  ctx.moveTo(0.3 * h, -0.66 * h);
  ctx.lineTo(0.37 * h, -0.66 * h);
  ctx.lineTo(0.35 * h, 0.02 * h);
  ctx.lineTo(0.32 * h, 0.02 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(body, -0.1);
  ctx.fillRect(0.24 * h, -0.72 * h, 0.2 * h, 0.045 * h);
}

/** The Hollow Choir: three masked faces on one shroud, and rings of sound. */
function spriteHollowChoir(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  const beat = (t * 0.0016) % 1;
  ctx.strokeStyle = fade(glow, 0.35 * (1 - beat));
  ctx.lineWidth = 0.02 * h;
  ctx.beginPath();
  ctx.arc(0, -0.6 * h, (0.3 + beat * 0.5) * h, 0, TAU);
  ctx.stroke();

  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(-0.16 * h, -0.9 * h);
  ctx.lineTo(0.16 * h, -0.9 * h);
  ctx.lineTo(0.34 * h, -0.06 * h);
  ctx.quadraticCurveTo(0, 0.06 * h, -0.34 * h, -0.06 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = fade(body, 0.5);
  ctx.beginPath();
  ctx.moveTo(-0.16 * h, -0.9 * h);
  ctx.lineTo(0.16 * h, -0.9 * h);
  ctx.lineTo(0.2 * h, -0.5 * h);
  ctx.lineTo(-0.2 * h, -0.5 * h);
  ctx.closePath();
  ctx.fill();

  // Three masks, mouths open. The lowest pair are the ones the eye reads as
  // "singing", so they get the wider mouths.
  const masks = [
    [0, -0.96, 0.13],
    [-0.17, -0.72, 0.1],
    [0.17, -0.74, 0.1],
  ];
  for (let i = 0; i < 3; i++) {
    const [mx, my, mr] = masks[i];
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(mx * h, my * h, mr * h, mr * 1.25 * h, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#0a0810";
    ctx.beginPath();
    ctx.ellipse(mx * h, my * h + mr * 0.5 * h, mr * 0.4 * h, mr * (0.4 + 0.2 * Math.sin(t * 0.005 + i)) * h, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc((mx - mr * 0.35) * h, (my - mr * 0.35) * h, mr * 0.16 * h, 0, TAU);
    ctx.arc((mx + mr * 0.35) * h, (my - mr * 0.35) * h, mr * 0.16 * h, 0, TAU);
    ctx.fill();
  }
}

/** The Gate Warden: a door with arms. Wider than tall at the shoulders. */
function spriteGateWarden(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  ctx.fillStyle = dark;
  ctx.fillRect(-0.34 * h, -0.86 * h, 0.68 * h, 0.86 * h);
  ctx.fillStyle = body;
  ctx.fillRect(-0.3 * h, -0.84 * h, 0.6 * h, 0.82 * h);

  ctx.strokeStyle = fade(glow, 0.4 + 0.25 * Math.sin(t * 0.002));
  ctx.lineWidth = 0.022 * h;
  ctx.beginPath();
  ctx.moveTo(0, -0.8 * h);
  ctx.lineTo(0, -0.06 * h);
  ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const y = -0.72 * h + i * 0.18 * h;
    ctx.beginPath();
    ctx.moveTo(-0.1 * h, y);
    ctx.lineTo(0.1 * h, y - 0.05 * h);
    ctx.stroke();
  }

  ctx.fillStyle = shade(body, 0.25);
  ctx.beginPath();
  ctx.moveTo(-0.42 * h, -0.8 * h);
  ctx.lineTo(-0.3 * h, -0.86 * h);
  ctx.lineTo(-0.3 * h, -0.3 * h);
  ctx.lineTo(-0.44 * h, -0.36 * h);
  ctx.closePath();
  ctx.moveTo(0.42 * h, -0.8 * h);
  ctx.lineTo(0.3 * h, -0.86 * h);
  ctx.lineTo(0.3 * h, -0.3 * h);
  ctx.lineTo(0.44 * h, -0.36 * h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shade(body, 0.35);
  roundRect(ctx, -0.13 * h, -1.06 * h, 0.26 * h, 0.24 * h, 0.05 * h);
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.fillRect(-0.09 * h, -0.98 * h, 0.18 * h, 0.032 * h);
}

/** The Ashen Alpha: the beast silhouette again, four times over, and burning. */
function spriteAshenAlpha(ctx: CanvasRenderingContext2D, h: number, look: SpriteLook, t: number) {
  const { body, dark, glow } = look;
  const w = h * 1.6;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 0.11 * h;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-0.3 * w, -0.44 * h);
  ctx.lineTo(-0.33 * w, -0.02 * h);
  ctx.moveTo(-0.15 * w, -0.44 * h);
  ctx.lineTo(-0.11 * w, -0.02 * h);
  ctx.moveTo(0.15 * w, -0.46 * h);
  ctx.lineTo(0.12 * w, -0.02 * h);
  ctx.moveTo(0.3 * w, -0.46 * h);
  ctx.lineTo(0.34 * w, -0.02 * h);
  ctx.stroke();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, -0.6 * h, 0.36 * w, 0.24 * h, -0.05, 0, TAU);
  ctx.fill();

  // The mane is the boss's tell: embers along the spine, brightening on a beat.
  ctx.fillStyle = fade(glow, 0.55 + 0.3 * Math.sin(t * 0.004));
  ctx.beginPath();
  ctx.moveTo(-0.3 * w, -0.72 * h);
  for (let i = 0; i <= 8; i++) {
    const p = i / 8;
    const x = lerp(-0.3 * w, 0.3 * w, p);
    const spike = (i % 2 === 0 ? 0.2 : 0.12) * h * (1 + 0.15 * Math.sin(t * 0.005 + i));
    ctx.lineTo(x, -0.72 * h - spike);
    ctx.lineTo(x + 0.03 * w, -0.7 * h);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = shade(body, 0.12);
  ctx.beginPath();
  ctx.moveTo(0.22 * w, -0.72 * h);
  ctx.lineTo(0.44 * w, -0.84 * h);
  ctx.lineTo(0.6 * w, -0.66 * h);
  ctx.lineTo(0.44 * w, -0.54 * h);
  ctx.lineTo(0.24 * w, -0.46 * h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0.46 * w, -0.72 * h, 0.03 * h, 0, TAU);
  ctx.arc(0.4 * w, -0.62 * h, 0.024 * h, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = body;
  ctx.lineWidth = 0.06 * h;
  ctx.beginPath();
  ctx.moveTo(-0.34 * w, -0.64 * h);
  ctx.quadraticCurveTo(-0.56 * w, -0.8 * h, -0.5 * w, -1.0 * h);
  ctx.stroke();
}

const FAMILY_SPRITE: Record<string, SpriteFn | undefined> = {
  husk: spriteHusk,
  beast: spriteBeast,
  carapace: spriteCarapace,
  warden: spriteWarden,
  shaman: spriteShaman,
  bonewright: spriteBonewright,
  crystal: spriteCrystal,
  wisp: spriteWisp,
  bell: spriteBell,
  void: spriteVoid,
  "saint-attendant": spriteAttendant,
  "iron-saint": spriteIronSaint,
  "hollow-choir": spriteHollowChoir,
  "gate-warden": spriteGateWarden,
  "ashen-alpha": spriteAshenAlpha,
};

/**
 * Status icons: a glyph per kind, drawn in a unit box centred on the origin.
 *
 * Shape carries the meaning and colour only reinforces it, because a status row
 * is six pixels tall on a stream and colour is the first thing a re-encode eats.
 */
function statusGlyph(ctx: CanvasRenderingContext2D, kind: string, s: number) {
  const col = STATUS_COLOUR[kind] ?? "#8291ab";
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.lineCap = "round";
  ctx.beginPath();
  switch (kind) {
    case "burn":
      ctx.moveTo(0, -s * 0.55);
      ctx.quadraticCurveTo(s * 0.45, -s * 0.05, s * 0.18, s * 0.45);
      ctx.quadraticCurveTo(0, s * 0.62, -s * 0.22, s * 0.4);
      ctx.quadraticCurveTo(-s * 0.45, -s * 0.05, 0, -s * 0.55);
      ctx.fill();
      break;
    case "poison":
      ctx.moveTo(0, -s * 0.55);
      ctx.quadraticCurveTo(s * 0.42, s * 0.05, 0, s * 0.5);
      ctx.quadraticCurveTo(-s * 0.42, s * 0.05, 0, -s * 0.55);
      ctx.fill();
      break;
    case "freeze":
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI) / 3;
        ctx.moveTo(-Math.cos(a) * s * 0.5, -Math.sin(a) * s * 0.5);
        ctx.lineTo(Math.cos(a) * s * 0.5, Math.sin(a) * s * 0.5);
      }
      ctx.stroke();
      break;
    case "sleep":
      ctx.moveTo(-s * 0.35, -s * 0.35);
      ctx.lineTo(s * 0.35, -s * 0.35);
      ctx.lineTo(-s * 0.35, s * 0.35);
      ctx.lineTo(s * 0.35, s * 0.35);
      ctx.stroke();
      break;
    case "stun":
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * s * 0.55, Math.sin(a) * s * 0.55);
      }
      ctx.stroke();
      break;
    case "shield":
      ctx.moveTo(0, -s * 0.5);
      ctx.lineTo(s * 0.42, -s * 0.28);
      ctx.lineTo(s * 0.3, s * 0.3);
      ctx.lineTo(0, s * 0.55);
      ctx.lineTo(-s * 0.3, s * 0.3);
      ctx.lineTo(-s * 0.42, -s * 0.28);
      ctx.closePath();
      ctx.fill();
      break;
    case "taunt":
      ctx.moveTo(-s * 0.12, -s * 0.5);
      ctx.lineTo(s * 0.12, -s * 0.5);
      ctx.lineTo(s * 0.06, s * 0.12);
      ctx.lineTo(-s * 0.06, s * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, s * 0.4, s * 0.12, 0, TAU);
      ctx.fill();
      break;
    case "mark":
      ctx.arc(0, 0, s * 0.4, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s * 0.55, 0);
      ctx.lineTo(-s * 0.2, 0);
      ctx.moveTo(s * 0.2, 0);
      ctx.lineTo(s * 0.55, 0);
      ctx.moveTo(0, -s * 0.55);
      ctx.lineTo(0, -s * 0.2);
      ctx.moveTo(0, s * 0.2);
      ctx.lineTo(0, s * 0.55);
      ctx.stroke();
      break;
    case "weaken":
      ctx.moveTo(-s * 0.4, -s * 0.25);
      ctx.lineTo(0, s * 0.35);
      ctx.lineTo(s * 0.4, -s * 0.25);
      ctx.stroke();
      break;
    case "regen":
      ctx.fillRect(-s * 0.12, -s * 0.5, s * 0.24, s);
      ctx.fillRect(-s * 0.5, -s * 0.12, s, s * 0.24);
      break;
    case "antiheal":
      ctx.fillRect(-s * 0.12, -s * 0.5, s * 0.24, s);
      ctx.fillRect(-s * 0.5, -s * 0.12, s, s * 0.24);
      ctx.beginPath();
      ctx.strokeStyle = "#0a0e15";
      ctx.moveTo(-s * 0.5, s * 0.5);
      ctx.lineTo(s * 0.5, -s * 0.5);
      ctx.stroke();
      break;
    case "guard":
      ctx.moveTo(-s * 0.4, s * 0.25);
      ctx.lineTo(0, -s * 0.35);
      ctx.lineTo(s * 0.4, s * 0.25);
      ctx.stroke();
      break;
    default:
      ctx.arc(0, 0, s * 0.35, 0, TAU);
      ctx.fill();
  }
}

/** Bodies for a family this file has never heard of. Picked by name, so stable. */
const FALLBACK_BODIES = ["#7a6a8c", "#6a7f8c", "#8c7a6a", "#6a8c72", "#8c6a72"];

/** Everything a sprite needs to be drawn: two tones, a highlight and a glow. */
function lookForFamily(family: string): SpriteLook {
  const base = FAMILY_LOOK[family];
  if (base) {
    return {
      body: base.body,
      dark: base.dark,
      light: shade(base.body, 0.28),
      glow: base.glow ?? shade(base.body, 0.5),
      h: base.h,
      float: !!base.float,
    };
  }
  const body = FALLBACK_BODIES[Math.floor(hash(family ?? "?") * FALLBACK_BODIES.length) % FALLBACK_BODIES.length];
  return { body, dark: shade(body, -0.5), light: shade(body, 0.28), glow: shade(body, 0.5), h: 0.85, float: false };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Mount the canvas into the panel and return the store's `render`.
 *
 * Everything below closes over one canvas and one set of dimensions rather than
 * being passed them, because every draw call in a frame wants the same six
 * numbers and threading them through forty functions buys nothing.
 */
export function mountStage(host: HTMLElement): Renderer {
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  host.appendChild(canvas);
  const ctx = require2d(canvas.getContext("2d", { alpha: false }));

  // The class colours are defined once, in CSS, and read here rather than
  // duplicated — the stage, the bars and the log all have to agree about who is
  // who, and two copies of a palette drift the first time one is tuned.
  const css = getComputedStyle(host);
  const readVar = (name: string, fallback: string) => {
    const v = css.getPropertyValue(name).trim();
    return v || fallback;
  };
  /** Class ids index the palette alongside the named colours, so a lookup can miss. */
  type PaletteKey =
    | ClassId
    | "ink"
    | "dim"
    | "faint"
    | "flame"
    | "gold"
    | "good"
    | "warn"
    | "bad"
    | "arcane"
    | "panel"
    | "line"
    | "ground";
  const pal: Table<PaletteKey, string> = {
    guardian: readVar("--guardian", "#d8b45a"),
    mage: readVar("--mage", "#7b8ff5"),
    rogue: readVar("--rogue", "#b06fd6"),
    cleric: readVar("--cleric", "#5fb98a"),
    ranger: readVar("--ranger", "#4fb3c4"),
    ink: readVar("--ink", "#e8edf6"),
    dim: readVar("--dim", "#8291ab"),
    faint: readVar("--faint", "#4d5a72"),
    flame: readVar("--flame", "#f0a04b"),
    gold: readVar("--gold", "#d9b45c"),
    good: readVar("--good", "#5fb98a"),
    warn: readVar("--warn", "#e0b040"),
    bad: readVar("--bad", "#d9564f"),
    arcane: readVar("--arcane", "#7b8ff5"),
    panel: readVar("--panel", "#111621"),
    line: readVar("--line", "#232c3d"),
    ground: readVar("--ground", "#0a0d13"),
  };

  // Motion is decoration; state is information. Under reduced motion the shakes,
  // lunges, sparks and flicker all go and every state change still lands.
  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reduce = !!motionQuery?.matches;
  motionQuery?.addEventListener?.("change", (e) => {
    reduce = e.matches;
  });

  // ---- dimensions -------------------------------------------------------

  let W = 0;
  let H = 0;
  let dpr = 1;
  /** The figure scale. Tied to the shorter axis so a wide panel does not make giants. */
  let unit = 1;
  /** Type scale, so a 400px panel and a 1200px one are both readable. */
  let ts = 1;
  let horizon = 0;
  let floorBottom = 0;

  /**
   * The static gradients, `null` until the first {@link resize}.
   *
   * That happens before the first frame, so nothing is ever drawn with a null —
   * and assigning one to `fillStyle` would be a no-op anyway, which is why the
   * guards below are checks rather than fallbacks.
   */
  interface Gradients {
    torch: CanvasGradient | null;
    pool: CanvasGradient | null;
    vignette: CanvasGradient | null;
    edge: CanvasGradient | null;
    edgeFlame: CanvasGradient | null;
    edgeBad: CanvasGradient | null;
  }
  const grads: Gradients = { torch: null, pool: null, vignette: null, edge: null, edgeFlame: null, edgeBad: null };
  const roomCanvas = document.createElement("canvas");
  const roomCtx = require2d(roomCanvas.getContext("2d"));
  let roomKey = "";

  function resize() {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === W && h === H && canvas.width === Math.round(w * dpr)) return;
    W = w;
    H = h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    unit = Math.min(H, W * 0.62);
    ts = clamp(unit / 620, 0.72, 1.5);
    horizon = H * 0.4;
    floorBottom = H * 0.965;
    buildGradients();
    roomKey = "";
    placeEveryone();
  }

  /**
   * Gradients are built on resize, never per frame.
   *
   * Four `createRadialGradient` calls a frame is not a catastrophe, but it is
   * garbage generated sixty times a second for values that only change when the
   * window does. Flicker is applied with `globalAlpha` instead.
   */
  function buildGradients() {
    const torch = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    torch.addColorStop(0, "rgba(240,160,75,0.5)");
    torch.addColorStop(0.35, "rgba(240,160,75,0.16)");
    torch.addColorStop(1, "rgba(240,160,75,0)");
    grads.torch = torch;

    const pool = ctx.createRadialGradient(W / 2, horizon + (floorBottom - horizon) * 0.55, 0, W / 2, horizon + (floorBottom - horizon) * 0.55, Math.max(W, H) * 0.62);
    pool.addColorStop(0, "rgba(255,196,120,0.13)");
    pool.addColorStop(0.5, "rgba(255,170,100,0.045)");
    pool.addColorStop(1, "rgba(0,0,0,0)");
    grads.pool = pool;

    const vig = ctx.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.22, W / 2, H * 0.5, Math.max(W, H) * 0.78);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(0.68, "rgba(0,0,0,0.28)");
    vig.addColorStop(1, "rgba(0,0,0,0.72)");
    grads.vignette = vig;

    // Two rim ramps rather than one white one tinted at paint time: a tinted
    // ramp is a second full-screen pass, and there are exactly two colours the
    // rim is ever allowed to be.
    for (const [key, rgb] of [
      ["edgeFlame", "240,110,60"],
      ["edgeBad", "217,86,79"],
    ] as const) {
      const edge = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
      edge.addColorStop(0, `rgba(${rgb},0)`);
      edge.addColorStop(1, `rgba(${rgb},1)`);
      grads[key] = edge;
    }
  }

  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ---- what we are looking at -------------------------------------------

  let scene: Scene | null = null;
  let facts: Derived | null = null;
  /** Identity of the scene already consumed: the store hands us the same object repeatedly. */
  let lastScene: Scene | null = null;
  /** Tick of the combat beats already animated. */
  let lastBeatsTick: number | null = null;
  let first = true;
  /** How much of `state.said` has been turned into bubbles. */
  let saidSeen = -1;
  let ended = false;
  let endedBecause: string | null = null;

  /** Which half of the room an actor belongs to. */
  type ActorSide = "party" | "enemy";

  /**
   * What the stage reads off a combatant.
   *
   * One shape for both sides rather than a union, because an actor holds
   * whichever of the two the scene gave it and the draw code asks the same
   * questions of both. Every field is optional: half of them exist on only one
   * side, and the `??` at each use is the code already saying so. Both
   * `ScenePartyMember` and `SceneEnemy` satisfy it, which {@link absorbScene}
   * checks by assigning them.
   */
  interface ActorData {
    hp?: number;
    maxHp?: number;
    statuses?: SceneStatus[];
    /** Party only. */
    dead?: boolean;
    mana?: number;
    maxMana?: number;
    readied?: ScenePartyMember["readied"];
    identity?: ScenePartyMember["identity"];
    /** Enemies only. */
    name?: string;
    family?: string;
    elite?: boolean;
    boss?: boolean;
    telegraph?: SceneEnemy["telegraph"];
  }

  /** A combatant on stage: its scene entry, its mark on the floor, and the motion the stage adds. */
  interface Actor {
    id: string;
    side: ActorSide;
    look: SpriteLook;
    /** The desaturated pair {@link lookAt} builds once a body starts falling. */
    looks?: [SpriteLook, SpriteLook];
    data: ActorData | null;
    mx: number;
    md: number;
    px: number;
    py: number;
    ps: number;
    h: number;
    cx: number;
    cy: number;
    shownHp: number;
    flash: number;
    flashColour: string;
    shake: number;
    lunge: number;
    lungeX: number;
    lungeY: number;
    deadAt: number;
    bornAt: number;
    phase: number;
    fresh: boolean;
    seen: boolean;
  }

  /** Actors, by class id or enemy ref. The array mirrors the map for allocation-free iteration. */
  const actors = new Map<string, Actor>();
  const actorList: Actor[] = [];
  /** Reused each frame for back-to-front draw order. */
  const order: Actor[] = [];

  /** A beat names its `from` and `to` only when it has them, and may name something already gone. */
  function actorFor(ref: string | undefined): Actor | undefined {
    return ref === undefined ? undefined : actors.get(ref);
  }

  function makeActor(id: string, side: ActorSide, look: SpriteLook): Actor {
    return {
      id,
      side,
      look,
      data: null,
      /** Room-space mark, and the projected screen position it implies. */
      mx: 0.5,
      md: 0.5,
      px: W / 2,
      py: horizon,
      ps: 1,
      h: 40,
      /** Drawn position, which chases the projected one so a re-layout glides. */
      cx: W / 2,
      cy: horizon,
      /** Health the bar is currently showing, so a hit drains rather than jumps. */
      shownHp: 0,
      flash: 0,
      flashColour: "#ffffff",
      shake: 0,
      lunge: 0,
      lungeX: 0,
      lungeY: 0,
      deadAt: 0,
      bornAt: 0,
      /** Idle bob offset, so five party members do not breathe in unison. */
      phase: Math.random() * TAU,
      /** Snap to the mark on the first placement instead of sliding in from nowhere. */
      fresh: true,
      seen: true,
    };
  }

  function ensureActor(id: string, side: ActorSide, look: SpriteLook): Actor {
    let a = actors.get(id);
    if (!a) {
      a = makeActor(id, side, look);
      a.bornAt = performance.now();
      actors.set(id, a);
      actorList.push(a);
    }
    return a;
  }

  function dropActor(a: Actor) {
    actors.delete(a.id);
    const i = actorList.indexOf(a);
    if (i >= 0) actorList.splice(i, 1);
  }

  // ---- pools ------------------------------------------------------------
  //
  // Every transient — a damage number, a spark, an expanding ring — comes out of
  // a fixed array allocated once. A fight peaks at maybe forty live particles;
  // allocating them per hit would hand the collector a steady drip of garbage
  // during exactly the seconds the frame budget matters most.

  /** The flag the pool itself owns: every item it hands out carries one. */
  interface Poolable {
    on: boolean;
  }

  /** A fixed ring of reusable items. `take()` always returns one — see the steal below. */
  interface Pool<T> {
    items: Array<T & Poolable>;
    take(): T & Poolable;
  }

  function pool<T extends object>(size: number, shape: T): Pool<T> {
    const items: Array<T & Poolable> = new Array(size);
    for (let i = 0; i < size; i++) items[i] = { ...shape, on: false };
    let cursor = 0;
    return {
      items,
      take() {
        for (let i = 0; i < size; i++) {
          const it = items[(cursor + i) % size];
          if (!it.on) {
            cursor = (cursor + i + 1) % size;
            it.on = true;
            return it;
          }
        }
        // Everything is busy: steal the oldest rather than drop the newest, so a
        // burst of thirty beats shows its end instead of its beginning.
        const it = items[cursor];
        cursor = (cursor + 1) % size;
        it.on = true;
        return it;
      },
    };
  }

  /** A damage number or a word, rising off the thing it happened to. */
  interface Floater {
    x: number;
    y: number;
    vy: number;
    text: string;
    colour: string;
    born: number;
    life: number;
    size: number;
    weight: number;
  }

  /** One particle: a chip of a burst, or a mote rising off a heal. */
  interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    born: number;
    life: number;
    colour: string;
    size: number;
    grav: number;
  }

  /** An expanding ellipse — an impact, seen from above. */
  interface Ring {
    x: number;
    y: number;
    r0: number;
    r1: number;
    born: number;
    life: number;
    colour: string;
    width: number;
  }

  /** How a beat crosses the room: in contact, in flight, or not at all. */
  type BeatMode = "self" | "melee" | "shot";

  /** One beat waiting its turn in the window, and the shape it will be played with. */
  interface BeatSlot {
    b: SceneBeat | null;
    start: number;
    dur: number;
    /** Where in `dur` the blow actually lands. */
    impact: number;
    mode: BeatMode;
    fired: boolean;
  }

  const floaters = pool<Floater>(40, {
    x: 0,
    y: 0,
    vy: 0,
    text: "",
    colour: "#fff",
    born: 0,
    life: 1100,
    size: 16,
    weight: 700,
  });
  const sparks = pool<Spark>(220, { x: 0, y: 0, vx: 0, vy: 0, born: 0, life: 600, colour: "#fff", size: 2, grav: 0 });
  const rings = pool<Ring>(18, { x: 0, y: 0, r0: 0, r1: 0, born: 0, life: 600, colour: "#fff", width: 2 });
  const beatSlots = pool<BeatSlot>(36, { b: null, start: 0, dur: 0, impact: 0.4, mode: "self", fired: false });

  /** One thing an agent said, over the head of the class that said it. */
  interface Bubble {
    who: string;
    body: string;
    born: number;
    /** Wrapped lines and the width they were wrapped for; re-wrapped only when the panel changes size. */
    lines: string[] | null;
    wrappedFor: number;
    w: number;
    h: number;
    y: number;
    /** Where the tail points. Worked out fresh each frame from the speaker's sprite. */
    anchorX: number;
    anchorTop: number;
  }

  /** Up to four bubbles: past that they cover the fight they are commenting on. */
  const bubbles: Bubble[] = [];

  // ---- layout -----------------------------------------------------------

  /**
   * Room space to screen.
   *
   * `d` is compressed by a power so the back of the room packs together the way
   * a floor does under perspective, and the horizontal spread and the figure
   * scale both ride the same compressed depth — which is the whole of the fake
   * perspective and enough of it that sprites sit on the floor rather than float
   * over it.
   */
  const proj = { x: 0, y: 0, s: 0 };
  function project(x: number, d: number) {
    const dd = clamp(d, 0, 1) ** 1.25;
    proj.y = horizon + (floorBottom - horizon) * dd;
    proj.s = 0.62 + 0.55 * dd;
    proj.x = W / 2 + (x - 0.5) * W * (0.46 + 0.54 * dd);
    return proj;
  }

  /** Assign every actor its mark, then project. Called on new data and on resize. */
  function placeEveryone() {
    let boss: Actor | null = null;
    let n = 0;
    for (const a of actorList) {
      if (a.side !== "enemy") continue;
      n += 1;
      if (a.data?.boss) boss = a;
    }
    const formation = FORMATIONS[Math.min(n, 6)];
    let slot = 0;
    for (const a of actorList) {
      if (a.side === "party") {
        const mark = PARTY_MARKS[a.id] ?? { x: 0.2, d: 0.5 };
        a.mx = mark.x;
        a.md = mark.d;
      } else if (a === boss) {
        a.mx = BOSS_MARK.x;
        a.md = BOSS_MARK.d;
      } else {
        if (boss) {
          const m = ATTENDANT_MARKS[slot % ATTENDANT_MARKS.length];
          a.mx = m[0];
          a.md = m[1];
        } else if (slot < formation.length) {
          a.mx = formation[slot][0];
          a.md = formation[slot][1];
        } else {
          // More bodies than the hand-placed formations cover. Rare, and a
          // computed rank behind the others beats two sprites in one spot.
          a.mx = 0.66 + 0.22 * ((slot % 3) / 2);
          a.md = 0.9 - 0.2 * Math.floor(slot / 3);
        }
        slot += 1;
      }
      const p = project(a.mx, a.md);
      a.px = p.x;
      a.py = p.y;
      a.ps = p.s;
      a.h = figureHeight(a);
      if (a.fresh) {
        a.cx = a.px;
        a.cy = a.py;
        a.fresh = false;
      }
    }
  }

  function figureHeight(a: Actor) {
    if (a.side === "party") return unit * 0.2 * (CLASS_HEIGHT[a.id] ?? 1) * a.ps;
    const elite = a.data?.elite ? 1.22 : 1;
    return unit * 0.2 * a.look.h * elite * a.ps;
  }

  // ---- ingest -----------------------------------------------------------

  /**
   * Fold a new scene into the actors.
   *
   * Deaths are the only fiddly part. A killed enemy is already gone from
   * `scene.enemies` in the same snapshot whose beats describe killing it, so a
   * renderer that trusted the list would delete the sprite before the blow
   * landed. Anything that vanished is instead scheduled to die partway through
   * the beat sequence, and an explicit `death` beat overrides that with the real
   * moment.
   */
  function absorbScene(next: Scene, now: number) {
    scene = next;
    facts = derive(next);

    for (const a of actorList) a.seen = false;

    for (const p of next.party ?? []) {
      const a = ensureActor(p.id, "party", classLook(p.id));
      a.data = p;
      a.seen = true;
      if (!a.shownHp) a.shownHp = p.hp;
      if (p.dead && !a.deadAt) a.deadAt = first ? now - DEATH_MS : now + BEAT_WINDOW * 0.5;
      if (!p.dead) a.deadAt = 0;
    }

    for (const e of next.enemies ?? []) {
      const a = ensureActor(e.ref, "enemy", lookForFamily(e.family));
      a.data = e;
      a.seen = true;
      a.deadAt = 0;
      if (!a.shownHp) a.shownHp = e.hp;
    }

    for (let i = actorList.length - 1; i >= 0; i--) {
      const a = actorList[i];
      if (a.side !== "enemy" || a.seen) continue;
      // Gone from the roster. Let it fall during the round it died in, then
      // clear it once the husk has had its moment.
      if (!a.deadAt) a.deadAt = now + BEAT_WINDOW * 0.45;
      if (now > a.deadAt + GHOST_MS) dropActor(a);
    }

    placeEveryone();
    if (isNewBeatBatch(lastBeatsTick, next.beatsTick)) {
      lastBeatsTick = next.beatsTick;
      scheduleBeats(next.beats, now);
    }
    first = false;
  }

  function classLook(id: string): SpriteLook {
    const c = pal[id] ?? pal.ink;
    return {
      body: c,
      dark: shade(c, -0.5),
      light: shade(c, 0.26),
      glow: id === "cleric" ? pal.gold : shade(c, 0.45),
      h: 1,
      float: false,
    };
  }

  /**
   * Spread a round's beats across the window and pick how each one moves.
   *
   * A round hands over its whole list at once. Played together they are one
   * unreadable frame, so they are dealt out in order — which also restores the
   * causality the list still carries: the mage's bolt lands before the thing it
   * killed falls over.
   */
  function scheduleBeats(beats: SceneBeat[], now: number) {
    for (const s of beatSlots.items) s.on = false;
    if (!Array.isArray(beats) || beats.length === 0) return;
    const step = clamp(BEAT_WINDOW / beats.length, 90, 380);
    for (let i = 0; i < Math.min(beats.length, beatSlots.items.length); i++) {
      const b = beats[i];
      const s = beatSlots.take();
      s.b = b;
      s.start = now + i * step;
      s.fired = false;
      s.mode = beatMode(b);
      s.dur = b.kind === "mechanic" || b.kind === "death" ? 900 : s.mode === "melee" ? 620 : 560;
      s.impact = s.mode === "melee" ? 0.42 : s.mode === "shot" ? 0.6 : 0.25;
    }
  }

  /**
   * Melee, projectile or neither.
   *
   * Anything with an element that is not physical travels — a firebolt should
   * cross the room — and so does anything thrown by the two classes that fight
   * at range, whose whole identity is not being in contact with the enemy.
   */
  function beatMode(b: SceneBeat): BeatMode {
    if (b.kind !== "hit") return "self";
    const el = b.element ?? "physical";
    if (el !== "physical") return "shot";
    return b.from === "mage" || b.from === "ranger" ? "shot" : "melee";
  }

  /**
   * New speech becomes bubbles; old speech does not.
   *
   * A page opened forty minutes into a run inherits the whole transcript, and
   * replaying it as four hundred bubbles would be both wrong and unwatchable —
   * so the first pass only records how far the store had got.
   */
  function absorbSaid(said: Said[], now: number) {
    if (saidSeen < 0) {
      saidSeen = said.length;
      return;
    }
    for (let i = saidSeen; i < said.length; i++) {
      const entry = said[i];
      const who = matchClass(entry.agent);
      if (!who) continue;
      const body = String(entry.body ?? "").trim();
      if (!body) continue;
      bubbles.push({ who, body, born: now, lines: null, wrappedFor: -1, w: 0, h: 0, y: 0, anchorX: 0, anchorTop: 0 });
      if (bubbles.length > 4) bubbles.shift();
    }
    saidSeen = said.length;
  }

  /** Agents are named for their class, but tolerate a decorated name anyway. */
  function matchClass(agent: string): string | null {
    if (!agent) return null;
    const name = String(agent).toLowerCase();
    if (actors.has(name) && actors.get(name)?.side === "party") return name;
    for (const id of CLASSES) if (name.includes(id)) return id;
    return null;
  }

  // ---- the room ---------------------------------------------------------

  /** A deterministic little generator, so a floor's stonework is the same every frame. */
  function seeded(seed: number) {
    let s = (seed * 2654435761) >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /**
   * Wall, floor and sconces, drawn once into an offscreen canvas.
   *
   * None of it moves, and all of it is a few hundred path operations. Rebuilt
   * only when the panel resizes or the party changes floor — the floor number
   * shifts the stone's tint, which is the cheapest way to make descending feel
   * like going somewhere rather than watching the same room again.
   */
  function buildRoom(floorNo: number) {
    const key = `${W}|${H}|${dpr}|${floorNo}`;
    if (key === roomKey) return;
    roomKey = key;
    roomCanvas.width = Math.round(W * dpr);
    roomCanvas.height = Math.round(H * dpr);
    const c = roomCtx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    // Deeper floors go colder and greener; the surface is brown stone.
    const depth = clamp(floorNo / 50, 0, 1);
    const wallTop = shade(depth > 0.5 ? "#141d24" : "#171a22", -0.15);
    const wallBase = depth > 0.5 ? "#1d2a30" : "#232734";

    const wall = c.createLinearGradient(0, 0, 0, horizon);
    wall.addColorStop(0, "#080b11");
    wall.addColorStop(0.45, wallTop);
    wall.addColorStop(1, wallBase);
    c.fillStyle = wall;
    c.fillRect(0, 0, W, horizon + 1);

    // Courses. Joints are jittered per floor so no two rooms tile identically.
    const rand = seeded(floorNo + 1);
    const course = Math.max(16, H * 0.052);
    c.strokeStyle = "rgba(0,0,0,0.3)";
    c.lineWidth = 1;
    for (let y = horizon - course; y > horizon - H * 0.42; y -= course) {
      c.beginPath();
      c.moveTo(0, Math.round(y) + 0.5);
      c.lineTo(W, Math.round(y) + 0.5);
      c.stroke();
      let x = rand() * course * 2;
      while (x < W) {
        c.beginPath();
        c.moveTo(Math.round(x) + 0.5, Math.round(y) + 0.5);
        c.lineTo(Math.round(x) + 0.5, Math.round(y + course) + 0.5);
        c.stroke();
        x += course * (1.6 + rand() * 1.6);
      }
    }

    const floor = c.createLinearGradient(0, horizon, 0, H);
    floor.addColorStop(0, depth > 0.5 ? "#131b21" : "#1a1c25");
    floor.addColorStop(0.5, "#0f141c");
    floor.addColorStop(1, "#080b11");
    c.fillStyle = floor;
    c.fillRect(0, horizon, W, H - horizon);

    // The skirting is the only hard line in the picture, and it is what makes
    // the floor read as a floor rather than as a darker background.
    c.strokeStyle = "rgba(0,0,0,0.55)";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, horizon + 1);
    c.lineTo(W, horizon + 1);
    c.stroke();

    // Perspective slabs: lines to a vanishing point, bands at widening spacing.
    c.strokeStyle = "rgba(255,255,255,0.035)";
    c.lineWidth = 1;
    for (let i = -6; i <= 6; i++) {
      c.beginPath();
      c.moveTo(W / 2 + i * W * 0.055, horizon);
      c.lineTo(W / 2 + i * W * 0.5, H);
      c.stroke();
    }
    for (let i = 1; i <= 7; i++) {
      const d = (i / 7) ** 1.25;
      const y = horizon + (floorBottom - horizon) * d;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
    }

    // Sconces. Only the brackets are static; the flame is drawn live.
    for (const tx of [W * 0.16, W * 0.84]) {
      const ty = horizon - H * 0.2;
      c.fillStyle = "#2a2f3c";
      c.fillRect(tx - 3, ty, 6, H * 0.075);
      c.beginPath();
      c.moveTo(tx - 11, ty);
      c.lineTo(tx + 11, ty);
      c.lineTo(tx + 6, ty - 9);
      c.lineTo(tx - 6, ty - 9);
      c.closePath();
      c.fill();
    }
  }

  /** Flame and light. The one warm thing in the palette, and the only idle motion. */
  function drawTorches(now: number) {
    for (let i = 0; i < 2; i++) {
      const tx = i === 0 ? W * 0.16 : W * 0.84;
      const ty = horizon - H * 0.2 - 9;
      const flick = reduce ? 1 : 0.86 + 0.14 * (Math.sin(now * 0.011 + i * 2.3) * 0.6 + Math.sin(now * 0.029 + i) * 0.4);

      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(H * 0.55 * flick, H * 0.55 * flick);
      ctx.globalAlpha = 0.9 * flick;
      if (grads.torch) ctx.fillStyle = grads.torch;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
      ctx.globalAlpha = 1;

      const fh = H * 0.05 * flick;
      ctx.fillStyle = "rgba(240,150,60,0.85)";
      ctx.beginPath();
      ctx.moveTo(tx, ty - fh);
      ctx.quadraticCurveTo(tx + fh * 0.42, ty - fh * 0.3, tx + fh * 0.2, ty);
      ctx.lineTo(tx - fh * 0.2, ty);
      ctx.quadraticCurveTo(tx - fh * 0.42, ty - fh * 0.3, tx, ty - fh);
      ctx.fill();
      ctx.fillStyle = "rgba(255,226,150,0.95)";
      ctx.beginPath();
      ctx.ellipse(tx, ty - fh * 0.32, fh * 0.13, fh * 0.28, 0, 0, TAU);
      ctx.fill();
    }
    if (grads.pool) ctx.fillStyle = grads.pool;
    ctx.fillRect(0, horizon - 4, W, H - horizon + 4);
  }

  // ---- the room's furniture, by phase -----------------------------------

  /**
   * What the room holds when nobody is fighting.
   *
   * Three of the five phases have no enemies in them, and a stage that went
   * blank between fights would spend a third of a run looking broken. Each one
   * gets the minimum that says where the party is: doorways at a junction, a
   * stall at a market, a pile after a win.
   */
  function drawFurniture(now: number) {
    const phase = scene?.phase;
    if (phase === "explore") drawJunction(now);
    else if (phase === "market") drawStall(now);
    else if (phase === "spoils") drawSpoils(now);
    else if (phase === "camp") drawCampfire(now);
  }

  /** Kind decides the colour of a doorway, because the label is too long to read. */
  const PATH_COLOUR: Table<"market" | "elite" | "shrine" | "unknown", string> = {
    market: "#d9b45c",
    elite: "#d9564f",
    shrine: "#7b8ff5",
    unknown: "#5c6a82",
  };

  function drawJunction(now: number) {
    const paths = scene?.paths ?? [];
    if (!paths.length) return;
    const n = Math.min(paths.length, 4);
    const aw = Math.min(W * 0.14, 130);
    const ah = Math.min(H * 0.26, 190);
    for (let i = 0; i < n; i++) {
      const p = paths[i];
      const cx = W * (0.34 + (i * 0.44) / Math.max(1, n - 1));
      const base = horizon + 2;
      const chosen = scene?.pendingPath === p.id;
      const col = PATH_COLOUR[p.kind] ?? PATH_COLOUR.unknown;

      ctx.fillStyle = "#05070c";
      ctx.beginPath();
      ctx.moveTo(cx - aw / 2, base);
      ctx.lineTo(cx - aw / 2, base - ah * 0.62);
      ctx.quadraticCurveTo(cx, base - ah * 1.16, cx + aw / 2, base - ah * 0.62);
      ctx.lineTo(cx + aw / 2, base);
      ctx.closePath();
      ctx.fill();

      const pulse = chosen ? 0.5 + 0.35 * Math.sin(now * 0.004) : 0.28;
      ctx.strokeStyle = fade(col, pulse);
      ctx.lineWidth = chosen ? 3 : 1.5;
      ctx.stroke();

      // A wash of the path's colour spilling out of the doorway sells "there is
      // something down there" better than any label at this size.
      ctx.fillStyle = fade(col, chosen ? 0.16 : 0.07);
      ctx.beginPath();
      ctx.moveTo(cx - aw * 0.5, base);
      ctx.lineTo(cx + aw * 0.5, base);
      ctx.lineTo(cx + aw * 1.1, base + ah * 0.55);
      ctx.lineTo(cx - aw * 1.1, base + ah * 0.55);
      ctx.closePath();
      ctx.fill();

      ctx.font = `600 ${Math.round(11 * ts)}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      inkText(ctx, String(p.id ?? "").toUpperCase(), cx, base - ah * 0.66, chosen ? col : pal.dim, 3);
      ctx.font = `${Math.round(10 * ts)}px ${SANS}`;
      inkText(ctx, String(p.kind ?? ""), cx, base - ah * 0.66 + 14 * ts, pal.faint, 3);
    }
  }

  function drawStall(now: number) {
    const bx = W * 0.76;
    const by = horizon + (floorBottom - horizon) * 0.42;
    const w = Math.min(W * 0.3, 340);
    const h = Math.min(H * 0.3, 220);

    ctx.fillStyle = "#2b2118";
    ctx.fillRect(bx - w / 2, by - h * 0.34, w, h * 0.34);
    ctx.fillStyle = "#3a2c1e";
    ctx.fillRect(bx - w / 2, by - h * 0.4, w, h * 0.08);

    // Striped awning, in the palette's one warm colour so the stall reads as the
    // only friendly thing the dungeon offers.
    const stripes = 7;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? "#8c3b34" : "#d8cdb6";
      ctx.beginPath();
      ctx.moveTo(bx - w / 2 + (i * w) / stripes, by - h);
      ctx.lineTo(bx - w / 2 + ((i + 1) * w) / stripes, by - h);
      ctx.lineTo(bx - w / 2 + ((i + 1) * w) / stripes + w * 0.06, by - h * 0.72);
      ctx.lineTo(bx - w / 2 + (i * w) / stripes + w * 0.06, by - h * 0.72);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = "#241a12";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(bx - w / 2 + 6, by - h * 0.72);
    ctx.lineTo(bx - w / 2 + 6, by - h * 0.34);
    ctx.moveTo(bx + w / 2 - 6, by - h * 0.72);
    ctx.lineTo(bx + w / 2 - 6, by - h * 0.34);
    ctx.stroke();

    // The merchant: a hood and two lamp-lit eyes, and nothing else.
    ctx.fillStyle = "#453a52";
    ctx.beginPath();
    ctx.moveTo(bx + w * 0.22, by - h * 0.34);
    ctx.quadraticCurveTo(bx + w * 0.26, by - h * 0.72, bx + w * 0.36, by - h * 0.7);
    ctx.quadraticCurveTo(bx + w * 0.44, by - h * 0.5, bx + w * 0.44, by - h * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = fade(pal.flame, 0.8);
    ctx.beginPath();
    ctx.arc(bx + w * 0.31, by - h * 0.56, 2.5 * ts, 0, TAU);
    ctx.arc(bx + w * 0.37, by - h * 0.56, 2.5 * ts, 0, TAU);
    ctx.fill();

    const stock = scene?.stock ?? [];
    ctx.font = `${Math.round(11 * ts)}px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (let i = 0; i < Math.min(stock.length, 6); i++) {
      const item = stock[i];
      const col = i % 2;
      const row = Math.floor(i / 2);
      const tx = bx - w * 0.46 + col * w * 0.47;
      const ty = by - h * 0.28 + row * 20 * ts + (reduce ? 0 : Math.sin(now * 0.002 + i) * 1.5);
      inkText(ctx, `${item.name}`, tx, ty, pal.dim, 3);
      const wide = ctx.measureText(item.name).width;
      inkText(ctx, `${item.price}g`, tx + wide + 6 * ts, ty, pal.gold, 3);
    }
  }

  function drawSpoils(now: number) {
    const bx = W * 0.72;
    const by = horizon + (floorBottom - horizon) * 0.6;
    const s = Math.min(W * 0.1, 110);

    ctx.fillStyle = "rgba(240,170,80,0.1)";
    ctx.beginPath();
    ctx.ellipse(bx, by, s * 1.9, s * 0.7, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = "#5a4021";
    ctx.fillRect(bx - s * 0.7, by - s * 0.55, s * 1.4, s * 0.55);
    ctx.fillStyle = "#3b2a15";
    ctx.beginPath();
    ctx.moveTo(bx - s * 0.72, by - s * 0.55);
    ctx.quadraticCurveTo(bx, by - s * 1.35, bx + s * 0.72, by - s * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = pal.gold;
    ctx.fillRect(bx - s * 0.72, by - s * 0.6, s * 1.44, s * 0.08);

    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + 0.4;
      ctx.fillStyle = i % 3 ? pal.gold : "#e8d9a8";
      ctx.beginPath();
      ctx.ellipse(bx + Math.cos(a) * s * (1.0 + (i % 3) * 0.32), by + Math.sin(a) * s * 0.34, s * 0.09, s * 0.045, 0, 0, TAU);
      ctx.fill();
    }
    if (!reduce) {
      const tw = (now * 0.0015) % 1;
      ctx.fillStyle = fade("#fff3c4", 1 - tw);
      ctx.beginPath();
      ctx.arc(bx + s * 0.3, by - s * 0.9 - tw * s * 0.5, 2 * ts, 0, TAU);
      ctx.fill();
    }

    const loot = scene?.loot ?? [];
    ctx.font = `${Math.round(11 * ts)}px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < Math.min(loot.length, 4); i++) {
      const bob = reduce ? 0 : Math.sin(now * 0.0022 + i) * 2;
      inkText(ctx, loot[i].name, bx, by - s * 1.6 - i * 17 * ts + bob, pal.gold, 3);
    }
  }

  function drawCampfire(now: number) {
    const bx = W * 0.62;
    const by = horizon + (floorBottom - horizon) * 0.62;
    const s = Math.min(W * 0.05, 54);
    ctx.strokeStyle = "#3b2a18";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(bx - s, by);
    ctx.lineTo(bx + s * 0.6, by - s * 0.5);
    ctx.moveTo(bx + s, by);
    ctx.lineTo(bx - s * 0.6, by - s * 0.5);
    ctx.stroke();
    const f = reduce ? 1 : 0.85 + 0.15 * Math.sin(now * 0.012);
    ctx.fillStyle = "rgba(240,150,60,0.9)";
    ctx.beginPath();
    ctx.moveTo(bx, by - s * 1.5 * f);
    ctx.quadraticCurveTo(bx + s * 0.6, by - s * 0.5, bx + s * 0.3, by - s * 0.1);
    ctx.lineTo(bx - s * 0.3, by - s * 0.1);
    ctx.quadraticCurveTo(bx - s * 0.6, by - s * 0.5, bx, by - s * 1.5 * f);
    ctx.fill();
    ctx.save();
    ctx.translate(bx, by - s * 0.4);
    ctx.scale(s * 6 * f, s * 6 * f);
    ctx.globalAlpha = 0.8;
    if (grads.torch) ctx.fillStyle = grads.torch;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ---- transient effects -------------------------------------------------

  function anchorX(a: Actor) {
    return a.cx;
  }
  function anchorY(a: Actor) {
    return a.cy - a.h * 0.58;
  }
  /** Where a beat should appear when its subject is no longer on the roster. */
  function ghostX(ref: string | undefined) {
    return ref !== undefined && CLASSES.includes(ref) ? W * 0.24 : W * 0.76;
  }
  function ghostY() {
    return horizon + (floorBottom - horizon) * 0.5;
  }

  function floater(text: string, x: number, y: number, colour: string, size: number) {
    const f = floaters.take();
    f.text = text;
    f.x = x;
    f.y = y;
    f.colour = colour;
    f.size = size;
    f.born = performance.now();
    f.life = 1150;
    f.vy = -0.045 * size;
    return f;
  }

  function burst(x: number, y: number, colour: string, n: number) {
    if (reduce) return;
    for (let i = 0; i < n; i++) {
      const p = sparks.take();
      const a = Math.random() * TAU;
      const v = 0.06 + Math.random() * 0.16;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v - 0.05;
      p.born = performance.now();
      p.life = 340 + Math.random() * 320;
      p.colour = colour;
      p.size = (1.4 + Math.random() * 2.2) * ts;
      p.grav = 0.00035;
    }
  }

  function ring(x: number, y: number, r0: number, r1: number, colour: string, life: number, width: number) {
    const r = rings.take();
    r.x = x;
    r.y = y;
    r.r0 = r0;
    r.r1 = r1;
    r.colour = colour;
    r.born = performance.now();
    r.life = life;
    r.width = width;
  }

  /**
   * One beat, at the instant it lands.
   *
   * Everything here is a consequence rather than a cause: the simulation already
   * applied the damage, and this only decides how it looks. That is the property
   * that lets the stage be as loud as it likes — see docs/broadcast-viewer.md.
   */
  function fire(b: SceneBeat, now: number) {
    const to = actorFor(b.to);
    const from = actorFor(b.from);
    const tx = to ? anchorX(to) : ghostX(b.to);
    const tyy = to ? anchorY(to) : ghostY();
    const fx = from ? anchorX(from) : ghostX(b.from);
    const fy = from ? anchorY(from) : ghostY();

    switch (b.kind) {
      case "hit": {
        // An element the beat left out, or one this file has no colour for, is
        // physical — which is what the empty key falls through to.
        const colour = ELEMENT_COLOUR[b.element ?? ""] ?? ELEMENT_COLOUR.physical;
        if (to) {
          to.flash = 1;
          to.flashColour = colour;
          to.shake = 1;
        }
        const maxHp = Math.max(1, to?.data?.maxHp ?? 100);
        const bite = clamp((b.amount ?? 0) / maxHp, 0, 1);
        floater(String(b.amount ?? "—"), tx, tyy, colour, (15 + 26 * Math.min(1, bite * 2.4)) * ts);
        burst(tx, tyy, colour, 6 + Math.round(bite * 14));
        ring(tx, tyy, 4 * ts, (26 + bite * 60) * ts, colour, 380, 2.5 * ts);
        break;
      }
      case "heal": {
        if (to) {
          to.flash = 0.7;
          to.flashColour = HEAL_COLOUR;
        }
        floater(`+${b.amount ?? ""}`, tx, tyy, HEAL_COLOUR, 20 * ts);
        ring(tx, tyy + (to ? to.h * 0.3 : 0), 6 * ts, 34 * ts, HEAL_COLOUR, 620, 2 * ts);
        // Motes rising rather than a burst: a heal should not look like a hit.
        if (!reduce) {
          for (let i = 0; i < 8; i++) {
            const p = sparks.take();
            p.x = tx + (Math.random() - 0.5) * (to ? to.h * 0.5 : 30);
            p.y = tyy + (Math.random() - 0.2) * (to ? to.h * 0.45 : 30);
            p.vx = (Math.random() - 0.5) * 0.02;
            p.vy = -0.05 - Math.random() * 0.05;
            p.born = now;
            p.life = 700 + Math.random() * 300;
            p.colour = HEAL_COLOUR;
            p.size = 2 * ts;
            p.grav = 0;
          }
        }
        break;
      }
      case "shield": {
        if (to) {
          to.flash = 0.6;
          to.flashColour = SHIELD_COLOUR;
        }
        floater(b.amount ? `shield ${b.amount}` : "shield", tx, tyy, SHIELD_COLOUR, 15 * ts);
        ring(tx, tyy, (to ? to.h * 0.3 : 20), (to ? to.h * 0.62 : 46), SHIELD_COLOUR, 700, 3 * ts);
        break;
      }
      case "guard": {
        if (to) {
          to.flash = 0.5;
          to.flashColour = STATUS_COLOUR.guard;
        }
        floater("guard", tx, tyy, STATUS_COLOUR.guard, 14 * ts);
        ring(tx, tyy, 8 * ts, 30 * ts, STATUS_COLOUR.guard, 500, 2 * ts);
        break;
      }
      case "status": {
        const colour = STATUS_COLOUR[b.note ?? ""] ?? pal.arcane;
        if (to) {
          to.flash = 0.55;
          to.flashColour = colour;
        }
        floater(String(b.note ?? "status"), tx, tyy, colour, 14 * ts);
        break;
      }
      case "wasted": {
        floater(String(b.note ?? "wasted"), fx, fy, WASTED_COLOUR, 13 * ts);
        break;
      }
      case "death": {
        if (to) to.deadAt = now;
        burst(tx, tyy, "#6d6154", 16);
        break;
      }
      case "spawn": {
        ring(tx, ghostY(), 6 * ts, 50 * ts, pal.arcane, 700, 2 * ts);
        break;
      }
      case "mechanic": {
        // A hidden rule firing is the most expensive thing that can happen to a
        // party that never wrote anything down, so it gets the loudest beat that
        // is not a boss telegraph.
        const colour = ELEMENT_COLOUR[b.element ?? ""] ?? pal.flame;
        ring(fx, fy, 10 * ts, 120 * ts, colour, 900, 3.5 * ts);
        ring(fx, fy, 10 * ts, 76 * ts, pal.flame, 700, 2 * ts);
        floater(String(b.note ?? "mechanic"), fx, fy - 22 * ts, pal.flame, 17 * ts);
        if (b.amount && to) {
          to.flash = 1;
          to.flashColour = colour;
          to.shake = 1;
          floater(String(b.amount), tx, tyy, colour, 24 * ts);
        }
        burst(fx, fy, colour, 14);
        break;
      }
    }
  }

  // ---- per-frame advance -------------------------------------------------

  function step(dt: number, now: number) {
    for (let i = actorList.length - 1; i >= 0; i--) {
      const a = actorList[i];
      // Positions are chased rather than set, so a formation changing under a
      // death slides instead of teleporting.
      const k = Math.min(1, dt * 7);
      a.cx += (a.px - a.cx) * k;
      a.cy += (a.py - a.cy) * k;
      a.flash = Math.max(0, a.flash - dt * 3);
      a.shake = Math.max(0, a.shake - dt * 3.4);
      a.lunge = 0;
      const hp = a.data?.hp ?? 0;
      a.shownHp += (hp - a.shownHp) * Math.min(1, dt * 5);
      if (Math.abs(a.shownHp - hp) < 0.5) a.shownHp = hp;
      if (a.side === "enemy" && a.deadAt && now > a.deadAt + GHOST_MS) dropActor(a);
    }

    for (const s of beatSlots.items) {
      if (!s.on || now < s.start) continue;
      // A slot that is on always carries its beat; the check is what lets the
      // rest of the loop say so without asking again.
      const b = s.b;
      if (!b) continue;
      const p = (now - s.start) / s.dur;
      if (p >= 1) {
        s.on = false;
        continue;
      }
      if (!s.fired && p >= s.impact) {
        s.fired = true;
        fire(b, now);
      }
      if (s.mode === "melee" && !reduce) {
        const from = actorFor(b.from);
        const to = actorFor(b.to);
        if (from && to) {
          // Out fast, back slow: the shape of a swing rather than of a slide.
          from.lunge = p < s.impact ? easeOut(p / s.impact) : 1 - (p - s.impact) / (1 - s.impact);
          from.lungeX = to.cx;
          from.lungeY = to.cy;
        }
      }
    }
  }

  // ---- drawing -----------------------------------------------------------

  /** Sprite lookup, with the family fallback that keeps a new bestiary entry visible. */
  function spriteFor(a: Actor): SpriteFn {
    if (a.side === "party") return CLASS_SPRITE[a.id] ?? spriteUnknown;
    // An enemy with no family named, like one with a family this file has never
    // heard of, misses the table and gets the derived silhouette.
    return FAMILY_SPRITE[a.data?.family ?? ""] ?? spriteUnknown;
  }

  /** Wider bodies need wider shadows, or they look like they are hovering. */
  const SHADOW_RX: Record<string, number | undefined> = { beast: 0.62, carapace: 0.58, "ashen-alpha": 0.7, "gate-warden": 0.5, bell: 0.42, "iron-saint": 0.42, "hollow-choir": 0.38 };

  /** The tones a body is desaturated through. `h` and `float` are carried over untouched. */
  const TONES = ["body", "dark", "light", "glow"] as const;

  /** Dying desaturates in three steps; a continuous tint would mean re-tinting every fill. */
  function lookAt(a: Actor, dying: number): SpriteLook {
    if (dying < 0.3) return a.look;
    if (!a.looks) {
      const mid: SpriteLook = { body: "", dark: "", light: "", glow: "", h: a.look.h };
      const husk: SpriteLook = { body: "", dark: "", light: "", glow: "", h: a.look.h };
      for (const key of TONES) {
        const n = Number.parseInt((a.look[key] ?? "#888888").slice(1), 16);
        const r = (n >> 16) & 255;
        const g = (n >> 8) & 255;
        const b = n & 255;
        const grey = Math.round(r * 0.3 + g * 0.5 + b * 0.2);
        mid[key] = `rgb(${Math.round(lerp(r, grey, 0.6))},${Math.round(lerp(g, grey, 0.6))},${Math.round(lerp(b, grey, 0.6))})`;
        husk[key] = `rgb(${Math.round(grey * 0.42)},${Math.round(grey * 0.44)},${Math.round(grey * 0.5)})`;
      }
      a.looks = [mid, husk];
    }
    return dying < 0.7 ? a.looks[0] : a.looks[1];
  }

  /** All four tones set to one colour, drawn additively: a silhouette-perfect flash. */
  const flashLooks = new Map<string, SpriteLook>();
  function flashLook(colour: string): SpriteLook {
    let l = flashLooks.get(colour);
    if (!l) {
      l = { body: colour, dark: colour, light: colour, glow: colour, h: 1, float: false };
      flashLooks.set(colour, l);
    }
    return l;
  }

  function drawActor(a: Actor, now: number) {
    const dying = a.deadAt && now >= a.deadAt ? clamp((now - a.deadAt) / DEATH_MS, 0, 1) : 0;
    let x = a.cx;
    let y = a.cy;
    if (a.lunge > 0) {
      x += (a.lungeX - a.cx) * 0.28 * a.lunge;
      y += (a.lungeY - a.cy) * 0.28 * a.lunge;
    }
    if (a.shake > 0 && !reduce) x += Math.sin(now * 0.075) * 5 * ts * a.shake;

    const h = a.h;
    const family = a.data?.family;

    // A telegraph goes under the feet so it cannot be mistaken for damage.
    if (a.data?.telegraph && !dying) drawTelegraphRing(x, y, h, now);

    const rx = h * (SHADOW_RX[family ?? ""] ?? 0.3);
    ctx.fillStyle = `rgba(0,0,0,${(a.look.float ? 0.18 : 0.36) * (1 - dying * 0.6)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, rx * 0.3, 0, 0, TAU);
    ctx.fill();

    const sprite = spriteFor(a);
    ctx.save();
    ctx.translate(x, y);
    if (a.side === "enemy") ctx.scale(-1, 1);
    if (!reduce && !dying) ctx.translate(0, Math.sin(now * 0.0016 + a.phase) * h * 0.012);
    if (dying) {
      // Slumping is a vertical squash plus a lean: enough to read as fallen at a
      // glance without needing a second, prone sprite for nineteen families.
      ctx.translate(0, h * 0.04 * dying);
      ctx.rotate(-0.22 * dying);
      ctx.scale(1, 1 - 0.32 * dying);
    }
    // Arrivals fade in. Reinforcements land mid-fight when dread is high, and a
    // sprite that simply exists on the next frame reads as a rendering glitch.
    ctx.globalAlpha = (1 - 0.55 * dying) * clamp((now - a.bornAt) / 380, 0, 1);
    sprite(ctx, h, lookAt(a, dying), now, family);
    if (a.flash > 0.02 && !dying) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = a.flash * 0.5;
      sprite(ctx, h, flashLook(a.flashColour), now, family);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Elites wear a ring of embers. A name would be more precise and would also
    // need reading; a halo is understood before the eye has stopped moving.
    if (a.data?.elite && !dying) {
      ctx.strokeStyle = fade(pal.flame, 0.35 + 0.2 * Math.sin(now * 0.003));
      ctx.lineWidth = 1.5 * ts;
      ctx.beginPath();
      ctx.ellipse(x, y, rx * 1.25, rx * 0.4, 0, 0, TAU);
      ctx.stroke();
    }

    drawVitals(a, x, y, dying, now);
  }

  /**
   * Health, mana and statuses, under every combatant.
   *
   * Under, rather than over, because the sprite is the thing being watched and a
   * bar above the head competes with the speech bubbles for the same band. The
   * bar drains behind the fill so the size of a hit is visible for a moment
   * after the number has gone.
   */
  function drawVitals(a: Actor, x: number, y: number, dying: number, now: number) {
    const d = a.data;
    if (!d) return;
    const boss = !!d.boss;
    const bw = boss ? clamp(a.h * 0.4, 110, 280) : clamp(a.h * 0.66, 34, 150);
    const bh = boss ? 9 * ts : 5 * ts;
    const bx = x - bw / 2;
    const by = y + 9 * ts;

    if (a.side === "party" && d.dead) {
      ctx.font = `700 ${Math.round(11 * ts)}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      inkText(ctx, "DOWN", x, by + bh, pal.bad, 3);
      return;
    }
    if (dying > 0.5) return;

    if (a.side === "party") {
      ctx.font = `700 ${Math.round(9 * ts)}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      inkText(ctx, String(d.identity?.displayName ?? a.id), x, by - 4 * ts, pal.ink, 3);
    }

    if (boss) {
      ctx.font = `700 ${Math.round(12 * ts)}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      inkText(ctx, String(d.name ?? "").toUpperCase(), x, by - 6 * ts, pal.gold, 3.5);
    }

    const maxHp = Math.max(1, d.maxHp ?? 1);
    const frac = clamp((d.hp ?? 0) / maxHp, 0, 1);
    const shown = clamp(a.shownHp / maxHp, 0, 1);

    ctx.fillStyle = "rgba(6,9,14,0.85)";
    roundRect(ctx, bx - 1, by - 1, bw + 2, bh + 2, (bh + 2) / 2);
    ctx.fill();
    if (shown > frac) {
      ctx.fillStyle = "rgba(217,86,79,0.45)";
      roundRect(ctx, bx, by, bw * shown, bh, bh / 2);
      ctx.fill();
    }
    ctx.fillStyle = frac > 0.5 ? pal.good : frac > 0.25 ? pal.warn : pal.bad;
    roundRect(ctx, bx, by, Math.max(2, bw * frac), bh, bh / 2);
    ctx.fill();

    let below = by + bh + 2 * ts;
    if (a.side === "party" && (d.maxMana ?? 0) > 0) {
      const mf = clamp((d.mana ?? 0) / Math.max(1, d.maxMana ?? 0), 0, 1);
      ctx.fillStyle = "rgba(6,9,14,0.8)";
      roundRect(ctx, bx, below, bw, 3 * ts, 1.5 * ts);
      ctx.fill();
      ctx.fillStyle = pal.arcane;
      roundRect(ctx, bx, below, Math.max(1, bw * mf), 3 * ts, 1.5 * ts);
      ctx.fill();
      below += 5 * ts;
    }

    const statuses = d.statuses ?? [];
    if (statuses.length) {
      const gs = 11 * ts;
      const count = Math.min(statuses.length, 6);
      let sx = x - ((count - 1) * (gs + 3 * ts)) / 2;
      for (let i = 0; i < count; i++) {
        ctx.save();
        ctx.translate(sx, below + gs * 0.55);
        statusGlyph(ctx, statuses[i].kind, gs * 0.5);
        ctx.restore();
        sx += gs + 3 * ts;
      }
    }
  }

  /**
   * The floor ring under something that is winding up.
   *
   * Requirement zero of the whole page: when a boss is counting, the viewer has
   * to feel it. The ring expands on a fixed period rather than with the beat
   * queue, because a telegraph persists across turns and should keep pulsing
   * while the party decides what to do about it.
   */
  function drawTelegraphRing(x: number, y: number, h: number, now: number) {
    const p = (now % 1100) / 1100;
    ctx.strokeStyle = fade(pal.bad, (1 - p) * 0.85);
    ctx.lineWidth = 3 * ts;
    ctx.beginPath();
    ctx.ellipse(x, y, h * (0.3 + p * 0.55), h * (0.1 + p * 0.19), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = fade(pal.bad, 0.3);
    ctx.lineWidth = 1.5 * ts;
    ctx.beginPath();
    ctx.ellipse(x, y, h * 0.85, h * 0.29, 0, 0, TAU);
    ctx.stroke();
  }

  /** The words, over everything, with an aim line at whoever is about to get it. */
  function drawTelegraphs(now: number) {
    for (const a of actorList) {
      const text = a.data?.telegraph;
      if (!text || (a.deadAt && now >= a.deadAt)) continue;
      const x = a.cx;
      const y = Math.max(20 * ts, a.cy - a.h - 30 * ts);

      ctx.strokeStyle = fade(pal.bad, 0.16 + 0.1 * Math.sin(now * 0.006));
      ctx.lineWidth = 1.5 * ts;
      ctx.setLineDash([6 * ts, 6 * ts]);
      ctx.beginPath();
      ctx.moveTo(a.cx, a.cy - a.h * 0.5);
      ctx.lineTo(W * 0.24, horizon + (floorBottom - horizon) * 0.55);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = `700 ${Math.round(14 * ts)}px ${SANS}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const label = String(text).toUpperCase();
      const tw = ctx.measureText(label).width;
      const padX = 12 * ts;
      const iconW = 20 * ts;
      const boxW = tw + padX * 2 + iconW;
      const boxH = 26 * ts;
      const boxX = clamp(x - boxW / 2, 6, W - boxW - 6);

      const pulse = 0.55 + 0.45 * Math.sin(now * 0.007);
      ctx.fillStyle = "rgba(20,8,8,0.9)";
      roundRect(ctx, boxX, y - boxH / 2, boxW, boxH, 5 * ts);
      ctx.fill();
      ctx.strokeStyle = fade(pal.bad, 0.5 + 0.4 * pulse);
      ctx.lineWidth = 2 * ts;
      ctx.stroke();

      ctx.fillStyle = pal.bad;
      ctx.beginPath();
      ctx.moveTo(boxX + padX * 0.7 + iconW * 0.35, y - 8 * ts);
      ctx.lineTo(boxX + padX * 0.7 + iconW * 0.75, y + 7 * ts);
      ctx.lineTo(boxX + padX * 0.7 - iconW * 0.05, y + 7 * ts);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#1a0a0a";
      ctx.fillRect(boxX + padX * 0.7 + iconW * 0.3, y - 3 * ts, 2 * ts, 6 * ts);

      inkText(ctx, label, boxX + padX + iconW, y, "#ffd9d3", 3);
    }
  }

  /** Who has readied what, drawn only in the quiet between rounds. */
  function drawIntents() {
    for (const s of beatSlots.items) if (s.on) return;
    for (const a of actorList) {
      const r = a.side === "party" ? a.data?.readied : null;
      if (!r) continue;
      const target = r.target ? actorFor(r.target) : null;
      const colour = pal[a.id] ?? pal.dim;
      if (target && target !== a) {
        ctx.strokeStyle = fade(colour, 0.22);
        ctx.lineWidth = 1.2 * ts;
        ctx.setLineDash([3 * ts, 5 * ts]);
        ctx.beginPath();
        ctx.moveTo(a.cx, a.cy - a.h * 0.5);
        ctx.lineTo(target.cx, target.cy - target.h * 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.font = `600 ${Math.round(10 * ts)}px ${SANS}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      inkText(ctx, String(r.kind ?? "").replace(/_/g, " "), a.cx, a.cy - a.h - 8 * ts, fade(colour, 0.85), 3);
    }
  }

  /** Anything in flight, drawn from the beat that owns it rather than from a pool. */
  function drawProjectiles(now: number) {
    for (const s of beatSlots.items) {
      if (!s.on || s.mode !== "shot" || now < s.start) continue;
      // As in `step`: a live slot has its beat, and this is where the type learns it.
      const b = s.b;
      if (!b) continue;
      const p = (now - s.start) / s.dur;
      if (p >= s.impact) continue;
      const from = actorFor(b.from);
      const to = actorFor(b.to);
      const x0 = from ? anchorX(from) : ghostX(b.from);
      const y0 = from ? anchorY(from) : ghostY();
      const x1 = to ? anchorX(to) : ghostX(b.to);
      const y1 = to ? anchorY(to) : ghostY();
      const t = reduce ? 1 : clamp(p / s.impact, 0, 1);
      const x = lerp(x0, x1, t);
      // A shallow arc, because a dead-straight line between two sprites reads as
      // a drawn rule rather than as something thrown.
      const y = lerp(y0, y1, t) - arch(t) * Math.min(70, Math.abs(x1 - x0) * 0.12);
      const colour = ELEMENT_COLOUR[b.element ?? ""] ?? ELEMENT_COLOUR.physical;

      if (b.element === "physical") {
        const a = Math.atan2(y1 - y0, x1 - x0);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2 * ts;
        ctx.beginPath();
        ctx.moveTo(-16 * ts, 0);
        ctx.lineTo(6 * ts, 0);
        ctx.stroke();
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(10 * ts, 0);
        ctx.lineTo(2 * ts, -3 * ts);
        ctx.lineTo(2 * ts, 3 * ts);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = fade(colour, 0.22);
        ctx.beginPath();
        ctx.arc(x, y, 14 * ts, 0, TAU);
        ctx.fill();
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(x, y, 5 * ts, 0, TAU);
        ctx.fill();
        if (!reduce && Math.random() < 0.7) {
          const q = sparks.take();
          q.x = x;
          q.y = y;
          q.vx = (Math.random() - 0.5) * 0.03;
          q.vy = (Math.random() - 0.5) * 0.03;
          q.born = now;
          q.life = 280;
          q.colour = colour;
          q.size = 2 * ts;
          q.grav = 0;
        }
      }
    }
  }

  function drawRings(now: number) {
    for (const r of rings.items) {
      if (!r.on) continue;
      const p = (now - r.born) / r.life;
      if (p >= 1) {
        r.on = false;
        continue;
      }
      ctx.strokeStyle = fade(r.colour, (1 - p) * 0.8);
      ctx.lineWidth = r.width * (1 - p * 0.5);
      ctx.beginPath();
      const rad = lerp(r.r0, r.r1, easeOut(p));
      ctx.ellipse(r.x, r.y, rad, rad * 0.62, 0, 0, TAU);
      ctx.stroke();
    }
  }

  function drawSparks(now: number) {
    for (const s of sparks.items) {
      if (!s.on) continue;
      const age = now - s.born;
      if (age >= s.life) {
        s.on = false;
        continue;
      }
      const p = age / s.life;
      s.x += s.vx * 16;
      s.y += s.vy * 16;
      s.vy += s.grav * 16;
      ctx.fillStyle = fade(s.colour, 1 - p);
      ctx.fillRect(s.x, s.y, s.size, s.size);
    }
  }

  function drawFloaters(now: number) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const f of floaters.items) {
      if (!f.on) continue;
      const p = (now - f.born) / f.life;
      if (p >= 1) {
        f.on = false;
        continue;
      }
      const rise = reduce ? 12 * ts : easeOut(p) * f.size * 2.2;
      ctx.globalAlpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
      ctx.font = `700 ${Math.round(f.size)}px ${MONO}`;
      inkText(ctx, f.text, f.x, f.y - rise, f.colour, Math.max(3, f.size * 0.22));
      ctx.globalAlpha = 1;
    }
  }

  // ---- speech ------------------------------------------------------------

  /**
   * Wrap to a pixel width, and stop at three lines.
   *
   * Agents write paragraphs; a bubble that honoured one would cover the fight it
   * is about. Three lines is the most that can sit over a sprite without
   * reaching the panel edge, and the rest goes to the chat column, which exists
   * precisely so the stage does not have to carry the whole sentence.
   */
  function wrap(text: string, maxWidth: number, maxLines: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    let used = 0;
    for (let i = 0; i < words.length; i++) {
      const candidate = line ? `${line} ${words[i]}` : words[i];
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
        used = i + 1;
        continue;
      }
      lines.push(line);
      // `used` counts words that reached a line, not words consumed. If this
      // push is the one that fills `maxLines`, `words[i]` never gets pushed —
      // so counting it here made a message that overflows by exactly one word
      // report `used === words.length` and lose that word with no ellipsis.
      if (lines.length === maxLines) {
        used = i;
        break;
      }
      line = words[i];
      used = i + 1;
    }
    if (lines.length < maxLines && line) lines.push(line);
    // Ellipsise only when words were actually dropped — counting words rather
    // than characters, because the split normalises whitespace and a
    // length comparison then reports a truncation that never happened.
    if (lines.length === maxLines && used < words.length) {
      let last = lines[maxLines - 1];
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last}…`;
    }
    return lines;
  }

  /**
   * Bubbles over the party, staggered so two speakers never overlap.
   *
   * Placement is a single pass in age order: each bubble starts above its own
   * sprite and is pushed up until it clears everything already placed. Newer
   * speech therefore rises above older speech, which is also the reading order.
   */
  function drawBubbles(now: number) {
    const pad = 9 * ts;
    const lineH = 16 * ts;
    const maxW = Math.min(300 * ts, W * 0.34);
    const font = `${Math.round(13 * ts)}px ${SANS}`;

    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (now - bubbles[i].born > BUBBLE_MS) bubbles.splice(i, 1);
    }
    if (!bubbles.length) return;

    ctx.font = font;
    ctx.textBaseline = "middle";
    for (const b of bubbles) {
      if (b.wrappedFor !== maxW) {
        b.lines = wrap(b.body, maxW - pad * 2, 3);
        b.wrappedFor = maxW;
        let widest = 0;
        for (const line of b.lines) widest = Math.max(widest, ctx.measureText(line).width);
        b.w = widest + pad * 2;
        b.h = b.lines.length * lineH + pad * 1.6;
      }
      const a = actorFor(b.who);
      b.anchorX = a ? a.cx : W * 0.2;
      // Clear of the sprite's head *and* of the readied-action label that sits
      // just above it, with room for the tail underneath.
      b.anchorTop = a ? a.cy - a.h - 32 * ts : horizon;
      b.y = b.anchorTop - b.h;
    }

    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      for (let j = 0; j < i; j++) {
        const o = bubbles[j];
        const overlapX = Math.abs(b.anchorX - o.anchorX) < (b.w + o.w) / 2 + 8;
        if (!overlapX) continue;
        if (b.y + b.h > o.y - 6 * ts && b.y < o.y + o.h) b.y = o.y - b.h - 8 * ts;
      }
      b.y = Math.max(6 * ts, b.y);
    }

    for (const b of bubbles) {
      const age = now - b.born;
      const appear = clamp(age / 180, 0, 1);
      const leave = clamp((BUBBLE_MS - age) / 400, 0, 1);
      ctx.globalAlpha = Math.min(appear, leave);
      const x = clamp(b.anchorX - b.w / 2, 6, Math.max(6, W - b.w - 6));
      const y = b.y + (reduce ? 0 : (1 - appear) * 8);
      const colour = pal[b.who] ?? pal.ink;

      ctx.fillStyle = "rgba(14,19,28,0.94)";
      roundRect(ctx, x, y, b.w, b.h, 8 * ts);
      ctx.fill();
      ctx.strokeStyle = fade(colour, 0.55);
      ctx.lineWidth = 1.5 * ts;
      ctx.stroke();

      // The tail leans toward the speaker, so a bubble pushed sideways by the
      // panel edge still says who it belongs to.
      const tailX = clamp(b.anchorX, x + 14 * ts, x + b.w - 14 * ts);
      ctx.fillStyle = "rgba(14,19,28,0.94)";
      ctx.beginPath();
      ctx.moveTo(tailX - 7 * ts, y + b.h - 1);
      ctx.lineTo(tailX + 7 * ts, y + b.h - 1);
      ctx.lineTo(clamp(b.anchorX, x, x + b.w), y + b.h + 11 * ts);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = fade(colour, 0.55);
      ctx.beginPath();
      ctx.moveTo(tailX - 7 * ts, y + b.h - 1);
      ctx.lineTo(clamp(b.anchorX, x, x + b.w), y + b.h + 11 * ts);
      ctx.lineTo(tailX + 7 * ts, y + b.h - 1);
      ctx.stroke();

      ctx.fillStyle = colour;
      roundRect(ctx, x + 4 * ts, y + 7 * ts, 2.5 * ts, b.h - 14 * ts, 1.5 * ts);
      ctx.fill();

      ctx.font = font;
      ctx.fillStyle = pal.ink;
      ctx.textAlign = "left";
      // Wrapped in the pass above, for every bubble in the list; the fallback is
      // what says so rather than a claim that it cannot be missing.
      const lines = b.lines ?? [];
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x + pad, y + pad * 0.8 + lineH * (i + 0.5));
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---- frame -------------------------------------------------------------

  /** Before the first `state` event there is a room and nobody in it. */
  function drawIdle(now: number) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(15 * ts)}px ${SANS}`;
    const breath = reduce ? 0.7 : 0.45 + 0.3 * Math.sin(now * 0.0018);
    ctx.globalAlpha = breath;
    inkText(ctx, "waiting for the descent", W / 2, horizon + (floorBottom - horizon) * 0.42, pal.dim, 4);
    ctx.globalAlpha = 1;
    ctx.font = `${Math.round(11 * ts)}px ${MONO}`;
    inkText(ctx, ended ? "the run is over" : "no round has been played yet", W / 2, horizon + (floorBottom - horizon) * 0.42 + 22 * ts, pal.faint, 4);
  }

  /**
   * The stage says where it is; the header says how the run is going.
   *
   * Deliberately duplicated with the page header, in the corner and small: a
   * capture cropped to the stage is a thing people do, and a picture of a fight
   * with no floor number on it is much less useful than one with.
   */
  function drawCaption() {
    if (!scene) return;
    ctx.font = `600 ${Math.round(10 * ts)}px ${SANS}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.letterSpacing = "0.16em";
    const bits = `FLOOR ${scene.floor ?? "?"}  ·  ${String(scene.phase ?? "").toUpperCase()}`;
    inkText(ctx, bits, 12 * ts, 10 * ts, pal.faint, 3);
    if (ended) {
      ctx.textAlign = "right";
      inkText(ctx, String(endedBecause ?? "run over").toUpperCase(), W - 12 * ts, 10 * ts, pal.flame, 3);
    }
    ctx.letterSpacing = "0px";
  }

  /**
   * Vignette, plus a rim of colour when something is about to go wrong.
   *
   * The rim is the only whole-screen effect on the stage, and it is spent on the
   * two things a viewer must not miss: a telegraph winding up, and somebody one
   * hit from going down.
   */
  function drawVignette(now: number) {
    if (grads.vignette) ctx.fillStyle = grads.vignette;
    ctx.fillRect(0, 0, W, H);

    const telegraph = facts?.telegraph;
    const dire = facts?.dire;
    if (!telegraph && !dire) return;
    const pulse = reduce ? 0.6 : 0.5 + 0.5 * Math.sin(now * (telegraph ? 0.007 : 0.004));
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = (telegraph ? 0.3 : 0.16) * (0.45 + 0.55 * pulse);
    const rim = telegraph ? grads.edgeFlame : grads.edgeBad;
    if (rim) ctx.fillStyle = rim;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  const byDepth = (p: Actor, q: Actor) => p.cy - q.cy;

  function draw(now: number) {
    if (!W || !H) return;
    ctx.fillStyle = pal.ground;
    ctx.fillRect(0, 0, W, H);
    buildRoom(scene?.floor ?? 0);
    ctx.drawImage(roomCanvas, 0, 0, W, H);
    drawTorches(now);

    if (!scene) {
      drawIdle(now);
      drawVignette(now);
      return;
    }

    drawFurniture(now);
    drawIntents();

    // Back to front, so the near rank overlaps the far one and the room has a
    // depth order rather than a paint order.
    order.length = 0;
    for (const a of actorList) order.push(a);
    order.sort(byDepth);
    for (const a of order) drawActor(a, now);

    drawProjectiles(now);
    drawRings(now);
    drawSparks(now);
    drawFloaters(now);

    // The vignette goes on before the telegraph banner, the speech and the
    // caption: those three are text, and text that has been dimmed by a corner
    // shadow is the first thing a re-encode turns to mush.
    drawVignette(now);
    drawTelegraphs(now);
    drawBubbles(now);
    drawCaption();
  }

  let previousFrame = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - previousFrame) / 1000);
    previousFrame = now;
    try {
      step(dt, now);
      draw(now);
    } catch (err) {
      // One bad frame must not end the broadcast; the store's poll loop is a
      // separate failure domain and will keep feeding us.
      console.error("stage frame failed", err);
    }
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);

  return function render(store: BroadcastState) {
    const now = performance.now();
    ended = !!store.ended;
    endedBecause = store.endedBecause;
    if (store.scene && store.scene !== lastScene) {
      lastScene = store.scene;
      absorbScene(store.scene, now);
    } else if (!store.scene && lastScene) {
      // The store reset: a different run started under the same name.
      lastScene = null;
      scene = null;
      facts = null;
      first = true;
      lastBeatsTick = null;
      saidSeen = -1;
      bubbles.length = 0;
      for (const a of actorList.slice()) dropActor(a);
    }
    absorbSaid(store.said ?? [], now);
  };
}
