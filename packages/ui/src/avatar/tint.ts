/**
 * A body in a colour of its own: the model's textures and colours turned
 * round the colour wheel by a number of degrees. Lightness and saturation
 * stay as the artist made them, so a green robot becomes an equally good red
 * or blue one, and several agents sharing one model can be told apart. A
 * colour an agent chose scales them too (`Tint` in `body.ts`), so a body can
 * be grey, pale or dark as well as any hue.
 */
import * as THREE from "three";
import type { Tint } from "./body";

/**
 * The hue rotation matrix, as CSS `hue-rotate()` defines it: the same turn
 * the browser would make, done by hand so it works where canvas filters don't.
 */
export function hueMatrix(degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ];
}

/** Saturation scaled as CSS `saturate()` scales it: 0 is grey, 1 leaves it, more is richer. */
export function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s,
    0.715 - 0.715 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 + 0.285 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 - 0.715 * s,
    0.072 + 0.928 * s,
  ];
}

/** `a` after `b`: one 3×3 matrix that does both. */
function times(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return out;
}

/** The whole turn a tint makes, as one matrix: round the wheel, then saturation, then lightness. */
export function tintMatrix(tint: Tint): number[] {
  const lit = [tint.lightness, 0, 0, 0, tint.lightness, 0, 0, 0, tint.lightness];
  return times(lit, times(saturateMatrix(tint.saturation), hueMatrix(tint.hue)));
}

/** Turn RGBA pixels (0–255) in place. */
export function rotatePixels(data: Uint8ClampedArray, m: number[]) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = m[0] * r + m[1] * g + m[2] * b;
    data[i + 1] = m[3] * r + m[4] * g + m[5] * b;
    data[i + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
}

function rotateColor(color: THREE.Color, m: number[]) {
  const { r, g, b } = color;
  color.setRGB(
    Math.max(0, m[0] * r + m[1] * g + m[2] * b),
    Math.max(0, m[3] * r + m[4] * g + m[5] * b),
    Math.max(0, m[6] * r + m[7] * g + m[8] * b),
  );
}

/** A copy of a texture with its picture turned; the original, when its picture can't be read. */
function rotateTexture(texture: THREE.Texture, m: number[], done: Map<THREE.Texture, THREE.Texture>): THREE.Texture {
  const seen = done.get(texture);
  if (seen) return seen;
  const image = texture.image as CanvasImageSource & { width: number; height: number };
  if (!image?.width || !image.height) return texture;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return texture;
  try {
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    rotatePixels(pixels.data, m);
    ctx.putImageData(pixels, 0, 0);
  } catch {
    return texture;
  }
  // A source of its own: a clone shares the original's, and setting `image` would change both.
  const out = texture.clone();
  out.source = new THREE.Source(canvas);
  out.needsUpdate = true;
  done.set(texture, out);
  return out;
}

/** The colour-bearing slots of a standard or MToon material. */
const TEXTURES = ["map", "shadeMultiplyTexture"] as const;
const COLORS = ["color", "shadeColorFactor"] as const;

/** Turn every material in a model by a tint: round the colour wheel, and paler, darker or greyer when it says. */
export function tintModel(root: THREE.Object3D, tint: Tint) {
  if (!tint.hue && tint.saturation === 1 && tint.lightness === 1) return;
  const m = tintMatrix(tint);
  const textures = new Map<THREE.Texture, THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) materials.add(x);
  });
  for (const mat of materials) {
    const slots = mat as unknown as Record<string, unknown>;
    for (const key of TEXTURES) {
      const t = slots[key];
      if (t instanceof THREE.Texture) slots[key] = rotateTexture(t, m, textures);
    }
    for (const key of COLORS) {
      const c = slots[key];
      if (c instanceof THREE.Color) rotateColor(c, m);
    }
    mat.needsUpdate = true;
  }
}
