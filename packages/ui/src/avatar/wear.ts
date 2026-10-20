/**
 * What a body wears: a headset, glasses, a hat, a scarf, a lanyard, a satchel,
 * a tool belt, a bow tie. Each is a few simple shapes in the agent's own
 * colours, sized to the body it is on and fixed to a bone (the head, the
 * chest or the hips), so it goes wherever that part of the body goes: walking,
 * sitting, asleep, holding something up.
 *
 * The body is measured once, standing as the model was made (`fit.ts`): how
 * big its head is and where its face is, how thick its neck, how broad its
 * chest and hips. Everything here works from those numbers, so a robot with a
 * big head gets a big hat, and a slim figure a slim belt. Recipes are plain
 * data, built into meshes from a handful of shapes shared by every body
 * (`dress.ts`). Nothing here needs three.js, so the agent's card and the map
 * can name what a body wears without loading the 3D code.
 */
/** Where on the body a thing goes: one thing to a place. */
export type Slot = "head" | "eyes" | "neck" | "chest" | "side" | "waist";

/** What a body can wear, by the names the server uses (`WEAR` in core's `places-roles.ts`), and where each goes. */
export const WEAR: Record<string, Slot> = {
  headset: "head",
  glasses: "eyes",
  beret: "head",
  cap: "head",
  "wizard hat": "head",
  "adventurer hat": "head",
  scarf: "neck",
  "bow tie": "neck",
  lanyard: "chest",
  satchel: "side",
  "tool belt": "waist",
};

/** The most a body wears at once, as the server allows. */
export const WEAR_MOST = 4;

/** The world-state type holding what each body wears, once someone has chosen (see core's `places.ts`). */
export const WEAR_TYPE = "wear";

/**
 * What is worn once `thing` is put on or taken off: off if it was on; on, in
 * place of whatever was in its place; and the oldest thing dropped to make
 * room when the body already wears as much as it can.
 */
export function toggleWear(worn: string[], thing: string): string[] {
  if (worn.includes(thing)) return worn.filter((w) => w !== thing);
  if (!WEAR[thing]) return worn;
  const kept = worn.filter((w) => WEAR[w] !== WEAR[thing]);
  return [...kept, thing].slice(-WEAR_MOST);
}

/** What a body wears, in words: "glasses and a lanyard", or "nothing". */
export function wearWords(worn: string[]): string {
  const said = worn.map((w) => (w === "glasses" ? w : /^[aeiou]/.test(w) ? `an ${w}` : `a ${w}`));
  if (!said.length) return "nothing";
  return said.length === 1 ? said[0] : `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
}

// --------------------------------------------------------------------------
// The body, measured
// --------------------------------------------------------------------------

export type V3 = [number, number, number];

/** A box round part of the body. */
export interface Box {
  min: V3;
  max: V3;
}

/**
 * The body as what it wears needs it, in the body's own frame standing as
 * made: metres, +Y up, +Z the way it faces, +X to its left.
 */
export interface BodyFit {
  head: Box;
  /** The eyes' height, the front of the face there, and how far the face reaches to each side there. */
  face: { y: number; z: number; half: number };
  /** Where the neck meets the shoulders: its height, how far forward its middle is, and half its thickness. */
  neck: { y: number; z: number; radius: number };
  chest: Box;
  /** The front of the chest just under the neck, where a bow tie or a lanyard's cord sits. */
  collar: { y: number; z: number };
  hips: Box;
  /** Where a belt goes: just under the top of the hips, and how far the body reaches across and front to back there. */
  waist: { y: number; half: number; depth: number };
}

/** The parts of the body measured, each as points on its surface. */
export interface BodyPoints {
  head: V3[];
  neck: V3[];
  chest: V3[];
  hips: V3[];
}

function boxOf(points: V3[]): Box | undefined {
  if (!points.length) return undefined;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  return { min, max };
}

/** The furthest forward of the points within `band` of a height; `fallback` when none are. */
function frontAt(points: V3[], y: number, band: number, fallback: number): number {
  let z = -Infinity;
  for (const p of points) if (Math.abs(p[1] - y) <= band) z = Math.max(z, p[2]);
  return Number.isFinite(z) ? z : fallback;
}

/** How far the points within `band` of a height reach from `from` along an axis (0 across, 2 front to back). */
function halfAt(points: V3[], y: number, band: number, from: number, fallback: number, axis: 0 | 2 = 0): number {
  let half = 0;
  for (const p of points) if (Math.abs(p[1] - y) <= band) half = Math.max(half, Math.abs(p[axis] - from));
  return half || fallback;
}

/**
 * The body as what it wears needs it, from points on its surface by part,
 * and `eyes`, where the model says its eyes are, when it does. A model with
 * no head to measure has nothing worn on it; a part without points is
 * reckoned from the head.
 */
export function fitFrom(points: BodyPoints, eyes?: V3): BodyFit | undefined {
  const head = boxOf(points.head);
  if (!head) return undefined;
  const w = head.max[0] - head.min[0];
  const h = head.max[1] - head.min[1];
  const cx = (head.min[0] + head.max[0]) / 2;
  const cz = (head.min[2] + head.max[2]) / 2;
  // A body without a torso to measure: one the width of its head, hung under it.
  const chest = boxOf(points.chest) ?? {
    min: [cx - w / 2, head.min[1] - h * 1.2, cz - w * 0.3],
    max: [cx + w / 2, head.min[1], cz + w * 0.3],
  };
  const hips = boxOf(points.hips) ?? {
    min: [chest.min[0], chest.min[1] - h * 0.4, chest.min[2]],
    max: [chest.max[0], chest.min[1], chest.max[2]],
  };
  const eyeY = eyes?.[1] ?? head.min[1] + h * 0.52;
  const faceBand = Math.max(0.01, h * 0.12);
  const neckBox = boxOf(points.neck);
  const chestH = chest.max[1] - chest.min[1];
  const collarY = chest.max[1] - chestH * 0.15;
  const neckY = neckBox ? neckBox.min[1] : chest.max[1];
  const hipsH = hips.max[1] - hips.min[1];
  const waistY = hips.max[1] - hipsH * 0.2;
  const [hx, , hz] = [(hips.min[0] + hips.max[0]) / 2, 0, (hips.min[2] + hips.max[2]) / 2];
  const neckRadius = neckBox
    ? Math.max(neckBox.max[0] - neckBox.min[0], neckBox.max[2] - neckBox.min[2]) / 2
    : (chest.max[0] - chest.min[0]) * 0.2;
  return {
    head,
    face: {
      y: eyeY,
      z: frontAt(points.head, eyeY, faceBand, head.max[2]),
      half: halfAt(points.head, eyeY, faceBand, cx, w / 2),
    },
    neck: {
      y: neckY,
      z: neckBox ? (neckBox.min[2] + neckBox.max[2]) / 2 : (chest.min[2] + chest.max[2]) / 2,
      radius: Math.max(neckRadius, w * 0.12),
    },
    chest,
    collar: { y: collarY, z: frontAt(points.chest, collarY, chestH * 0.15, chest.max[2]) },
    hips,
    waist: {
      y: waistY,
      half: halfAt(points.hips, waistY, hipsH * 0.15, hx, (hips.max[0] - hips.min[0]) / 2),
      depth: halfAt(points.hips, waistY, hipsH * 0.15, hz, (hips.max[2] - hips.min[2]) / 2, 2),
    },
  };
}

// --------------------------------------------------------------------------
// Recipes
// --------------------------------------------------------------------------

/** The bone a piece goes with. */
export type Bone = "head" | "chest" | "hips";

/** A colour by its part in an agent's colours, or a fixed one. */
export type Tone = "main" | "dark" | "light" | "muted" | "ink" | "metal" | "gold" | "paper" | "glass";

/**
 * One shape of a thing worn, in the body's frame. `box`, `cyl`, `cone`,
 * `pyramid`, `ball` and `dome` are sized by their width, height and depth;
 * `ring` and `roll` (a thin and a thick hoop) lie flat, sized by their width
 * across, their thickness and their depth across; `hoop` stands facing ahead,
 * sized by width, height and thickness; `arc` is the top half of a standing
 * hoop, sized by width, how high it rises and its thickness; `rod` runs from
 * `at` to `to`, `size[0]` thick.
 */
export interface Piece {
  shape: "box" | "cyl" | "cone" | "pyramid" | "ball" | "dome" | "ring" | "roll" | "hoop" | "arc" | "rod";
  bone: Bone;
  at: V3;
  size: V3;
  to?: V3;
  turn?: V3;
  tone: Tone;
}

const width = (b: Box) => b.max[0] - b.min[0];
const height = (b: Box) => b.max[1] - b.min[1];
const depth = (b: Box) => b.max[2] - b.min[2];
const mid = (b: Box): V3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

/** The shapes a thing is made of, on the body measured as `fit`; none for something unknown. */
export function wearPieces(thing: string, fit: BodyFit): Piece[] {
  const { head, face, neck, chest, collar, hips } = fit;
  const w = width(head);
  const h = height(head);
  const d = depth(head);
  const [cx, cy, cz] = mid(head);
  const top = head.max[1];
  const cw = width(chest);
  const [chx] = mid(chest);
  switch (thing) {
    case "headset": {
      const ear = w / 2 + w * 0.04;
      return [
        { shape: "arc", bone: "head", at: [cx, cy, cz], size: [w * 1.1, top - cy + w * 0.05, w * 0.08], tone: "ink" },
        ...[-1, 1].flatMap((side): Piece[] => [
          {
            shape: "cyl",
            bone: "head",
            at: [cx + side * ear, cy, cz],
            size: [h * 0.34, w * 0.12, h * 0.34],
            turn: [0, 0, Math.PI / 2],
            tone: "main",
          },
          {
            shape: "cyl",
            bone: "head",
            at: [cx + side * (ear + w * 0.06), cy, cz],
            size: [h * 0.22, w * 0.03, h * 0.22],
            turn: [0, 0, Math.PI / 2],
            tone: "dark",
          },
        ]),
        // The microphone on a boom from the left ear round to the mouth.
        {
          shape: "rod",
          bone: "head",
          at: [cx + ear, cy - h * 0.08, cz + d * 0.1],
          to: [cx + w * 0.16, cy - h * 0.3, face.z + w * 0.05],
          size: [w * 0.035, 0, 0],
          tone: "ink",
        },
        {
          shape: "ball",
          bone: "head",
          at: [cx + w * 0.16, cy - h * 0.3, face.z + w * 0.05],
          size: [w * 0.09, w * 0.09, w * 0.09],
          tone: "dark",
        },
      ];
    }
    case "glasses": {
      const z = face.z + w * 0.03;
      const gap = w * 0.17;
      const lens = Math.min(w * 0.26, face.half * 0.62);
      const reach = Math.max(face.half + w * 0.02, gap + lens / 2);
      return [
        ...[-1, 1].flatMap((side): Piece[] => [
          {
            shape: "hoop",
            bone: "head",
            at: [cx + side * gap, face.y, z],
            size: [lens, lens * 0.85, w * 0.025],
            tone: "ink",
          },
          {
            shape: "cyl",
            bone: "head",
            at: [cx + side * gap, face.y, z - w * 0.005],
            size: [lens * 0.88, w * 0.006, lens * 0.75],
            turn: [Math.PI / 2, 0, 0],
            tone: "glass",
          },
          // From the rim out to the side of the face, and back along it to the ear.
          {
            shape: "box",
            bone: "head",
            at: [cx + (side * (gap + lens / 2 + reach)) / 2, face.y + lens * 0.2, z],
            size: [Math.max(w * 0.02, reach - gap - lens / 2), w * 0.022, w * 0.022],
            tone: "ink",
          },
          {
            shape: "box",
            bone: "head",
            at: [cx + side * reach, face.y + lens * 0.2, (z + cz) / 2],
            size: [w * 0.022, w * 0.022, Math.max(w * 0.05, z - cz)],
            tone: "ink",
          },
        ]),
        {
          shape: "box",
          bone: "head",
          at: [cx, face.y + lens * 0.15, z],
          size: [Math.max(w * 0.03, gap * 2 - lens), w * 0.022, w * 0.022],
          tone: "ink",
        },
      ];
    }
    case "beret":
      return [
        {
          shape: "ball",
          bone: "head",
          at: [cx - w * 0.06, top - h * 0.03, cz],
          size: [w * 1.1, h * 0.24, d * 1.02],
          turn: [0, 0, 0.18],
          tone: "main",
        },
        {
          shape: "cyl",
          bone: "head",
          at: [cx - w * 0.04, top + h * 0.1, cz],
          size: [w * 0.05, h * 0.08, w * 0.05],
          tone: "dark",
        },
      ];
    case "cap": {
      // A crown on the top of the head, and a peak out over the eyes, tipped down a little.
      const base = top - h * 0.24;
      return [
        { shape: "dome", bone: "head", at: [cx, base, cz], size: [w * 1.04, h * 0.34, d * 1.04], tone: "main" },
        {
          shape: "cyl",
          bone: "head",
          at: [cx, base + h * 0.01, cz + d * 0.5],
          size: [w * 0.82, h * 0.045, d * 0.7],
          turn: [0.22, 0, 0],
          tone: "dark",
        },
        {
          shape: "cyl",
          bone: "head",
          at: [cx, base + h * 0.02, cz],
          size: [w * 1.06, h * 0.05, d * 1.06],
          tone: "dark",
        },
        {
          shape: "ball",
          bone: "head",
          at: [cx, base + h * 0.34, cz],
          size: [w * 0.1, w * 0.06, w * 0.1],
          tone: "light",
        },
      ];
    }
    case "wizard hat": {
      const brim = top - h * 0.14;
      return [
        { shape: "cyl", bone: "head", at: [cx, brim, cz], size: [w * 1.55, h * 0.035, d * 1.55], tone: "dark" },
        {
          shape: "cone",
          bone: "head",
          at: [cx + w * 0.04, brim + h * 0.62, cz - d * 0.04],
          size: [w * 0.98, h * 1.25, d * 0.98],
          turn: [-0.12, 0, -0.08],
          tone: "dark",
        },
        {
          shape: "cyl",
          bone: "head",
          at: [cx, brim + h * 0.07, cz],
          size: [w * 0.94, h * 0.1, d * 0.94],
          tone: "gold",
        },
        {
          shape: "ball",
          bone: "head",
          at: [cx + w * 0.18, brim + h * 0.45, cz + d * 0.3],
          size: [w * 0.08, w * 0.08, w * 0.03],
          tone: "gold",
        },
        {
          shape: "ball",
          bone: "head",
          at: [cx - w * 0.1, brim + h * 0.75, cz + d * 0.22],
          size: [w * 0.06, w * 0.06, w * 0.03],
          tone: "gold",
        },
      ];
    }
    case "adventurer hat": {
      const brim = top - h * 0.16;
      return [
        { shape: "cyl", bone: "head", at: [cx, brim, cz], size: [w * 1.6, h * 0.035, d * 1.55], tone: "muted" },
        {
          shape: "cyl",
          bone: "head",
          at: [cx, brim + h * 0.2, cz],
          size: [w * 0.92, h * 0.4, d * 0.86],
          tone: "muted",
        },
        {
          shape: "cyl",
          bone: "head",
          at: [cx, brim + h * 0.07, cz],
          size: [w * 0.95, h * 0.1, d * 0.89],
          tone: "dark",
        },
      ];
    }
    case "scarf": {
      // Wound twice round the neck, a stripe between, and one end hanging down the front with stripes across it.
      const across = Math.max(neck.radius * 2.4, cw * 0.5);
      const thick = Math.max(w * 0.11, across * 0.22);
      const front = Math.max(collar.z, neck.z + across / 2);
      const tail = height(chest) * 0.5;
      const tailX = chx + cw * 0.16;
      const tailY = neck.y - tail / 2 + thick * 0.2;
      return [
        {
          shape: "roll",
          bone: "chest",
          at: [chx, neck.y + thick * 0.3, neck.z],
          size: [across, thick, across * 0.95],
          tone: "main",
        },
        {
          shape: "roll",
          bone: "chest",
          at: [chx, neck.y + thick * 0.95, neck.z],
          size: [across * 0.94, thick * 0.75, across * 0.9],
          tone: "main",
        },
        {
          shape: "roll",
          bone: "chest",
          at: [chx, neck.y + thick * 0.62, neck.z],
          size: [across * 1.02, thick * 0.3, across * 0.97],
          tone: "light",
        },
        // Its end, hanging down the front.
        {
          shape: "box",
          bone: "chest",
          at: [tailX, tailY, front + thick * 0.12],
          size: [cw * 0.22, tail, thick * 0.45],
          turn: [0.1, 0, -0.08],
          tone: "main",
        },
        ...[0.15, 0.32].map(
          (k): Piece => ({
            shape: "box",
            bone: "chest",
            at: [tailX + tail * k * 0.08, tailY - tail * k, front + thick * 0.14 + tail * k * 0.1],
            size: [cw * 0.225, tail * 0.07, thick * 0.47],
            turn: [0.1, 0, -0.08],
            tone: "light",
          }),
        ),
      ];
    }
    case "bow tie": {
      // Big enough to read across a room on a body whose head dwarfs its chest.
      const wing = Math.max(cw * 0.24, w * 0.2);
      const z = collar.z + wing * 0.12;
      return [
        ...[-1, 1].map(
          (side): Piece => ({
            shape: "pyramid",
            bone: "chest",
            at: [chx + side * wing * 0.55, collar.y, z],
            size: [wing * 0.75, wing, wing * 0.4],
            turn: [0, 0, side * (Math.PI / 2)],
            tone: "main",
          }),
        ),
        {
          shape: "box",
          bone: "chest",
          at: [chx, collar.y, z + wing * 0.05],
          size: [wing * 0.32, wing * 0.38, wing * 0.32],
          tone: "light",
        },
      ];
    }
    case "lanyard": {
      const cardY = collar.y - height(chest) * 0.38;
      const front = chest.max[2] + cw * 0.015;
      const card = cw * 0.3;
      return [
        ...[-1, 1].map(
          (side): Piece => ({
            shape: "rod",
            bone: "chest",
            at: [chx + side * neck.radius * 0.95, neck.y, neck.z + neck.radius * 0.6],
            to: [chx + side * card * 0.15, cardY + card * 0.62, front],
            size: [cw * 0.022, 0, 0],
            tone: "main",
          }),
        ),
        {
          shape: "box",
          bone: "chest",
          at: [chx, cardY, front + cw * 0.01],
          size: [card, card * 1.25, cw * 0.012],
          tone: "paper",
        },
        {
          shape: "box",
          bone: "chest",
          at: [chx, cardY + card * 0.42, front + cw * 0.018],
          size: [card, card * 0.3, cw * 0.01],
          tone: "main",
        },
      ];
    }
    case "satchel": {
      const hw = width(hips);
      const [hx, hy, hz] = mid(hips);
      const front = Math.max(chest.max[2], hips.max[2]) + cw * 0.03;
      const shoulder: V3 = [chx - cw * 0.3, chest.max[1] - height(chest) * 0.04, front];
      const hip: V3 = [hx + hw * 0.5, hy + height(hips) * 0.1, front];
      const bag = Math.max(cw, hw) * 0.58;
      // At the left hip, its broad side out, a flap over its top and a buckle on the flap.
      const bx = hx + hw * 0.5 + bag * 0.22;
      const by = hy - bag * 0.1;
      return [
        { shape: "rod", bone: "chest", at: shoulder, to: hip, size: [cw * 0.065, 0, 0], tone: "dark" },
        {
          shape: "rod",
          bone: "chest",
          at: shoulder,
          to: [shoulder[0], shoulder[1], chest.min[2] - cw * 0.02],
          size: [cw * 0.065, 0, 0],
          tone: "dark",
        },
        { shape: "box", bone: "hips", at: [bx, by, hz + bag * 0.1], size: [bag * 0.4, bag * 0.75, bag], tone: "main" },
        {
          shape: "box",
          bone: "hips",
          at: [bx + bag * 0.2, by + bag * 0.16, hz + bag * 0.1],
          size: [bag * 0.06, bag * 0.46, bag * 1.04],
          tone: "dark",
        },
        {
          shape: "box",
          bone: "hips",
          at: [bx + bag * 0.24, by + bag * 0.02, hz + bag * 0.1],
          size: [bag * 0.04, bag * 0.12, bag * 0.16],
          tone: "gold",
        },
      ];
    }
    case "tool belt": {
      // Snug round the waist, a buckle at the front, a pouch at each hip and a hammer hung at the right.
      const { waist } = fit;
      const hw = waist.half * 2;
      const hd = waist.depth * 2;
      const [hx, , hz] = mid(hips);
      const y = waist.y;
      const thick = Math.max(hw * 0.13, height(hips) * 0.2);
      const pouch = hw * 0.28;
      return [
        // A band round the body rather than a ring, so it hugs the waist instead of standing off it.
        { shape: "cyl", bone: "hips", at: [hx, y, hz], size: [hw * 1.06, thick, hd * 1.08], tone: "dark" },
        {
          shape: "box",
          bone: "hips",
          at: [hx, y, hz + hd * 0.56],
          size: [hw * 0.16, thick * 1.1, hw * 0.05],
          tone: "gold",
        },
        ...[-1, 1].map(
          (side): Piece => ({
            shape: "box",
            bone: "hips",
            at: [hx + side * hw * 0.5, y - pouch * 0.45, hz + hd * 0.25],
            size: [pouch * 0.55, pouch, pouch * 0.8],
            turn: [0, side * 0.5, 0],
            tone: "main",
          }),
        ),
        // A hammer hung at the right hip.
        {
          shape: "rod",
          bone: "hips",
          at: [hx - hw * 0.58, y, hz - hd * 0.1],
          to: [hx - hw * 0.6, y - pouch * 1.5, hz - hd * 0.1],
          size: [hw * 0.04, 0, 0],
          tone: "muted",
        },
        {
          shape: "box",
          bone: "hips",
          at: [hx - hw * 0.58, y + pouch * 0.05, hz - hd * 0.1],
          size: [hw * 0.07, hw * 0.07, pouch * 0.75],
          tone: "metal",
        },
      ];
    }
    default:
      return [];
  }
}

/** The top of whatever is worn on the head, standing: what floats over the head goes over that. */
export function wearTop(pieces: Piece[]): number {
  let top = Number.NEGATIVE_INFINITY;
  for (const p of pieces) {
    if (p.bone !== "head") continue;
    const reach = p.shape === "arc" ? p.size[1] : p.shape === "dome" ? p.size[1] : p.size[1] / 2;
    top = Math.max(top, p.at[1] + reach, p.to?.[1] ?? Number.NEGATIVE_INFINITY);
  }
  return top;
}
