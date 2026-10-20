/**
 * Models agents make out of simple parts (the `build` tool, `places-models.ts`
 * in core), drawn in the room. A model is a few boxes, cylinders, spheres,
 * cones, tori, capsules and plates, each with a colour and a finish; it is
 * drawn cheaply, every part of one colour and finish merged into one mesh in
 * one shared material, so a bookcase of forty parts is a handful of draw
 * calls. A box or a plate can carry a face, an agent interface laid on its
 * front as a surface (`surface-layer.ts`), used in the room like a board.
 *
 * What can be worked out without a GPU is here, with tests: which parts merge,
 * how big a model is drawn in the box the room gave it, where a face goes, and
 * what the picture of a face says while it isn't live.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ComponentSpec } from "../lib/content.js";
import { SURFACE_PX } from "./surfaces";

/** The world-state type a model is kept as. */
export const MODEL_TYPE = "model";

export type Shape = "box" | "cylinder" | "sphere" | "cone" | "torus" | "capsule" | "plane";
export type Finish = "matte" | "glossy" | "metal" | "glass" | "glowing";
export type Vec3 = [number, number, number];

/** A part's face, as the server sends it: the interface it shows, made as the model's agent. */
export interface ModelFace {
  kind: string;
  props?: Record<string, unknown>;
  component?: string;
  /** The component itself, so it is drawn at once. */
  spec?: ComponentSpec;
}

export interface ModelPart {
  shape: Shape;
  size: Vec3;
  at: Vec3;
  /** Degrees about x, then y, then z. */
  turn?: Vec3;
  color: string;
  finish?: Finish;
  face?: ModelFace;
}

/** A model, as the server sends it with a place: by its record's id, `planner:bookcase`. */
export interface ModelDef {
  name: string;
  owner: string;
  mount: "floor" | "wall" | "on";
  parts: ModelPart[];
  /** Width, height and depth of the whole, as made. */
  size: Vec3;
  about?: string;
}

/** How thick a plate is drawn, whatever depth it was given: as core measures it. */
export const PLANE_DEPTH = 0.01;
/** How far in front of its part a face sits, so the two never fight over the same pixels. */
const FACE_LIFT = 0.002;

const rad = (deg: number) => (deg * Math.PI) / 180;

// --------------------------------------------------------------------------
// Worked out without a GPU
// --------------------------------------------------------------------------

/** What parts share one mesh: the same colour in the same finish. */
export const materialKey = (part: Pick<ModelPart, "color" | "finish">) => `${part.finish ?? "matte"}:${part.color}`;

/**
 * How a model is drawn: each colour-and-finish, with the parts merged into
 * it, in the order first met; and which parts carry a face, which also gets a
 * plate of its own on its front. A part with a face is still drawn with its
 * colour: the face covers only its front.
 */
export function mergePlan(parts: Pick<ModelPart, "color" | "finish" | "face">[]): {
  groups: { key: string; parts: number[] }[];
  faces: number[];
} {
  const groups: { key: string; parts: number[] }[] = [];
  const byKey = new Map<string, number[]>();
  const faces: number[] = [];
  parts.forEach((part, i) => {
    const key = materialKey(part);
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
      groups.push({ key, parts: list });
    }
    list.push(i);
    if (part.face) faces.push(i);
  });
  return { groups, faces };
}

/**
 * How much a model is scaled to fit the box the room gave it (`size`): as
 * big as fits whole, the same every way so it keeps its shape. The box is
 * its own size times a scale, so this is that scale; a model remade since
 * still fits the box it was placed in, never through a wall or into the next
 * thing. A side thinner than a centimetre (a plate's depth) doesn't count,
 * and nor does depth for something on a wall (`flat`): placed a few
 * centimetres deep, a board made deeper would otherwise shrink to a speck,
 * when standing out a little further from the wall is all it needs.
 */
export function fitScale(made: Vec3, size: Vec3 | undefined, flat = false): number {
  if (!size) return 1;
  let fit = Number.POSITIVE_INFINITY;
  for (let i = 0; i < (flat ? 2 : 3); i++) if (made[i] > 0.011 && size[i] > 0) fit = Math.min(fit, size[i] / made[i]);
  return Number.isFinite(fit) ? Math.max(0.05, Math.min(20, fit)) : 1;
}

/** A point turned about x, then y, then z, by degrees: as a mesh with rotation order XYZ turns it. */
export function turnPoint([x, y, z]: Vec3, turn?: Vec3): Vec3 {
  if (!turn) return [x, y, z];
  const v = new THREE.Vector3(x, y, z).applyEuler(new THREE.Euler(rad(turn[0]), rad(turn[1]), rad(turn[2]), "XYZ"));
  return [v.x, v.y, v.z];
}

/** Where a part's face goes: the middle of its front, just in front of it, turned with it, as big as the front. */
export function faceAnchor(part: Pick<ModelPart, "shape" | "size" | "at" | "turn">): {
  at: Vec3;
  turn?: Vec3;
  size: [number, number];
} {
  const depth = part.shape === "plane" ? PLANE_DEPTH : part.size[2];
  const front = turnPoint([0, 0, depth / 2 + FACE_LIFT], part.turn);
  return {
    at: [part.at[0] + front[0], part.at[1] + front[1], part.at[2] + front[2]],
    ...(part.turn ? { turn: part.turn } : {}),
    size: [part.size[0], part.size[1]],
  };
}

/**
 * The fewest CSS pixels a face's HTML is laid out across its shorter side.
 * A surface is laid out at 640 pixels a metre and scaled into the room, so a
 * card on a desk would be a page a couple of hundred pixels high, blown up
 * soft when read close; laid out denser and scaled down to its size, it reads
 * as sharp as a board on a wall.
 */
export const FACE_MIN_PX = 400;

/** How much denser than a metre at 640 pixels a face `size` metres across is laid out: 1 for a big one, at most 3. */
export function faceDensity(size: [number, number]): number {
  return Math.min(3, Math.max(1, FACE_MIN_PX / (Math.min(size[0], size[1]) * SURFACE_PX)));
}

/** One line on the picture of a face: words, and a tick box ticked or not. */
export interface FaceLine {
  text: string;
  ticked?: boolean;
}

/**
 * What the picture of a face says while it isn't live (from across a room):
 * its title, and the lines its component was filled with when the room was
 * last sent (the server fills them from the records each time, and the page
 * asks again when one changes), a list's items with their ticks, a card's
 * text and fields, a table's first column. The live face, close up, is the
 * real thing.
 */
export function faceLines(spec: ComponentSpec | undefined, most = 6): { title: string; lines: FaceLine[] } {
  if (!spec) return { title: "", lines: [] };
  const p = spec.props ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
  const title = str(p.title);
  let lines: FaceLine[] = [];
  if (Array.isArray(p.items))
    lines = (p.items as { label?: unknown; checked?: unknown }[]).map((i) => ({
      text: str(i.label),
      ...(p.check ? { ticked: i.checked === true } : {}),
    }));
  else if (Array.isArray(p.rows)) lines = (p.rows as { cells?: unknown[] }[]).map((r) => ({ text: str(r.cells?.[0]) }));
  else {
    // A card: its text, then its fields.
    if (p.body) lines.push({ text: str(p.body) });
    if (Array.isArray(p.fields))
      for (const f of p.fields as { label?: unknown; value?: unknown }[])
        lines.push({ text: `${str(f.label)}: ${str(f.value)}` });
  }
  return { title, lines: lines.slice(0, most) };
}

// --------------------------------------------------------------------------
// Drawing
// --------------------------------------------------------------------------

const materials = new Map<string, THREE.MeshStandardMaterial>();

/** One shared material for each colour in each finish. */
function materialFor(part: Pick<ModelPart, "color" | "finish">): THREE.MeshStandardMaterial {
  const key = materialKey(part);
  let m = materials.get(key);
  if (m) return m;
  const color = /^#[0-9a-f]{6}$/i.test(part.color) ? part.color : "#b8b2a7";
  switch (part.finish) {
    case "glossy":
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.05 });
      break;
    case "metal":
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.85 });
      break;
    case "glass":
      m = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.05,
        metalness: 0.1,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      break;
    case "glowing":
      m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.6 });
      break;
    default:
      // The same flat, low-poly look as the room's own furniture.
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true });
  }
  materials.set(key, m);
  return m;
}

/** Forget the shared materials: the room's furniture, and they with it, have just been freed (`disposeTree`). */
export function forgetModels() {
  materials.clear();
}

/** A part's own geometry, at its size, turned and in its place in the model. */
function partGeometry(part: ModelPart): THREE.BufferGeometry {
  const [w, h, d] = part.size;
  let g: THREE.BufferGeometry;
  let stretch: Vec3 = [1, 1, 1];
  switch (part.shape) {
    case "plane":
      g = new THREE.BoxGeometry(w, h, PLANE_DEPTH);
      break;
    case "cylinder":
      g = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
      stretch = [w, h, d];
      break;
    case "cone":
      g = new THREE.ConeGeometry(0.5, 1, 18);
      stretch = [w, h, d];
      break;
    case "sphere":
      g = new THREE.SphereGeometry(0.5, 18, 12);
      stretch = [w, h, d];
      break;
    case "torus": {
      // A ring lying flat, as wide and deep as its box, its tube as thick as its height.
      const tube = Math.max(0.02, Math.min(0.45, h / Math.max(0.001, Math.min(w, d)) / 2));
      g = new THREE.TorusGeometry(0.5 - tube, tube, 10, 28);
      g.rotateX(Math.PI / 2);
      stretch = [w, h / (2 * tube), d];
      break;
    }
    case "capsule": {
      // Never shorter than it is round, so one lower than it is wide is a round one squashed to its height.
      const r = Math.min(w, d) / 2;
      g = new THREE.CapsuleGeometry(r, Math.max(0, h - 2 * r), 4, 14);
      stretch = [w / (2 * r), h / Math.max(h, 2 * r), d / (2 * r)];
      break;
    }
    default:
      g = new THREE.BoxGeometry(w, h, d);
  }
  const t = part.turn ?? [0, 0, 0];
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...part.at),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(t[0]), rad(t[1]), rad(t[2]), "XYZ")),
    new THREE.Vector3(...stretch),
  );
  g.applyMatrix4(m);
  // Only what every shape has, so any of them merge with any other.
  for (const name of Object.keys(g.attributes))
    if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
  return g;
}

/** Pixels a metre of a face's picture is drawn at. */
const FACE_PX = 420;

/** The picture of a face while it isn't live: its title and lines, on paper. */
export function drawFace(canvas: HTMLCanvasElement, spec: ComponentSpec | undefined) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const { title, lines } = faceLines(spec);
  ctx.fillStyle = "#fbfaf6";
  ctx.fillRect(0, 0, w, h);
  const pad = Math.round(Math.min(w, h) * 0.07);
  const size = Math.max(10, Math.round(Math.min(h * 0.12, w * 0.08)));
  ctx.fillStyle = "#1f2430";
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(title || "…", pad, pad, w - pad * 2);
  const line = Math.round(size * 0.82);
  ctx.font = `500 ${line}px system-ui, sans-serif`;
  let y = pad + size * 1.5;
  for (const l of lines) {
    if (y + line > h - pad) break;
    let x = pad;
    if (l.ticked !== undefined) {
      ctx.strokeStyle = "#667085";
      ctx.lineWidth = Math.max(1, line * 0.1);
      ctx.strokeRect(x, y + line * 0.1, line * 0.8, line * 0.8);
      if (l.ticked) {
        ctx.fillStyle = "#2e9e5b";
        ctx.fillRect(x + line * 0.18, y + line * 0.28, line * 0.44, line * 0.44);
      }
      x += line * 1.2;
    }
    ctx.fillStyle = l.ticked ? "#98a2b3" : "#344054";
    ctx.fillText(l.text, x, y, w - x - pad);
    y += line * 1.45;
  }
}

/**
 * A model's face as built: the plate it is shown on and how big that is in
 * metres; what its HTML lies on, and how big it is there (denser for a small
 * face, `faceDensity`); and what it shows.
 */
export interface BuiltFace {
  mesh: THREE.Mesh;
  size: [number, number];
  anchor: THREE.Object3D;
  surface: [number, number];
  part: number;
  spec?: ComponentSpec;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
}

/**
 * A model built: its parts merged by colour and finish, and a plate on the
 * front of each part with a face, fitted into the box the room gave it
 * (`size`), standing on its own origin, front toward +Z, as `buildProp`
 * builds the room's own things. A model that is gone is an empty frame of
 * that box, so the room still shows where it stood.
 */
export function buildModel(def: ModelDef | undefined, size?: Vec3): { group: THREE.Group; faces: BuiltFace[] } {
  const group = new THREE.Group();
  if (!def?.parts?.length) {
    const [w, h, d] = size ?? [0.5, 0.5, 0.5];
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
      new THREE.LineBasicMaterial({ color: 0x8a8f96, transparent: true, opacity: 0.6 }),
    );
    edges.position.y = h / 2;
    group.add(edges);
    return { group, faces: [] };
  }
  const inner = new THREE.Group();
  inner.scale.setScalar(fitScale(def.size, size, def.mount === "wall"));
  group.add(inner);
  const plan = mergePlan(def.parts);
  for (const g of plan.groups) {
    const geometries = g.parts.map((i) => partGeometry(def.parts[i]));
    const merged = geometries.length > 1 ? mergeGeometries(geometries) : geometries[0];
    const meshes = merged ? [merged] : geometries;
    if (merged && geometries.length > 1) for (const one of geometries) one.dispose();
    const material = materialFor(def.parts[g.parts[0]]);
    for (const geometry of meshes) {
      const mesh = new THREE.Mesh(geometry, material);
      // Glass casts no shadow; and glows light their own way.
      mesh.castShadow = !material.transparent;
      mesh.receiveShadow = true;
      inner.add(mesh);
    }
  }
  const faces: BuiltFace[] = [];
  for (const i of plan.faces) {
    const part = def.parts[i];
    const anchor = faceAnchor(part);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(64, Math.round(anchor.size[0] * FACE_PX));
    canvas.height = Math.max(48, Math.round(anchor.size[1] * FACE_PX));
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const spec = part.face?.spec;
    drawFace(canvas, spec);
    texture.needsUpdate = true;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(anchor.size[0], anchor.size[1]),
      new THREE.MeshStandardMaterial({
        map: texture,
        emissiveMap: texture,
        emissive: 0xffffff,
        emissiveIntensity: 0.45,
        roughness: 0.9,
      }),
    );
    mesh.position.set(...anchor.at);
    if (anchor.turn) mesh.rotation.set(rad(anchor.turn[0]), rad(anchor.turn[1]), rad(anchor.turn[2]), "XYZ");
    inner.add(mesh);
    // The HTML lies on the plate, laid out denser and scaled down to fit it when the plate is small.
    const k = faceDensity(anchor.size);
    const lies = new THREE.Object3D();
    lies.scale.setScalar(1 / k);
    mesh.add(lies);
    faces.push({
      mesh,
      size: anchor.size,
      anchor: lies,
      surface: [anchor.size[0] * k, anchor.size[1] * k],
      part: i,
      ...(spec ? { spec } : {}),
      canvas,
      texture,
    });
  }
  return { group, faces };
}
