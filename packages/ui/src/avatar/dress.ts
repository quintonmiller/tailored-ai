/**
 * What a body wears, built: each piece of a recipe (`wear.ts`) as a mesh, in
 * the agent's colours. The shapes and the colours are made once and shared
 * by every body, so a room of thirty bodies dressed costs a few dozen small
 * geometries, not a few hundred.
 */
import * as THREE from "three";
import { BASE_HUE, type Tint } from "./body";
import { share } from "./shared";
import type { Piece, Tone, V3 } from "./wear";

/**
 * An agent's colours for what it wears, from how its body is tinted: its own
 * hue, deeper than the body so a scarf or a cap stands out against it, a
 * darker one, a pale one for stripes and trims, and a muted one. A body made
 * grey wears greys.
 */
export function wearColors(tint: Tint | undefined): Record<"main" | "dark" | "light" | "muted", number> {
  const h = (BASE_HUE + (tint?.hue ?? 0)) / 360;
  const grey = Math.min(1, tint?.saturation ?? 1);
  const hsl = (s: number, l: number) => new THREE.Color().setHSL(h % 1, s * grey, l).getHex();
  return { main: hsl(0.6, 0.34), dark: hsl(0.45, 0.19), light: hsl(0.5, 0.84), muted: hsl(0.25, 0.42) };
}

const FIXED: Record<Exclude<Tone, "main" | "dark" | "light" | "muted">, number> = {
  ink: 0x24272e,
  metal: 0x9aa1ab,
  gold: 0xd4a72c,
  paper: 0xf2ece0,
  glass: 0xbfe3f2,
};

// --------------------------------------------------------------------------
// Building it
// --------------------------------------------------------------------------

/**
 * One geometry per shape for every body there is, kept for the page: a few dozen vertices each. Every stage draws them,
 * so each one disposes them as it goes (`shared.ts`), or its renderer, and the stage with it, would stay in memory.
 */
const shapes = new Map<Piece["shape"], THREE.BufferGeometry>();
function shapeOf(shape: Piece["shape"]): THREE.BufferGeometry {
  let g = shapes.get(shape);
  if (g) return g;
  switch (shape) {
    case "box":
      g = new THREE.BoxGeometry(1, 1, 1);
      break;
    case "cyl":
    case "rod":
      g = new THREE.CylinderGeometry(0.5, 0.5, 1, shape === "rod" ? 6 : 16);
      break;
    case "cone":
      g = new THREE.ConeGeometry(0.5, 1, 16);
      break;
    case "pyramid":
      g = new THREE.ConeGeometry(0.5, 1, 4);
      break;
    case "ball":
      g = new THREE.IcosahedronGeometry(0.5, 2);
      break;
    case "dome":
      g = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      break;
    case "ring":
      g = new THREE.TorusGeometry(0.5, 0.05, 6, 24).rotateX(Math.PI / 2);
      break;
    case "roll":
      g = new THREE.TorusGeometry(0.5, 0.15, 8, 24).rotateX(Math.PI / 2);
      break;
    case "hoop":
      g = new THREE.TorusGeometry(0.5, 0.07, 6, 18);
      break;
    case "arc":
      g = new THREE.TorusGeometry(0.5, 0.08, 6, 16, Math.PI);
      break;
  }
  shapes.set(shape, share(g));
  return g;
}

/** How a shape's own size maps to the size a piece asks for: the scale that gives it. */
function scaleFor(p: Piece): V3 {
  const [x, y, z] = p.size;
  switch (p.shape) {
    case "dome":
      return [x / 2, y, z / 2];
    case "ring":
      return [x, y / 0.1, z];
    case "roll":
      return [x, y / 0.3, z];
    case "hoop":
      return [x, y, z / 0.14];
    case "arc":
      return [x, y * 2, z / 0.16];
    default:
      return [x, y, z];
  }
}

/** One material per colour, shared by every body and kept for the page: disposed as each stage goes, as the shapes are. */
const paints = new Map<number, THREE.MeshStandardMaterial>();
let glass: THREE.MeshStandardMaterial | undefined;
function paintOf(tone: Tone, colors: ReturnType<typeof wearColors>): THREE.Material {
  if (tone === "glass") {
    glass ??= share(
      new THREE.MeshStandardMaterial({ color: FIXED.glass, transparent: true, opacity: 0.35, roughness: 0.1 }),
    );
    return glass;
  }
  const color = tone in FIXED ? FIXED[tone as keyof typeof FIXED] : colors[tone as keyof typeof colors];
  let m = paints.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.8,
      metalness: tone === "metal" ? 0.4 : 0,
      flatShading: true,
    });
    paints.set(color, share(m));
  }
  return m;
}

const UP = new THREE.Vector3(0, 1, 0);

/** A piece as a mesh, placed in the body's frame. */
export function buildPiece(p: Piece, colors: ReturnType<typeof wearColors>): THREE.Mesh {
  const mesh = new THREE.Mesh(shapeOf(p.shape), paintOf(p.tone, colors));
  mesh.castShadow = p.tone !== "glass";
  if (p.shape === "rod" && p.to) {
    const from = new THREE.Vector3(...p.at);
    const along = new THREE.Vector3(...p.to).sub(from);
    mesh.position.copy(from).addScaledVector(along, 0.5);
    mesh.quaternion.setFromUnitVectors(UP, along.clone().normalize());
    mesh.scale.set(p.size[0], along.length(), p.size[0]);
    return mesh;
  }
  mesh.position.set(...p.at);
  if (p.turn) mesh.rotation.set(...p.turn);
  mesh.scale.set(...scaleFor(p));
  return mesh;
}
