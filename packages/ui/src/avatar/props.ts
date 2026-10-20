/**
 * The room's shell and furniture, built from boxes and cylinders with flat
 * shading: no model files to ship or licence, and the same low-poly look as
 * most VRM avatars. Each builder returns a group standing on the floor at its
 * own origin, front toward +Z; the stage places and turns it.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { fitPlate } from "./doors";
import { forgetModels } from "./models";
import type { PropKind, Room, RoomDoor } from "./scene";
import { FACE_SIZE } from "./widgets";

const materials = new Map<string, THREE.MeshStandardMaterial>();

/** One shared flat-shaded material per colour. */
function paint(color: number): THREE.MeshStandardMaterial {
  const key = color.toString(16);
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true });
    materials.set(key, m);
  }
  return m;
}

/** One shared smooth, faintly shiny material per colour: a screen's bezel, a board's aluminium. */
function satin(color: number): THREE.MeshStandardMaterial {
  const key = `satin:${color.toString(16)}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.35 });
    materials.set(key, m);
  }
  return m;
}

/** A box with its edges and corners rounded off, by size and centre, in a material given. */
function rounded(
  group: THREE.Group,
  size: [number, number, number],
  radius: number,
  material: THREE.Material,
  at: [number, number, number],
): THREE.Mesh {
  const mesh = solid(new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius), material, ...at);
  mesh.castShadow = false;
  group.add(mesh);
  return mesh;
}

/** A material of its own that can glow: lamp shades, screens, window glass. */
function glowing(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0, roughness: 0.6 });
}

function solid(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A box by size and centre. */
function box(group: THREE.Group, w: number, h: number, d: number, color: number, x: number, y: number, z: number) {
  const mesh = solid(new THREE.BoxGeometry(w, h, d), paint(color), x, y, z);
  group.add(mesh);
  return mesh;
}

function cylinder(
  group: THREE.Group,
  top: number,
  bottom: number,
  h: number,
  color: number | THREE.Material,
  x: number,
  y: number,
  z: number,
  sides = 10,
) {
  const material = typeof color === "number" ? paint(color) : color;
  const mesh = solid(new THREE.CylinderGeometry(top, bottom, h, sides), material, x, y, z);
  group.add(mesh);
  return mesh;
}

const WOOD = [0xb5835a, 0xa87650];
const WALL = 0xe9dfd0;

/** A "#rrggbb" colour as a number, or the fallback when there is none. */
function hex(color: string | undefined, fallback: number): number {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? Number.parseInt(color.slice(1), 16) : fallback;
}

/** A colour lighter (positive) or darker (negative) by a fraction. */
function tint(color: number, by: number): number {
  const ch = (c: number) => Math.round(by > 0 ? c + (255 - c) * by : c * (1 + by));
  return (ch((color >> 16) & 255) << 16) | (ch((color >> 8) & 255) << 8) | ch(color & 255);
}

/**
 * Many boxes of one size and colour as one mesh, drawn in a single call: the
 * planks and tiles of a floor, which in a big room run to hundreds.
 */
function tiles(group: THREE.Group, w: number, h: number, d: number, color: number, at: [number, number, number][]) {
  if (!at.length) return;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(w, h, d), paint(color), at.length);
  const m = new THREE.Matrix4();
  for (const [i, [x, y, z]] of at.entries()) mesh.setMatrixAt(i, m.makeTranslation(x, y, z));
  mesh.receiveShadow = true;
  group.add(mesh);
}

/**
 * The floor and the two walls that close the room, as a diorama: a slab you
 * can see the edge of, and walls that let the window's light through, so the
 * room is lit as if the glass were real.
 */
export function buildShell(room: Room): THREE.Group {
  const shell = new THREE.Group();
  const { width: w, depth: d, height: h } = room;
  const floor = room.floor ?? "wood";
  const base = hex(
    room.floorColor,
    floor === "carpet" ? 0x8c7b6b : floor === "tile" ? 0xe4ded2 : floor === "concrete" ? 0x9b9a95 : WOOD[0],
  );
  box(shell, w + 0.1, 0.12, d, floor === "wood" && !room.floorColor ? 0x7d5639 : tint(base, -0.35), -0.05, -0.06, 0);
  if (floor === "wood") {
    const planks = room.floorColor ? [base, tint(base, -0.08)] : WOOD;
    const plank = 0.3;
    const whole = Math.floor((w + 0.001) / plank);
    for (const k of [0, 1])
      tiles(
        shell,
        plank - 0.006,
        0.02,
        d - 0.004,
        planks[k],
        Array.from({ length: whole }, (_, i) => i)
          .filter((i) => i % 2 === k)
          .map((i) => [-w / 2 + (i + 0.5) * plank, 0.01, 0]),
      );
    // What is left at the right edge, narrower.
    const rest = w - whole * plank;
    if (rest > 0.01)
      box(shell, rest - 0.006, 0.02, d - 0.004, planks[whole % 2], w / 2 - rest / 2, 0.01, 0).castShadow = false;
  } else if (floor === "tile") {
    const size = 0.4;
    const cols = Math.ceil(w / size - 0.001);
    const rows = Math.ceil(d / size - 0.001);
    // Whole tiles in two colours, one mesh each; the part tiles along the right and front edges as boxes of their own.
    const whole: [number, number, number][][] = [[], []];
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const x = -w / 2 + i * size;
        const z = -d / 2 + j * size;
        const tw = Math.min(size, w / 2 - x);
        const td = Math.min(size, d / 2 - z);
        if (tw > size - 0.001 && td > size - 0.001) whole[(i + j) % 2].push([x + tw / 2, 0.01, z + td / 2]);
        else {
          const color = (i + j) % 2 ? base : tint(base, -0.08);
          box(shell, tw - 0.008, 0.02, td - 0.008, color, x + tw / 2, 0.01, z + td / 2).castShadow = false;
        }
      }
    tiles(shell, size - 0.008, 0.02, size - 0.008, tint(base, -0.08), whole[0]);
    tiles(shell, size - 0.008, 0.02, size - 0.008, base, whole[1]);
  } else {
    box(shell, w, 0.02, d, base, 0, 0.01, 0).castShadow = false;
  }
  const wall = hex(room.walls, WALL);
  const back = box(shell, w + 0.1, h, 0.1, wall, -0.05, h / 2, -d / 2 - 0.05);
  const left = box(shell, 0.1, h, d, wall, -w / 2 - 0.05, h / 2, 0);
  for (const panel of [back, left]) panel.castShadow = false;
  const skirting = tint(wall, -0.14);
  const backSkirting = box(shell, w, 0.09, 0.02, skirting, 0, 0.065, -d / 2 + 0.01);
  const leftSkirting = box(shell, 0.02, 0.09, d, skirting, -w / 2 + 0.01, 0.065, 0);
  for (const board of [backSkirting, leftSkirting]) board.castShadow = false;
  // Which wall each is, so it can fade when the camera goes round behind it; and which are the walls themselves.
  for (const part of [back, backSkirting]) part.userData.wall = "back";
  for (const part of [left, leftSkirting]) part.userData.wall = "left";
  for (const panel of [back, left]) panel.userData.panel = true;
  return shell;
}

/** What a built prop exposes: its group, and the material that glows, if any. */
export interface BuiltProp {
  group: THREE.Group;
  glow?: THREE.MeshStandardMaterial;
  /**
   * A face the stage draws on (a task board's tasks, a screen's page, a
   * calendar's day, a kiosk's button), the mesh showing it, to tell where a
   * click lands, and how big that is in metres: where live HTML is laid
   * over it once it is near enough to read (`surface-layer.ts`).
   */
  screen?: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; face: THREE.Mesh; size: [number, number] };
}

/** How a prop looks beyond its kind: the colour of its main part, and the basic shapes' size. */
export interface PropLook {
  color?: string;
  size?: [number, number, number];
  /** Words it shows, for a kiosk or a board. */
  label?: string;
  /** How much bigger it is drawn: a face drawn on is made sharper to match, so its words read as well up close. */
  scale?: number;
}

/** Pixels a metre of a screen's or a calendar's face is drawn at, before it is made bigger. */
const FACE_PX = 600;
/** How much sharper a face bigger than normal gets, at most: past this the texture costs more than it shows. */
const SHARPEST = 1.6;

/** How brightly a canvas face lights itself, so it reads at night; and a door's plate while the pointer is on it. */
const FACE_GLOW = 0.45;
const FACE_LIT = 1.1;

/** A canvas to draw on, and the texture that shows it, lit from within so it reads at night. */
function canvasFace(
  w: number,
  h: number,
  px: number,
): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; material: THREE.MeshStandardMaterial } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * px);
  canvas.height = Math.round(h * px);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: FACE_GLOW,
    roughness: 0.9,
  });
  return { canvas, texture, material };
}

/**
 * A widget's screen: dark glass of `face` metres in a slim rounded bezel,
 * centred `y` up, standing a hand's width off what it hangs on, with a small
 * light lit at its foot when given one. The page draws on the glass.
 */
function widgetScreen(
  g: THREE.Group,
  look: PropLook,
  face: [number, number],
  opts: { bezel: number; y: number; depth?: number; lit?: number },
): BuiltProp {
  const [w, h] = face;
  const depth = opts.depth ?? 0.05;
  const rim = Math.min(0.04, Math.max(0.025, h * 0.05));
  rounded(g, [w + rim * 2, h + rim * 2, depth], 0.016, satin(opts.bezel), [0, opts.y, depth / 2]);
  if (opts.lit !== undefined) {
    const lit = solid(
      new THREE.CircleGeometry(0.006, 10),
      glowing(opts.lit),
      w / 2 - 0.04,
      opts.y - h / 2 - rim / 2,
      depth + 0.0005,
    );
    (lit.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2;
    lit.castShadow = false;
    g.add(lit);
  }
  const drawn = canvasFace(w, h, FACE_PX * Math.min(SHARPEST, Math.max(1, look.scale ?? 1)));
  drawn.material.emissiveIntensity = 0.85;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), drawn.material);
  mesh.position.set(0, opts.y, depth + 0.001);
  g.add(mesh);
  return { group: g, screen: { canvas: drawn.canvas, texture: drawn.texture, face: mesh, size: [w, h] } };
}

/** A kiosk's screen: its label, large, on a dark glass. */
function drawKiosk(canvas: HTMLCanvasElement, label: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, "#26304a");
  g.addColorStop(1, "#151a2a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#7f9cff";
  ctx.font = `700 ${Math.round(canvas.height * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("+", canvas.width / 2, canvas.height * 0.34);
  ctx.fillStyle = "#eef1fa";
  ctx.font = `600 ${Math.round(canvas.height * 0.17)}px system-ui, sans-serif`;
  ctx.fillText(label, canvas.width / 2, canvas.height * 0.74, canvas.width * 0.9);
}

function legs(g: THREE.Group, w: number, d: number, h: number, color: number, thick = 0.04) {
  for (const [x, z] of [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [w / 2, d / 2],
  ])
    box(g, thick, h, thick, color, x, h / 2, z);
}

export function buildProp(kind: PropKind, look: PropLook = {}): BuiltProp {
  const g = new THREE.Group();
  const main = (fallback: number) => hex(look.color, fallback);
  switch (kind) {
    case "rug": {
      const edge = main(0xa5543a);
      box(g, 2.0, 0.012, 1.4, edge, 0, 0.026, 0).castShadow = false;
      box(g, 1.8, 0.014, 1.2, tint(edge, 0.55), 0, 0.028, 0).castShadow = false;
      box(g, 1.2, 0.016, 0.06, edge, 0, 0.03, -0.3).castShadow = false;
      box(g, 1.2, 0.016, 0.06, edge, 0, 0.03, 0.3).castShadow = false;
      return { group: g };
    }
    case "couch": {
      const fabric = main(0x5b7c99);
      const cushion = tint(fabric, 0.12);
      box(g, 1.6, 0.24, 0.8, fabric, 0, 0.22, 0);
      box(g, 0.74, 0.13, 0.6, cushion, -0.38, 0.4, 0.07);
      box(g, 0.74, 0.13, 0.6, cushion, 0.38, 0.4, 0.07);
      box(g, 1.6, 0.46, 0.2, fabric, 0, 0.56, -0.3);
      box(g, 0.16, 0.38, 0.8, fabric, -0.72, 0.4, 0);
      box(g, 0.16, 0.38, 0.8, fabric, 0.72, 0.4, 0);
      const pillow = box(g, 0.34, 0.3, 0.1, 0xe0a83a, -0.5, 0.6, -0.14);
      pillow.rotation.set(-0.2, 0.15, 0.12);
      for (const [x, z] of [
        [-0.72, -0.32],
        [0.72, -0.32],
        [-0.72, 0.32],
        [0.72, 0.32],
      ])
        box(g, 0.06, 0.1, 0.06, 0x3b2f2a, x, 0.05, z);
      return { group: g };
    }
    case "armchair": {
      const fabric = main(0xb0704a);
      box(g, 0.85, 0.22, 0.8, fabric, 0, 0.2, 0);
      box(g, 0.6, 0.12, 0.58, tint(fabric, 0.12), 0, 0.37, 0.06);
      box(g, 0.85, 0.5, 0.18, fabric, 0, 0.55, -0.31);
      box(g, 0.13, 0.32, 0.8, fabric, -0.36, 0.4, 0);
      box(g, 0.13, 0.32, 0.8, fabric, 0.36, 0.4, 0);
      legs(g, 0.72, 0.66, 0.09, 0x3b2f2a, 0.05);
      return { group: g };
    }
    case "beanbag": {
      const bag = solid(new THREE.IcosahedronGeometry(0.38, 1), paint(main(0x5b8fa8)), 0, 0.2, 0);
      bag.scale.set(1, 0.58, 1);
      g.add(bag);
      const dent = solid(new THREE.IcosahedronGeometry(0.24, 1), paint(tint(main(0x5b8fa8), 0.1)), 0, 0.33, -0.08);
      dent.scale.set(1, 0.45, 1);
      g.add(dent);
      return { group: g };
    }
    case "bed": {
      const wood = 0x8a5a3b;
      box(g, 1.4, 0.25, 2.0, wood, 0, 0.15, 0);
      box(g, 1.32, 0.16, 1.9, 0xf3f0ea, 0, 0.35, 0);
      box(g, 1.36, 0.07, 1.25, main(0x6a8caf), 0, 0.46, 0.33);
      box(g, 0.5, 0.1, 0.3, 0xffffff, -0.33, 0.48, -0.74);
      box(g, 0.5, 0.1, 0.3, 0xffffff, 0.33, 0.48, -0.74);
      box(g, 1.4, 0.9, 0.08, wood, 0, 0.45, -0.98);
      return { group: g };
    }
    case "lamp": {
      const metal = main(0x2f2f33);
      cylinder(g, 0.16, 0.18, 0.03, metal, 0, 0.015, 0, 14);
      cylinder(g, 0.014, 0.014, 1.42, metal, 0, 0.74, 0, 6);
      const shade = glowing(0xf3e3c3);
      shade.side = THREE.DoubleSide;
      const mesh = solid(new THREE.CylinderGeometry(0.14, 0.23, 0.3, 14, 1, true), shade, 0, 1.52, 0);
      mesh.castShadow = false;
      g.add(mesh);
      return { group: g, glow: shade };
    }
    case "desk": {
      const top = main(0x8a5a3b);
      box(g, 1.2, 0.04, 0.6, top, 0, 0.74, 0);
      for (const [x, z] of [
        [-0.56, -0.26],
        [0.56, -0.26],
        [-0.56, 0.26],
        [0.56, 0.26],
      ])
        box(g, 0.04, 0.72, 0.04, 0x3b2f2a, x, 0.36, z);
      box(g, 0.4, 0.16, 0.5, tint(top, -0.1), 0.36, 0.63, 0);
      box(g, 0.12, 0.02, 0.01, 0xd9c7a0, 0.36, 0.63, 0.255);
      return { group: g };
    }
    case "table": {
      const top = main(0xa87650);
      box(g, 1.2, 0.04, 0.8, top, 0, 0.73, 0);
      legs(g, 1.08, 0.68, 0.71, tint(top, -0.25), 0.05);
      return { group: g };
    }
    case "coffee_table": {
      const top = main(0x9a6b45);
      box(g, 1.0, 0.05, 0.55, top, 0, 0.395, 0);
      box(g, 0.9, 0.02, 0.45, tint(top, -0.1), 0, 0.12, 0);
      legs(g, 0.9, 0.45, 0.37, tint(top, -0.25), 0.045);
      return { group: g };
    }
    case "side_table": {
      const top = main(0x9a6b45);
      box(g, 0.45, 0.04, 0.45, top, 0, 0.53, 0);
      box(g, 0.38, 0.02, 0.38, tint(top, -0.1), 0, 0.2, 0);
      legs(g, 0.38, 0.38, 0.51, tint(top, -0.25), 0.035);
      return { group: g };
    }
    case "chair": {
      const seat = main(0x2f3a45);
      cylinder(g, 0.26, 0.26, 0.03, 0x2b2b30, 0, 0.04, 0, 5);
      cylinder(g, 0.03, 0.03, 0.4, 0x2b2b30, 0, 0.25, 0, 8);
      box(g, 0.46, 0.07, 0.46, seat, 0, 0.48, 0);
      box(g, 0.44, 0.5, 0.06, seat, 0, 0.8, -0.21);
      return { group: g };
    }
    case "bookshelf": {
      const wood = main(0x9a6b45);
      box(g, 0.03, 1.8, 0.32, wood, -0.43, 0.9, 0);
      box(g, 0.03, 1.8, 0.32, wood, 0.43, 0.9, 0);
      box(g, 0.86, 1.8, 0.02, tint(wood, -0.12), 0, 0.9, -0.15);
      const shelves = [0.015, 0.46, 0.91, 1.36, 1.785];
      for (const y of shelves) box(g, 0.86, 0.03, 0.32, wood, 0, y, 0);
      const colors = [0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2c14e, 0x8064a2, 0x4bacc6, 0xe07b39];
      // Rows of books, varied by a fixed sequence so the shelf looks lived in, and the same every load.
      let n = 0;
      for (let s = 0; s < shelves.length - 1; s++) {
        let x = -0.4;
        while (x < 0.36) {
          const bw = 0.035 + ((n * 37) % 5) * 0.008;
          const bh = 0.26 + ((n * 53) % 7) * 0.018;
          if ((n * 29) % 11 === 0) x += 0.06;
          else box(g, bw, bh, 0.22, colors[n % colors.length], x + bw / 2, shelves[s] + 0.015 + bh / 2, 0.02);
          x += bw + 0.004;
          n++;
        }
      }
      return { group: g };
    }
    case "tv": {
      const stand = main(0x4a3a30);
      box(g, 1.2, 0.5, 0.4, stand, 0, 0.25, 0);
      box(g, 0.5, 0.18, 0.02, tint(stand, -0.2), -0.28, 0.25, 0.2);
      box(g, 0.5, 0.18, 0.02, tint(stand, -0.2), 0.28, 0.25, 0.2);
      box(g, 0.12, 0.06, 0.12, 0x1d1f24, 0, 0.53, -0.05);
      box(g, 1.05, 0.6, 0.04, 0x1d1f24, 0, 0.86, -0.05);
      const screen = glowing(0x6fa8dc);
      const panel = solid(new THREE.BoxGeometry(0.98, 0.53, 0.004), screen, 0, 0.86, -0.028);
      panel.castShadow = false;
      g.add(panel);
      return { group: g, glow: screen };
    }
    case "fireplace": {
      const brick = main(0xa0533f);
      box(g, 1.3, 1.1, 0.45, brick, 0, 0.55, 0);
      box(g, 1.42, 0.06, 0.52, 0x6b4a33, 0, 1.12, 0.02);
      box(g, 0.72, 0.55, 0.06, 0x1a1414, 0, 0.33, 0.2);
      box(g, 0.9, 0.04, 0.2, tint(brick, -0.3), 0, 0.02, 0.32);
      cylinder(g, 0.04, 0.04, 0.5, 0x5e3a26, -0.05, 0.12, 0.16, 6).rotation.z = Math.PI / 2;
      const fire = glowing(0xff8a3d);
      for (const [x, y, r] of [
        [-0.1, 0.22, 0.09],
        [0.08, 0.2, 0.08],
        [0, 0.3, 0.06],
      ]) {
        const flame = solid(new THREE.ConeGeometry(r, r * 2.6, 5), fire, x, y, 0.16);
        flame.castShadow = false;
        g.add(flame);
      }
      return { group: g, glow: fire };
    }
    case "plant": {
      cylinder(g, 0.17, 0.12, 0.32, main(0xc56b3c), 0, 0.16, 0, 10);
      cylinder(g, 0.155, 0.155, 0.02, 0x4a3426, 0, 0.31, 0, 10);
      cylinder(g, 0.015, 0.02, 0.4, 0x5d7a3a, 0, 0.5, 0, 5);
      const leaves: [number, number, number, number, number][] = [
        [0, 0.78, 0, 0.24, 0x4c8c4a],
        [-0.14, 0.62, 0.06, 0.18, 0x5fa058],
        [0.13, 0.66, -0.05, 0.19, 0x3f7a3e],
        [0.04, 0.94, 0.08, 0.15, 0x6fb262],
      ];
      for (const [x, y, z, r, color] of leaves)
        g.add(solid(new THREE.IcosahedronGeometry(r, 0), paint(color), x, y, z));
      return { group: g };
    }
    case "small_plant": {
      cylinder(g, 0.08, 0.06, 0.12, main(0xd9c7a0), 0, 0.06, 0, 8);
      for (const [x, y, z, r, color] of [
        [0, 0.2, 0, 0.08, 0x4c8c4a],
        [-0.05, 0.16, 0.03, 0.06, 0x5fa058],
        [0.05, 0.17, -0.02, 0.06, 0x3f7a3e],
      ] as const)
        g.add(solid(new THREE.IcosahedronGeometry(r, 0), paint(color), x, y, z));
      return { group: g };
    }
    case "window": {
      const frame = main(0xf5f1ea);
      box(g, 1.2, 1.0, 0.05, frame, 0, 0.5, 0).castShadow = false;
      const glass = glowing(0xbfe3ff);
      const pane = solid(new THREE.BoxGeometry(1.08, 0.88, 0.02), glass, 0, 0.5, 0.02);
      pane.castShadow = false;
      g.add(pane);
      box(g, 0.04, 0.88, 0.03, frame, 0, 0.5, 0.035).castShadow = false;
      box(g, 1.08, 0.04, 0.03, frame, 0, 0.5, 0.035).castShadow = false;
      box(g, 1.3, 0.04, 0.14, frame, 0, -0.01, 0.05);
      return { group: g, glow: glass };
    }
    case "picture": {
      box(g, 0.9, 0.6, 0.04, main(0x3b2f2a), 0, 0.3, 0).castShadow = false;
      box(g, 0.82, 0.52, 0.01, 0xa9cbe0, 0, 0.3, 0.022).castShadow = false;
      box(g, 0.82, 0.2, 0.012, 0x6f9a5e, 0, 0.14, 0.024).castShadow = false;
      const sun = cylinder(g, 0.07, 0.07, 0.012, 0xf2c14e, 0.22, 0.42, 0.026, 16);
      sun.rotation.x = Math.PI / 2;
      sun.castShadow = false;
      return { group: g };
    }
    case "board": {
      // A whiteboard in a brushed aluminium frame, a tray of markers along its foot; the stage writes the tasks on it.
      rounded(g, [1.4, 0.9, 0.04], 0.012, satin(0xc3c8cf), [0, 0.45, 0]);
      const face = canvasFace(1.32, 0.82, 640);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.82), face.material);
      mesh.position.set(0, 0.45, 0.0215);
      g.add(mesh);
      rounded(g, [1.2, 0.03, 0.07], 0.01, satin(0xb3b9c1), [0, 0.0, 0.035]);
      for (const [i, color] of [0xd64545, 0x2f6fd6, 0x2e9e5b].entries()) {
        const marker = cylinder(g, 0.009, 0.009, 0.13, color, -0.42 + i * 0.16, 0.024, 0.04, 8);
        marker.rotation.z = Math.PI / 2;
        marker.castShadow = false;
      }
      return { group: g, screen: { canvas: face.canvas, texture: face.texture, face: mesh, size: [1.32, 0.82] } };
    }
    case "screen": {
      // A flat screen in a slim bezel, a hand's width off the wall, its light lit at the foot: the stage draws pages
      // on it.
      const sharp = Math.min(SHARPEST, Math.max(1, look.scale ?? 1));
      rounded(g, [1.6, 0.92, 0.05], 0.018, satin(main(0x16181d)), [0, 0.46, 0.025]);
      const lit = solid(new THREE.CircleGeometry(0.006, 10), glowing(0x7cf2a8), 0.74, 0.022, 0.0505);
      (lit.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2;
      lit.castShadow = false;
      g.add(lit);
      const face = canvasFace(1.52, 0.84, FACE_PX * sharp);
      // Lit from within more than paper is, as a screen is.
      face.material.emissiveIntensity = 0.85;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.52, 0.84), face.material);
      mesh.position.set(0, 0.46, 0.051);
      g.add(mesh);
      return { group: g, screen: { canvas: face.canvas, texture: face.texture, face: mesh, size: [1.52, 0.84] } };
    }
    case "calendar": {
      // A paper calendar on a stiff backing, its pages bound along the top with a row of rings.
      const sharp = Math.min(SHARPEST, Math.max(1, look.scale ?? 1));
      box(g, 1.0, 1.0, 0.016, main(0x6b4a33), 0, 0.5, 0.008).castShadow = false;
      const face = canvasFace(0.94, 0.9, FACE_PX * sharp);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.9), face.material);
      mesh.position.set(0, 0.47, 0.018);
      g.add(mesh);
      box(g, 0.96, 0.05, 0.012, 0x3a3f4b, 0, 0.955, 0.02).castShadow = false;
      for (let i = 0; i < 9; i++) {
        const ring = cylinder(g, 0.011, 0.011, 0.05, 0xc9ced6, -0.4 + i * 0.1, 0.955, 0.03, 6);
        ring.rotation.x = Math.PI / 2;
        ring.castShadow = false;
      }
      return { group: g, screen: { canvas: face.canvas, texture: face.texture, face: mesh, size: [0.94, 0.9] } };
    }
    case "kiosk": {
      box(g, 0.56, 0.06, 0.46, 0x3a3f4b, 0, 0.03, 0);
      box(g, 0.14, 0.9, 0.14, main(0x5b6475), 0, 0.5, -0.04);
      // A screen tipped back toward whoever walks up, its label lit.
      const face = canvasFace(0.56, 0.38, 520);
      drawKiosk(face.canvas, look.label ?? "");
      const screen = new THREE.Group();
      screen.position.set(0, 1.05, 0);
      screen.rotation.x = -0.55;
      const back = solid(new RoundedBoxGeometry(0.6, 0.42, 0.05, 2, 0.014), satin(0x22262f), 0, 0, -0.025);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.38), face.material);
      glass.position.z = 0.0015;
      screen.add(back, glass);
      g.add(screen);
      return { group: g, screen: { canvas: face.canvas, texture: face.texture, face: glass, size: [0.56, 0.38] } };
    }
    case "palm": {
      // A trunk of rings leaning a little, and fronds fanning out from the top.
      for (let i = 0; i < 6; i++) {
        const ring = cylinder(
          g,
          0.07 - i * 0.006,
          0.08 - i * 0.006,
          0.25,
          i % 2 ? 0x8a6a45 : 0x9b7a50,
          i * 0.025,
          0.125 + i * 0.24,
          0,
          7,
        );
        ring.rotation.z = -0.06;
      }
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const frond = solid(new THREE.BoxGeometry(0.75, 0.025, 0.2), paint(i % 2 ? 0x4f9a45 : 0x3f8a3a), 0, 0, 0);
        frond.position.set(0.15 + Math.cos(a) * 0.32, 1.6 - 0.08, Math.sin(a) * 0.32);
        frond.rotation.set(0, -a, -0.45);
        g.add(frond);
      }
      return { group: g };
    }
    case "umbrella": {
      cylinder(g, 0.2, 0.22, 0.06, 0x8f949c, 0, 0.03, 0, 12);
      cylinder(g, 0.022, 0.022, 1.95, 0xe6e2da, 0, 0.98, 0, 6);
      const canopy = solid(new THREE.ConeGeometry(0.75, 0.38, 10, 1, true), paint(main(0xe85d4a)), 0, 1.86, 0);
      (canopy.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      g.add(canopy);
      return { group: g };
    }
    case "clock": {
      const rim = cylinder(g, 0.18, 0.18, 0.04, main(0x3b2f2a), 0, 0.18, 0.02, 20);
      rim.rotation.x = Math.PI / 2;
      const face = cylinder(g, 0.155, 0.155, 0.01, 0xf6f1e3, 0, 0.18, 0.042, 20);
      face.rotation.x = Math.PI / 2;
      box(g, 0.012, 0.11, 0.006, 0x2a2a2e, 0, 0.225, 0.05);
      const minute = box(g, 0.01, 0.13, 0.006, 0x2a2a2e, 0.04, 0.2, 0.052);
      minute.rotation.z = -1.1;
      for (const o of [rim, face]) o.castShadow = false;
      return { group: g };
    }
    case "shelf": {
      const wood = main(0x9a6b45);
      box(g, 0.9, 0.04, 0.22, wood, 0, 0.03, 0.11);
      box(g, 0.03, 0.12, 0.16, tint(wood, -0.2), -0.36, -0.05, 0.08);
      box(g, 0.03, 0.12, 0.16, tint(wood, -0.2), 0.36, -0.05, 0.08);
      return { group: g };
    }
    case "laptop": {
      const body = main(0xc9ced6);
      box(g, 0.34, 0.018, 0.24, body, 0, 0.009, 0);
      const lid = new THREE.Group();
      lid.position.set(0, 0.018, -0.12);
      lid.rotation.x = -0.28;
      box(lid, 0.34, 0.22, 0.012, body, 0, 0.11, 0);
      const screen = glowing(0x9fd3ff);
      screen.emissiveIntensity = 0.6;
      const panel = solid(new THREE.BoxGeometry(0.31, 0.19, 0.002), screen, 0, 0.11, 0.007);
      panel.castShadow = false;
      lid.add(panel);
      g.add(lid);
      return { group: g };
    }
    case "books": {
      const colors = [main(0x4f81bd), 0xc0504d, 0x9bbb59];
      for (let i = 0; i < 3; i++) {
        const b = box(g, 0.22 - i * 0.02, 0.045, 0.16 - i * 0.01, colors[i], 0, 0.023 + i * 0.046, 0);
        b.rotation.y = [0.05, -0.12, 0.2][i];
      }
      return { group: g };
    }
    case "vase": {
      cylinder(g, 0.045, 0.06, 0.22, main(0x4f81bd), 0, 0.11, 0, 10);
      for (const [x, z, color] of [
        [0, 0, 0xe07b39],
        [-0.05, 0.03, 0xf2c14e],
        [0.05, -0.02, 0xe89ab0],
      ] as const) {
        cylinder(g, 0.005, 0.005, 0.16, 0x4c8c4a, x * 0.6, 0.29, z * 0.6, 4);
        g.add(solid(new THREE.IcosahedronGeometry(0.035, 0), paint(color), x, 0.38, z));
      }
      return { group: g };
    }
    case "mug": {
      const color = main(0xf5f3ef);
      cylinder(g, 0.04, 0.036, 0.09, color, 0, 0.045, 0, 12);
      box(g, 0.012, 0.05, 0.03, color, 0.046, 0.05, 0);
      return { group: g };
    }
    case "candle": {
      cylinder(g, 0.03, 0.03, 0.1, main(0xefe6d2), 0, 0.05, 0, 10);
      const flame = glowing(0xffb347);
      const tip = solid(new THREE.ConeGeometry(0.012, 0.04, 6), flame, 0, 0.125, 0);
      tip.castShadow = false;
      g.add(tip);
      return { group: g, glow: flame };
    }
    case "aquarium": {
      box(g, 0.6, 0.04, 0.3, 0x2a2a2e, 0, 0.02, 0);
      const water = new THREE.MeshStandardMaterial({
        color: main(0x7fc8e8),
        emissive: main(0x7fc8e8),
        emissiveIntensity: 0,
        transparent: true,
        opacity: 0.45,
        roughness: 0.2,
      });
      const tank = solid(new THREE.BoxGeometry(0.58, 0.32, 0.28), water, 0, 0.2, 0);
      tank.castShadow = false;
      g.add(tank);
      box(g, 0.6, 0.03, 0.3, 0x2a2a2e, 0, 0.375, 0);
      box(g, 0.05, 0.025, 0.012, 0xf08c3a, -0.1, 0.2, 0.02);
      box(g, 0.04, 0.02, 0.012, 0xf2c14e, 0.12, 0.14, -0.05);
      box(g, 0.5, 0.03, 0.2, 0xd9c7a0, 0, 0.055, 0);
      return { group: g, glow: water };
    }
    case "round_rug": {
      const edge = main(0x5a7f7f);
      for (const [r, y, color] of [
        [0.9, 0.026, edge],
        [0.8, 0.028, tint(edge, 0.5)],
        [0.42, 0.03, tint(edge, 0.15)],
      ] as const)
        cylinder(g, r, r, 0.012, color, 0, y, 0, 28).castShadow = false;
      return { group: g };
    }
    case "sideboard": {
      const wood = main(0x8a5a3b);
      box(g, 1.56, 0.62, 0.42, wood, 0, 0.45, 0);
      box(g, 1.64, 0.04, 0.46, tint(wood, -0.12), 0, 0.78, 0);
      // Three doors, picked out by their gaps, and a knob each.
      for (const x of [-0.52, 0, 0.52]) {
        box(g, 0.49, 0.54, 0.012, tint(wood, 0.08), x, 0.45, 0.212);
        box(g, 0.03, 0.03, 0.02, 0xd9c7a0, x + 0.18, 0.5, 0.222);
      }
      legs(g, 1.46, 0.34, 0.14, tint(wood, -0.3), 0.04);
      return { group: g };
    }
    case "round_table": {
      const top = main(0xa87650);
      cylinder(g, 0.6, 0.6, 0.045, top, 0, 0.73, 0, 24);
      cylinder(g, 0.05, 0.06, 0.7, tint(top, -0.3), 0, 0.36, 0, 8);
      cylinder(g, 0.3, 0.32, 0.04, tint(top, -0.3), 0, 0.02, 0, 16);
      return { group: g };
    }
    case "stool": {
      const seat = main(0x8a5a3b);
      cylinder(g, 0.2, 0.19, 0.05, seat, 0, 0.48, 0, 14);
      for (const a of [0, 2.09, 4.19]) {
        const leg = box(g, 0.035, 0.48, 0.035, tint(seat, -0.3), Math.sin(a) * 0.13, 0.23, Math.cos(a) * 0.13);
        leg.rotation.set(Math.cos(a) * 0.12, 0, -Math.sin(a) * 0.12);
      }
      cylinder(g, 0.135, 0.135, 0.02, tint(seat, -0.3), 0, 0.2, 0, 10);
      return { group: g };
    }
    case "easel": {
      const wood = 0xb08a5e;
      // Two front legs splayed, one behind, a ledge, and a canvas with paint on it, facing whoever stands in front.
      for (const side of [-1, 1]) {
        const leg = box(g, 0.04, 1.7, 0.04, wood, side * 0.22, 0.84, 0.08);
        leg.rotation.set(-0.1, 0, side * -0.1);
      }
      const rear = box(g, 0.04, 1.6, 0.04, wood, 0, 0.78, -0.22);
      rear.rotation.x = 0.26;
      box(g, 0.6, 0.04, 0.08, wood, 0, 0.72, 0.12);
      const canvas = new THREE.Group();
      canvas.position.set(0, 1.08, 0.1);
      canvas.rotation.x = -0.1;
      box(canvas, 0.62, 0.66, 0.025, 0xf6f1e3, 0, 0, 0);
      box(canvas, 0.3, 0.22, 0.004, main(0x4f81bd), -0.1, 0.12, 0.014);
      box(canvas, 0.22, 0.3, 0.004, 0xe6a23c, 0.12, -0.08, 0.015);
      const sun = cylinder(canvas, 0.07, 0.07, 0.004, 0xc0504d, 0.16, 0.18, 0.016, 12);
      sun.rotation.x = Math.PI / 2;
      g.add(canvas);
      return { group: g };
    }
    case "tall_plant": {
      cylinder(g, 0.22, 0.17, 0.42, main(0xd9c7a0), 0, 0.21, 0, 12);
      cylinder(g, 0.2, 0.2, 0.02, 0x4a3426, 0, 0.41, 0, 12);
      cylinder(g, 0.02, 0.03, 1.0, 0x6b4a33, 0, 0.9, 0, 5);
      // Broad leaves climbing the stem, each turned a little further round.
      for (let i = 0; i < 7; i++) {
        const a = i * 2.3;
        const y = 0.75 + i * 0.14;
        const r = 0.18 - i * 0.012;
        const leaf = solid(
          new THREE.IcosahedronGeometry(r, 0),
          paint(i % 2 ? 0x3f7a3e : 0x4c8c4a),
          Math.sin(a) * 0.14,
          y,
          Math.cos(a) * 0.14,
        );
        leaf.scale.set(1, 0.7, 1);
        g.add(leaf);
      }
      return { group: g };
    }
    case "cactus": {
      cylinder(g, 0.15, 0.12, 0.24, main(0xc56b3c), 0, 0.12, 0, 10);
      const green = 0x5f8f4a;
      cylinder(g, 0.08, 0.09, 0.6, green, 0, 0.53, 0, 8);
      cylinder(g, 0.08, 0.08, 0.02, green, 0, 0.84, 0, 8);
      for (const side of [-1, 1]) {
        cylinder(g, 0.045, 0.045, 0.14, green, side * 0.12, 0.5 + side * 0.06, 0, 6).rotation.z = Math.PI / 2;
        cylinder(g, 0.045, 0.045, 0.2, green, side * 0.18, 0.6 + side * 0.06, 0, 6);
      }
      return { group: g };
    }
    case "painting": {
      // An abstract canvas in a thin frame: blocks of colour round the picked one.
      const color = main(0xc0504d);
      box(g, 1.2, 0.8, 0.04, 0x2f2a26, 0, 0.4, 0).castShadow = false;
      box(g, 1.12, 0.72, 0.01, 0xf2ece0, 0, 0.4, 0.022).castShadow = false;
      for (const [w, h, x, y, c] of [
        [0.5, 0.42, -0.26, 0.48, color],
        [0.4, 0.26, 0.28, 0.24, tint(color, 0.45)],
        [0.3, 0.3, 0.32, 0.56, 0x3b4a5a],
        [0.6, 0.06, -0.2, 0.16, 0xd4a72c],
      ] as const)
        box(g, w, h, 0.006, c, x, y, 0.028).castShadow = false;
      return { group: g };
    }
    case "poster": {
      const color = main(0x4f81bd);
      box(g, 0.6, 0.85, 0.012, color, 0, 0.425, 0).castShadow = false;
      const ring = cylinder(g, 0.18, 0.18, 0.006, tint(color, 0.6), 0, 0.55, 0.01, 20);
      ring.rotation.x = Math.PI / 2;
      ring.castShadow = false;
      box(g, 0.44, 0.05, 0.006, 0xf6f1e3, 0, 0.22, 0.01).castShadow = false;
      box(g, 0.3, 0.03, 0.006, 0xf6f1e3, 0, 0.14, 0.01).castShadow = false;
      return { group: g };
    }
    case "pegboard": {
      box(g, 1.2, 0.75, 0.03, main(0xc8a27a), 0, 0.375, 0).castShadow = false;
      // A hammer, a wrench, a saw and a coil of tape, hung up.
      box(g, 0.03, 0.3, 0.03, 0x8a5a3b, -0.4, 0.38, 0.03);
      box(g, 0.14, 0.05, 0.04, 0x5f6f7f, -0.4, 0.52, 0.03);
      const wrench = box(g, 0.035, 0.32, 0.015, 0x9aa1ab, -0.12, 0.38, 0.03);
      wrench.rotation.z = 0.3;
      box(g, 0.38, 0.12, 0.008, 0xc0c4ca, 0.22, 0.48, 0.025);
      box(g, 0.1, 0.06, 0.03, 0xc0392b, 0.44, 0.48, 0.03);
      const tape = cylinder(g, 0.06, 0.06, 0.04, 0xf2c14e, 0.3, 0.2, 0.035, 12);
      tape.rotation.x = Math.PI / 2;
      return { group: g };
    }
    case "table_lamp": {
      cylinder(g, 0.08, 0.09, 0.03, main(0x3b4a5a), 0, 0.015, 0, 12);
      cylinder(g, 0.012, 0.012, 0.24, 0x2f2f33, 0, 0.15, 0, 6);
      const shade = glowing(0xf3e3c3);
      shade.side = THREE.DoubleSide;
      const mesh = solid(new THREE.CylinderGeometry(0.07, 0.11, 0.16, 12, 1, true), shade, 0, 0.34, 0);
      mesh.castShadow = false;
      g.add(mesh);
      return { group: g, glow: shade };
    }
    case "block": {
      const [w, h, d] = look.size ?? [0.5, 0.5, 0.5];
      box(g, w, h, d, main(0xc9a0dc), 0, h / 2, 0);
      return { group: g };
    }
    case "ball": {
      const [w, h, d] = look.size ?? [0.5, 0.5, 0.5];
      const ball = solid(new THREE.IcosahedronGeometry(0.5, 2), paint(main(0xe07b39)), 0, h / 2, 0);
      ball.scale.set(w, h, d);
      g.add(ball);
      return { group: g };
    }
    case "cylinder": {
      const [w, h, d] = look.size ?? [0.5, 0.5, 0.5];
      const c = cylinder(g, 0.5, 0.5, 1, main(0x4bacc6), 0, h / 2, 0, 16);
      c.scale.set(w, h, d);
      return { group: g };
    }
    case "bench": {
      // Three slats on two solid ends, the way a bench in a corridor is.
      const wood = main(0xa87650);
      for (const z of [-0.13, 0, 0.13]) box(g, 1.3, 0.045, 0.12, wood, 0, 0.44, z);
      for (const x of [-0.56, 0.56]) box(g, 0.07, 0.42, 0.38, tint(wood, -0.4), x, 0.21, 0);
      box(g, 1.05, 0.04, 0.05, tint(wood, -0.4), 0, 0.12, 0).castShadow = false;
      return { group: g };
    }
    case "globe": {
      // A globe on a wooden stand, tilted on its axis, in a brass half ring.
      const wood = main(0x6b4a33);
      cylinder(g, 0.17, 0.2, 0.04, wood, 0, 0.02, 0, 14);
      cylinder(g, 0.022, 0.03, 0.56, wood, 0, 0.3, 0, 8);
      const ball = new THREE.Group();
      ball.position.set(0, 0.8, 0);
      ball.rotation.z = 0.41;
      ball.add(solid(new THREE.IcosahedronGeometry(0.22, 2), paint(0x3f78b5), 0, 0, 0));
      // Land, a few flat patches on the sea.
      for (const [lat, lon, w, h, c] of [
        [0.5, 0.3, 0.11, 0.09, 0x8fae6b],
        [-0.3, 0.6, 0.08, 0.12, 0xc9b07a],
        [0.2, 2.2, 0.13, 0.1, 0x8fae6b],
        [-0.5, 2.9, 0.07, 0.07, 0xc9b07a],
        [0.7, 4.2, 0.12, 0.06, 0x8fae6b],
        [0.0, 5.0, 0.09, 0.11, 0xc9b07a],
      ] as const) {
        const at = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
        const land = solid(new THREE.IcosahedronGeometry(1, 0), paint(c), at.x * 0.2, at.y * 0.2, at.z * 0.2);
        land.lookAt(at.multiplyScalar(2));
        land.scale.set(w, h, 0.03);
        ball.add(land);
      }
      const ring = solid(new THREE.TorusGeometry(0.25, 0.01, 5, 20, Math.PI), paint(0xc9a24a), 0, 0, 0);
      ring.rotation.z = -Math.PI / 2;
      ball.add(ring);
      g.add(ball);
      return { group: g };
    }
    case "map": {
      // A framed map of the world: blue sea, the land in greens and sands, and a route pinned across it.
      box(g, 1.3, 0.85, 0.03, main(0x4a3426), 0, 0.425, 0).castShadow = false;
      box(g, 1.22, 0.77, 0.01, 0x9cc3d5, 0, 0.425, 0.017).castShadow = false;
      for (const [w, h, x, y, c] of [
        [0.3, 0.26, -0.38, 0.58, 0x8fae6b],
        [0.14, 0.24, -0.3, 0.3, 0xc9b07a],
        [0.22, 0.2, 0.02, 0.6, 0xc9b07a],
        [0.18, 0.26, 0.06, 0.32, 0x8fae6b],
        [0.32, 0.22, 0.36, 0.58, 0x8fae6b],
        [0.16, 0.1, 0.42, 0.2, 0xc9b07a],
      ] as const)
        box(g, w, h, 0.006, c, x, y, 0.024).castShadow = false;
      for (const [x, y] of [
        [-0.38, 0.6],
        [0.06, 0.36],
        [0.38, 0.55],
      ]) {
        const pin = cylinder(g, 0.016, 0.016, 0.02, 0xc0392b, x, y, 0.032, 8);
        pin.rotation.x = Math.PI / 2;
        pin.castShadow = false;
      }
      return { group: g };
    }
    case "mic_stand": {
      // A floor stand with a boom out front, and a studio microphone on it behind a pop filter.
      const metal = main(0x2f2f33);
      cylinder(g, 0.15, 0.17, 0.03, metal, 0, 0.015, 0, 14);
      cylinder(g, 0.013, 0.013, 1.25, metal, 0, 0.65, 0, 6);
      const boom = cylinder(g, 0.01, 0.01, 0.34, metal, 0, 1.33, 0.12, 6);
      boom.rotation.x = 1.0;
      const mic = new THREE.Group();
      mic.position.set(0, 1.42, 0.26);
      mic.rotation.x = 0.35;
      cylinder(mic, 0.032, 0.028, 0.13, 0x3a3a40, 0, 0, 0, 10);
      mic.add(solid(new THREE.IcosahedronGeometry(0.04, 1), paint(0xb8bcc4), 0, 0.08, 0));
      g.add(mic);
      const filter = cylinder(g, 0.075, 0.075, 0.006, 0x1f1f24, 0, 1.47, 0.36, 16);
      filter.rotation.x = Math.PI / 2 - 0.35;
      return { group: g };
    }
    case "server_rack": {
      // A tall black cabinet of servers, each with a row of lights that stay on day and night: lit as they are made,
      // since the time of day never dims them.
      const frame = main(0x23262c);
      box(g, 0.6, 1.9, 0.62, frame, 0, 0.95, 0);
      const leds = glowing(0x55e08a);
      const busy = glowing(0x5aa9ff);
      leds.emissiveIntensity = busy.emissiveIntensity = 1.2;
      for (let i = 0; i < 9; i++) {
        const y = 0.28 + i * 0.17;
        box(g, 0.52, 0.12, 0.012, tint(frame, i % 3 === 0 ? 0.18 : 0.1), 0, y, 0.312).castShadow = false;
        for (let k = 0; k < 3; k++) {
          const led = solid(
            new THREE.BoxGeometry(0.018, 0.018, 0.006),
            k === 2 && i % 2 ? busy : leds,
            -0.2 + k * 0.035,
            y,
            0.32,
          );
          led.castShadow = false;
          g.add(led);
        }
      }
      box(g, 0.56, 0.08, 0.6, tint(frame, -0.3), 0, 0.04, 0);
      return { group: g };
    }
    case "ledger": {
      // An open book of accounts: two pages with columns ruled in, and a pen across it.
      const cover = main(0x2f4f3f);
      box(g, 0.34, 0.02, 0.25, cover, 0, 0.01, 0);
      for (const side of [-1, 1]) {
        const page = box(g, 0.16, 0.012, 0.23, 0xf4efe1, side * 0.083, 0.026, 0);
        page.rotation.z = side * -0.05;
        for (let r = 0; r < 5; r++) box(g, 0.13, 0.002, 0.006, 0x8aa0b8, side * 0.083, 0.034, -0.08 + r * 0.04);
      }
      const pen = cylinder(g, 0.006, 0.006, 0.16, 0x1f1f24, 0.05, 0.04, 0.02, 6);
      pen.rotation.set(0, 0, Math.PI / 2);
      pen.rotation.y = 0.6;
      return { group: g };
    }
    case "chessboard": {
      // A board of light and dark squares, with a few pieces in play.
      box(g, 0.4, 0.025, 0.4, main(0x5a3a26), 0, 0.0125, 0);
      const squares = new THREE.InstancedMesh(new THREE.BoxGeometry(0.044, 0.004, 0.044), paint(0x3b2a20), 32);
      const m = new THREE.Matrix4();
      let n = 0;
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++)
          if ((r + c) % 2) squares.setMatrixAt(n++, m.makeTranslation(-0.154 + c * 0.044, 0.026, -0.154 + r * 0.044));
      g.add(squares);
      box(g, 0.352, 0.002, 0.352, 0xe9dcc0, 0, 0.0255, 0).castShadow = false;
      for (const [x, z, white, tall] of [
        [-0.11, -0.11, false, 0.06],
        [0.02, -0.07, false, 0.04],
        [0.07, 0.11, true, 0.06],
        [-0.02, 0.07, true, 0.04],
        [0.11, 0.02, true, 0.05],
      ] as const) {
        const color = white ? 0xf2ece0 : 0x2a2a2e;
        cylinder(g, 0.012, 0.016, tall, color, x, 0.028 + tall / 2, z, 8);
        g.add(solid(new THREE.IcosahedronGeometry(0.013, 0), paint(color), x, 0.03 + tall, z));
      }
      return { group: g };
    }
    // Widgets: screens and boards the page draws what the server keeps on (`WidgetFaces.tsx`), each its own shape.
    case "status_board":
      // A wide screen, a dot of green lit at its foot: who is doing what.
      return widgetScreen(g, look, FACE_SIZE.status, { bezel: main(0x16181d), y: 0.5, lit: 0x7cf2a8 });
    case "feed":
      // A tall screen, like a phone's feed hung on the wall.
      return widgetScreen(g, look, FACE_SIZE.feed, { bezel: main(0x16181d), y: 0.65, lit: 0x8ab4ff });
    case "needs_board":
      // A screen with an amber light at its foot, the colour of waiting on you.
      return widgetScreen(g, look, FACE_SIZE.needs, { bezel: main(0x1d1a16), y: 0.425, lit: 0xffb35c });
    case "chart":
      return widgetScreen(g, look, FACE_SIZE.chart, { bezel: main(0x16181d), y: 0.4, lit: 0x8ab4ff });
    case "agenda":
      return widgetScreen(g, look, FACE_SIZE.agenda, { bezel: main(0x16181d), y: 0.4 });
    case "ticker": {
      // A strip of dark glass in a deep housing, like a station's departure board.
      return widgetScreen(g, look, FACE_SIZE.ticker, { bezel: main(0x0f1115), y: 0.21, depth: 0.07 });
    }
    case "todo": {
      // A paper pad on a stiff backing, held at the top by a bulldog clip.
      const [w, h] = FACE_SIZE["my-tasks"];
      box(g, w + 0.06, h + 0.08, 0.018, main(0x8a6a4a), 0, (h + 0.08) / 2, 0.009).castShadow = false;
      const face = canvasFace(w, h, FACE_PX * Math.min(SHARPEST, Math.max(1, look.scale ?? 1)));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), face.material);
      mesh.position.set(0, h / 2 + 0.02, 0.0185);
      g.add(mesh);
      rounded(g, [0.2, 0.05, 0.03], 0.008, satin(0x9aa3ae), [0, h + 0.035, 0.028]);
      return { group: g, screen: { canvas: face.canvas, texture: face.texture, face: mesh, size: [w, h] } };
    }
    case "photo_wall": {
      // A corkboard in a wooden frame: the page pins the photos to it.
      const [w, h] = FACE_SIZE.photos;
      box(g, w + 0.08, h + 0.08, 0.03, main(0x7a5638), 0, (h + 0.08) / 2, 0.015).castShadow = false;
      const face = canvasFace(w, h, FACE_PX * Math.min(SHARPEST, Math.max(1, look.scale ?? 1)));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), face.material);
      mesh.position.set(0, (h + 0.08) / 2, 0.031);
      g.add(mesh);
      return { group: g, screen: { canvas: face.canvas, texture: face.texture, face: mesh, size: [w, h] } };
    }
    case "display": {
      // A screen on a stand, for the middle of a room: a weighted foot, a post, the screen tipped back a little.
      box(g, 0.7, 0.04, 0.45, 0x2b2f38, 0, 0.02, 0);
      cylinder(g, 0.035, 0.045, 1.08, satin(0x3a3f4b), 0, 0.6, -0.04, 12);
      const screen = new THREE.Group();
      screen.position.set(0, 1.36, 0);
      screen.rotation.x = -0.08;
      const built = widgetScreen(screen, look, [0.98, 0.6], { bezel: main(0x16181d), y: 0, depth: 0.05 });
      g.add(screen);
      return { group: g, ...(built.screen ? { screen: built.screen } : {}) };
    }
    case "monitor": {
      // A monitor on a desk: a round foot, a short neck, a slim screen.
      cylinder(g, 0.09, 0.1, 0.015, satin(0x2b2f38), 0, 0.0075, 0, 16);
      box(g, 0.04, 0.12, 0.025, 0x2b2f38, 0, 0.07, -0.02);
      const screen = new THREE.Group();
      screen.position.set(0, 0.27, 0);
      const built = widgetScreen(screen, look, [0.5, 0.29], { bezel: main(0x16181d), y: 0, depth: 0.025 });
      g.add(screen);
      return { group: g, ...(built.screen ? { screen: built.screen } : {}) };
    }
    case "cafe_table": {
      // A bistro table: a small round top on a slender stem and a cast foot.
      const top = main(0xe9e4da);
      cylinder(g, 0.36, 0.36, 0.03, top, 0, 0.735, 0, 24);
      cylinder(g, 0.37, 0.37, 0.012, tint(top, -0.25), 0, 0.716, 0, 24).castShadow = false;
      cylinder(g, 0.025, 0.03, 0.7, 0x2b2b30, 0, 0.36, 0, 8);
      cylinder(g, 0.22, 0.24, 0.025, 0x2b2b30, 0, 0.012, 0, 14);
      return { group: g };
    }
    case "cafe_chair": {
      // A bistro chair: thin dark legs, a round woven seat, and a hooped back.
      const seat = main(0xb4864f);
      const frame = 0x2b2b30;
      for (const [x, z] of [
        [-0.16, -0.16],
        [0.16, -0.16],
        [-0.16, 0.16],
        [0.16, 0.16],
      ])
        cylinder(g, 0.014, 0.014, 0.46, frame, x, 0.23, z, 6);
      cylinder(g, 0.21, 0.2, 0.04, seat, 0, 0.47, 0, 18);
      for (const x of [-0.17, 0.17]) cylinder(g, 0.013, 0.013, 0.4, frame, x, 0.68, -0.18, 6);
      const hoop = solid(new THREE.TorusGeometry(0.17, 0.016, 6, 18, Math.PI), paint(frame), 0, 0.86, -0.18);
      g.add(hoop);
      box(g, 0.32, 0.1, 0.02, seat, 0, 0.8, -0.18);
      return { group: g };
    }
    case "coffee_cart": {
      // A coffee cart: a counter on wheels, a striped awning on posts, a machine on top, and a menu board.
      const body = main(0x3c7d5a);
      box(g, 1.8, 0.95, 0.8, body, 0, 0.55, 0);
      box(g, 1.86, 0.05, 0.86, 0x7a5a3a, 0, 1.05, 0);
      for (const x of [-0.7, 0.7]) {
        const wheel = cylinder(g, 0.13, 0.13, 0.06, 0x2b2b30, x, 0.13, 0.42, 14);
        wheel.rotation.x = Math.PI / 2;
      }
      for (const x of [-0.86, 0.86]) cylinder(g, 0.02, 0.02, 1.3, 0xd8d4cc, x, 1.7, -0.36, 6);
      // The awning, in stripes, sloping down to the front.
      for (let i = 0; i < 6; i++) {
        const stripe = box(g, 0.32, 0.03, 1.0, i % 2 ? 0xf2efe6 : body, -0.8 + i * 0.32, 2.3, 0.05);
        stripe.rotation.x = 0.22;
      }
      box(g, 0.34, 0.42, 0.3, 0x8f949c, -0.45, 1.29, -0.15);
      box(g, 0.08, 0.05, 0.1, 0x2b2b30, -0.45, 1.2, 0.02);
      cylinder(g, 0.05, 0.04, 0.09, 0xf5f3ef, 0.1, 1.12, 0.1, 10);
      cylinder(g, 0.05, 0.04, 0.09, 0xf5f3ef, 0.24, 1.12, 0.05, 10);
      // The menu board on the front, the café's name over it.
      const face = canvasFace(1.1, 0.42, 420);
      drawPlate(face.canvas, "Café", "#2f2a26", "#f3e6cf");
      const menu = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.42), face.material);
      menu.position.set(0, 0.62, 0.405);
      g.add(menu);
      return { group: g };
    }
    case "whiteboard": {
      // A wide whiteboard in a light frame, with a tray of markers: the page writes what its room said last on it.
      rounded(g, [1.5, 1.0, 0.035], 0.01, satin(0xd5d9de), [0, 0.5, 0]);
      const face = canvasFace(1.44, 0.94, 640);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.44, 0.94), face.material);
      mesh.position.set(0, 0.5, 0.0185);
      g.add(mesh);
      rounded(g, [1.3, 0.03, 0.07], 0.01, satin(0xb3b9c1), [0, 0.0, 0.035]);
      for (const [i, color] of [0x2f6fd6, 0x2b2b30].entries()) {
        const marker = cylinder(g, 0.009, 0.009, 0.13, color, 0.3 + i * 0.16, 0.024, 0.04, 8);
        marker.rotation.z = Math.PI / 2;
        marker.castShadow = false;
      }
      return { group: g, screen: { canvas: face.canvas, texture: face.texture, face: mesh, size: [1.44, 0.94] } };
    }
    case "sign": {
      // A dark plate with its words lit, so it reads from across a hall.
      box(g, 1.44, 0.4, 0.03, 0x2a2e38, 0, 0.18, 0).castShadow = false;
      const face = canvasFace(1.36, 0.32, 420);
      drawPlate(face.canvas, look.label ?? "", "#2a2e38", "#f3efe6");
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.32), face.material);
      plate.position.set(0, 0.18, 0.017);
      g.add(plate);
      return { group: g };
    }
    case "model":
    case "wall_model":
    case "small_model":
      // A model an agent made is drawn from its parts (`buildModel` in `models.ts`), which the stage asks for.
      return { group: g };
  }
}

/**
 * Words on a plate, on a ground of their own: as large as fit on one line, or
 * on two when a long name reads better that way (`fitPlate`), and squeezed
 * only past the smallest worth drawing, never cut off.
 */
function drawPlate(canvas: HTMLCanvasElement, label: string, ground: string, ink: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const font = (size: number) => `600 ${size}px system-ui, sans-serif`;
  // Measured once at a large size, and scaled: the width of words grows with their size.
  ctx.font = font(100);
  const { lines, size } = fitPlate(label, (t) => ctx.measureText(t).width / 100, canvas.width, canvas.height);
  ctx.font = font(Math.floor(size));
  const step = size * 1.08;
  const top = canvas.height * 0.54 - ((lines.length - 1) * step) / 2;
  for (const [i, line] of lines.entries()) ctx.fillText(line, canvas.width / 2, top + i * step, canvas.width * 0.92);
}

/**
 * A door's panel and plate colours, by what it opens on: a home's warm wood, a meeting room's slate, glass out to
 * the street and into the town hall and the office. A home's plate is dark, so the light beside it shows in any of
 * its colours, amber too.
 */
const DOOR_LOOKS: Record<RoomDoor["kind"], { panel?: number; plate: string; ink: string }> = {
  home: { panel: 0x8a5a3b, plate: "#3a2a1f", ink: "#f2e4c4" },
  shared: { panel: 0x5f7f5a, plate: "#e4dcc6", ink: "#23301f" },
  room: { panel: 0x4f6278, plate: "#2f3a4a", ink: "#f3efe6" },
  town: { plate: "#24303f", ink: "#eef1fa" },
  lobby: { plate: "#24303f", ink: "#eef1fa" },
  office: { plate: "#24303f", ink: "#eef1fa" },
};

/** How tall a gate's posts are, at an open side of a room: about a hand above the waist. */
const GATE_POST = 1.12;

/** One shared see-through pane for glass doors: out to the street, into the town hall and the office. */
let glass: THREE.MeshStandardMaterial | undefined;

/**
 * A door, standing at its own origin with its back to the wall and its front
 * toward +Z. On a wall: a frame, a panel (glass out to the street and into the
 * town hall and the office), a name plate over it and a mat in front. At an open side of the room the wall
 * is cut away, so the door is too: a low gateway, two capped posts and a
 * rail across their tops with the plate hanging from it, readable from
 * either side, open to see through below it, that never stands between the
 * camera and the room. A gate at the open right side is seen almost edge on
 * from where the room is looked at, so it has a signpost too (`signpost`): its
 * nearer post goes up, with the plate again on top of it, turned to face the
 * front. A home's door has a light by its plate, and a lit strip along it,
 * that the stage colours by what its agent is doing. In a room lower than a
 * door and its plate (`height`), the door is made shorter to fit.
 */
export function buildDoor(
  door: Pick<RoomDoor, "label" | "kind" | "occupant">,
  opts: { freestanding: boolean; trim?: string; height: number; signpost?: boolean },
): {
  group: THREE.Group;
  light?: THREE.MeshBasicMaterial;
  highlight: (on: boolean) => void;
  /** A meeting room's door: what the card pinned on it says, or nothing for no card. */
  note?: (words: string | undefined) => void;
} {
  const g = new THREE.Group();
  const look = DOOR_LOOKS[door.kind] ?? DOOR_LOOKS.room;
  const trim = hex(opts.trim, 0xf2efe8);
  // How tall the frame is, under the plate and the top of the wall.
  const tall = Math.min(2.25, opts.height - 0.46);
  const k = tall / 2.25;
  // How high the plate is, and which faces of it can be seen.
  const plateY = opts.freestanding ? 0.82 : Math.min(2.5, opts.height - 0.2);
  const faces = opts.freestanding ? [1, -1] : [1];
  if (opts.freestanding) {
    // A gateway, open to walk through: two posts with caps, a rail across their tops, and the plate hanging from
    // the rail, so nothing but the plate is solid and below it you see straight through.
    for (const x of [-0.66, 0.66]) {
      box(g, 0.1, GATE_POST, 0.12, trim, x, GATE_POST / 2, 0.06);
      box(g, 0.15, 0.04, 0.17, tint(trim, -0.14), x, GATE_POST + 0.02, 0.06);
    }
    box(g, 1.22, 0.05, 0.07, trim, 0, GATE_POST - 0.045, 0.06);
    // What the plate hangs by.
    const rod = GATE_POST - 0.07 - (plateY + 0.16);
    for (const x of [-0.42, 0.42])
      box(g, 0.02, rod, 0.02, tint(trim, -0.3), x, plateY + 0.16 + rod / 2, 0.06).castShadow = false;
    // A sill across the opening, where the cut-away wall would meet the floor.
    box(g, 1.22, 0.03, 0.12, tint(trim, -0.2), 0, 0.015, 0.06).castShadow = false;
  } else {
    for (const x of [-0.66, 0.66]) box(g, 0.1, tall, 0.14, trim, x, tall / 2, 0.07);
    box(g, 1.42, 0.12, 0.14, trim, 0, tall - 0.01, 0.07);
    if (look.panel !== undefined) {
      box(g, 1.2, tall - 0.09, 0.05, look.panel, 0, (tall - 0.09) / 2, 0.06);
      // Two sunk panels and a handle, so it reads as a door and not a board.
      for (const y of [0.6, 1.55])
        box(g, 0.92, 0.7 * k, 0.012, tint(look.panel, -0.18), 0, y * k, 0.09).castShadow = false;
      cylinder(g, 0.035, 0.035, 0.08, 0xd4b264, 0.46, 1.02 * k, 0.12, 10).rotation.x = Math.PI / 2;
    } else {
      glass ??= new THREE.MeshStandardMaterial({
        color: 0xbcd6e8,
        transparent: true,
        opacity: 0.35,
        roughness: 0.15,
        metalness: 0.1,
        depthWrite: false,
      });
      const pane = new THREE.Mesh(new THREE.BoxGeometry(1.2, tall - 0.09, 0.03), glass);
      pane.position.set(0, (tall - 0.09) / 2, 0.06);
      g.add(pane);
      box(g, 1.2, 0.06, 0.05, trim, 0, 1.05 * k, 0.06);
    }
  }
  // The plate: a backing, and the words on each face that can be seen. A long name gets a wider plate, up to
  // what fits over the door, so it stays as easy to read as a short one; on a gate, what fits between its posts.
  const wide = Math.min(
    opts.freestanding ? 1.12 : 1.8,
    Math.max(opts.freestanding ? 0.9 : 1.1, 0.35 + 0.075 * door.label.length),
  );
  box(g, wide + 0.06, 0.32, 0.04, 0x2a2e38, 0, plateY, 0.06).castShadow = false;
  const face = canvasFace(wide, 0.27, 440);
  drawPlate(face.canvas, door.label, look.plate, look.ink);
  for (const side of faces) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(wide, 0.27), face.material);
    plate.position.set(0, plateY, 0.06 + side * 0.022);
    if (side < 0) plate.rotation.y = Math.PI;
    g.add(plate);
  }
  if (opts.freestanding && opts.signpost) {
    // The post on the gate's left (the front of the room, for a gate at the right side) goes up past the gate, and
    // the plate stands on it again, out into the room, facing the front and the back so it reads from the view in.
    const top = Math.min(1.95, opts.height - 0.25);
    // On up from the post's cap.
    const from = GATE_POST + 0.04;
    box(g, 0.08, top - from, 0.08, trim, 0.66, from + (top - from) / 2, 0.06);
    const sign = Math.min(1.1, wide);
    const at = 0.06 + 0.05 + sign / 2;
    box(g, 0.035, 0.31, sign + 0.04, 0x2a2e38, 0.66, top - 0.2, at).castShadow = false;
    const blade = canvasFace(sign, 0.27, 440);
    drawPlate(blade.canvas, door.label, look.plate, look.ink);
    for (const side of [1, -1]) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(sign, 0.27), blade.material);
      plate.position.set(0.66 + side * 0.019, top - 0.2, at);
      plate.rotation.y = (side * Math.PI) / 2;
      g.add(plate);
    }
  }
  // A mat in front, so a door is found by where it meets the floor as well.
  box(g, 1.3, 0.014, 0.55, 0x4a4038, 0, 0.007, 0.45).castShadow = false;
  // Lit up while the pointer is on it: a bright edge round the doorway and the mat, and the plate brighter.
  const edge = new THREE.MeshBasicMaterial({ color: 0xffd98a, toneMapped: false, transparent: true, opacity: 0.9 });
  const glow = new THREE.Group();
  const bar = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const mesh = solid(new THREE.BoxGeometry(w, h, d), edge, x, y, z);
    mesh.castShadow = false;
    glow.add(mesh);
  };
  const up = opts.freestanding ? GATE_POST : tall;
  const front = opts.freestanding ? 0.13 : 0.15;
  for (const x of [-0.6, 0.6]) bar(0.035, up, 0.02, x, up / 2, front);
  bar(1.235, 0.035, 0.02, 0, up, front);
  // The mat's outline, just above it.
  for (const z of [0.18, 0.72]) bar(1.3, 0.008, 0.03, 0, 0.018, z);
  for (const x of [-0.65, 0.65]) bar(0.03, 0.008, 0.57, x, 0.018, 0.45);
  glow.visible = false;
  g.add(glow);
  const highlight = (on: boolean) => {
    glow.visible = on;
    face.material.emissiveIntensity = on ? FACE_LIT : FACE_GLOW;
  };
  // On the panel at eye height, in front of its sunk panels; on a gate, under the plate, read from either side.
  const note =
    door.kind === "room"
      ? pinNote(g, opts.freestanding ? 0.62 : 1.45 * k, faces, (side) =>
          opts.freestanding ? 0.06 + side * 0.012 : 0.1,
        )
      : undefined;
  if (!door.occupant) return { group: g, highlight, ...(note ? { note } : {}) };
  // Drawn in its own colour, untouched by the lights or the tone mapping, so it stays that colour at night too.
  const light = new THREE.MeshBasicMaterial({ color: 0xe6eaf0, toneMapped: false });
  // A bulb beside the plate on a wall, on top of a gate's post seen from all round; and a strip along the plate,
  // under it on a wall and over it on a gate.
  const lit = [
    solid(
      new THREE.SphereGeometry(0.08, 14, 10),
      light,
      opts.freestanding ? -0.66 : -wide / 2 - 0.14,
      opts.freestanding ? GATE_POST + 0.12 : plateY,
      opts.freestanding ? 0.06 : 0.11,
    ),
    solid(
      new THREE.BoxGeometry(opts.freestanding ? 1.22 : wide + 0.06, 0.04, 0.05),
      light,
      0,
      opts.freestanding ? GATE_POST + 0.005 : plateY - 0.18,
      0.07,
    ),
  ];
  for (const mesh of lit) {
    mesh.castShadow = false;
    g.add(mesh);
  }
  return { group: g, light, highlight, ...(note ? { note } : {}) };
}

/**
 * A card pinned on a door at `y`, on each face given (`z` out from the door
 * for each), saying when its room last talked: written again each time it is
 * set, hidden with no words.
 */
function pinNote(
  g: THREE.Group,
  y: number,
  faces: number[],
  z: (side: number) => number,
): (words: string | undefined) => void {
  const face = canvasFace(0.82, 0.2, 520);
  const cards: THREE.Mesh[] = [];
  for (const side of faces) {
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.2), face.material);
    card.position.set(0, y, z(side));
    if (side < 0) card.rotation.y = Math.PI;
    card.visible = false;
    card.castShadow = false;
    g.add(card);
    cards.push(card);
  }
  let shown: string | undefined;
  return (words) => {
    if (words === shown) return;
    shown = words;
    for (const card of cards) card.visible = !!words;
    if (!words) return;
    drawPlate(face.canvas, words, "#f6f1e3", "#3a3328");
    face.texture.needsUpdate = true;
  };
}

/**
 * The plaque by a room's door, `width` by `height` metres, standing at its
 * own origin with its back to the wall and its face toward +Z: the room's
 * name on a dark plate in a brass rim, and under it a line saying what a
 * click on it opens. It lights up while the pointer is on it, as a door does.
 * `dispose` frees what is its own, for taking it down while the rest of the
 * room stays: its rim is painted in a colour other furniture shares.
 */
export function buildPlaque(
  name: string,
  width: number,
  height: number,
): { group: THREE.Group; highlight: (on: boolean) => void; dispose: () => void } {
  const g = new THREE.Group();
  const rim = box(g, width + 0.04, height + 0.04, 0.025, 0xb8935a, 0, 0, 0.0125);
  rim.castShadow = false;
  const face = canvasFace(width, height, 900);
  const ctx = face.canvas.getContext("2d");
  if (ctx) {
    const { width: w, height: h } = face.canvas;
    ctx.fillStyle = "#232833";
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f3e9d2";
    ctx.font = "600 100px system-ui, sans-serif";
    const { lines, size } = fitPlate(name, (t) => ctx.measureText(t).width / 100, w, h * 0.68);
    ctx.font = `600 ${Math.floor(size)}px system-ui, sans-serif`;
    const step = size * 1.08;
    const top = h * 0.4 - ((lines.length - 1) * step) / 2;
    for (const [i, line] of lines.entries()) ctx.fillText(line, w / 2, top + i * step, w * 0.92);
    ctx.fillStyle = "#c9b48a";
    ctx.font = `500 ${Math.round(h * 0.13)}px system-ui, sans-serif`;
    ctx.fillText("About this room", w / 2, h * 0.84);
  }
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(width, height), face.material);
  plate.position.z = 0.027;
  g.add(plate);
  const highlight = (on: boolean) => {
    face.material.emissiveIntensity = on ? FACE_LIT : FACE_GLOW;
  };
  const dispose = () => {
    rim.geometry.dispose();
    plate.geometry.dispose();
    face.material.map?.dispose();
    face.material.dispose();
  };
  return { group: g, highlight, dispose };
}

/**
 * Something small to hold, sized for a grown-up hand, built flat with its
 * face up (+Y) and its length along Z: the figure turns it to how it is held.
 * A camera is the exception, built as it is held, lens forward (+Z). Each has
 * materials of its own, so letting it go frees nothing the room still uses.
 */
export function buildHeld(kind: string): THREE.Group {
  const g = new THREE.Group();
  // A faint glow of its own colour, so it still reads in the shadow of a big head at night.
  const own = (color: number, glow = 0.12) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.7,
      flatShading: true,
      emissive: color,
      emissiveIntensity: glow,
    });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  const slab = (w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, glow = 0) =>
    add(new THREE.BoxGeometry(w, h, d), own(color, glow), x, y, z);
  switch (kind) {
    case "camera": {
      slab(0.13, 0.08, 0.06, 0x2b2d33);
      slab(0.035, 0.02, 0.03, 0x2b2d33, -0.035, 0.05, 0);
      const lens = add(new THREE.CylinderGeometry(0.028, 0.03, 0.05, 14), own(0x15161a), 0.01, 0, 0.05);
      lens.rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.018, 0.018, 0.005, 14), own(0x5b8fd6, 0.4), 0.01, 0, 0.077).rotation.x =
        Math.PI / 2;
      break;
    }
    case "phone":
      slab(0.07, 0.01, 0.145, 0x1d1f24);
      slab(0.062, 0.002, 0.13, 0x6fb3ff, 0, 0.006, 0, 0.6);
      break;
    case "laptop":
    case "tablet":
      slab(0.2, 0.012, 0.27, 0x3a3d45);
      slab(0.185, 0.002, 0.25, 0x9fd0ff, 0, 0.007, 0, 0.5);
      break;
    case "book": {
      // Open: two pages in a shallow V on a coloured cover.
      slab(0.3, 0.012, 0.22, 0xb5523b);
      for (const side of [-1, 1]) {
        const page = slab(0.14, 0.012, 0.2, 0xf4efe2, side * 0.072, 0.014, 0);
        page.rotation.z = side * -0.12;
      }
      break;
    }
    case "notebook":
      slab(0.16, 0.014, 0.22, 0x3e6e8e);
      slab(0.15, 0.003, 0.21, 0xfaf7ee, 0, 0.009, 0);
      for (let i = 0; i < 6; i++) slab(0.012, 0.016, 0.012, 0xb8bcc4, -0.078, 0.004, -0.09 + i * 0.036);
      break;
    case "clipboard":
      slab(0.2, 0.01, 0.28, 0xa8794f);
      slab(0.18, 0.003, 0.24, 0xfbfbf7, 0, 0.007, 0.012);
      slab(0.08, 0.02, 0.03, 0xb0b4bb, 0, 0.012, -0.125);
      break;
    case "folder":
      slab(0.22, 0.016, 0.3, 0xe2b94f);
      slab(0.08, 0.016, 0.03, 0xe2b94f, -0.06, 0, -0.16);
      break;
    case "letter":
      slab(0.2, 0.006, 0.12, 0xf6f1e4);
      slab(0.03, 0.008, 0.03, 0xc0392b, 0, 0.004, 0);
      break;
    case "clock": {
      const face = add(new THREE.CylinderGeometry(0.06, 0.06, 0.035, 18), own(0xd9534f), 0, 0, 0);
      face.rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.004, 18), own(0xfdfaf2), 0, 0, 0.019).rotation.x = Math.PI / 2;
      for (const x of [-0.035, 0.035]) add(new THREE.SphereGeometry(0.02, 8, 6), own(0xd9534f), x, 0.06, 0);
      // Flat, like the rest: lying with its face up.
      g.rotation.x = -Math.PI / 2;
      const flat = new THREE.Group();
      flat.add(g);
      return flat;
    }
    case "microphone":
      add(new THREE.CylinderGeometry(0.014, 0.011, 0.14, 10), own(0x2b2d33), 0, 0, 0).rotation.x = Math.PI / 2;
      add(new THREE.SphereGeometry(0.03, 12, 8), own(0x9aa0a8), 0, 0, 0.085);
      break;
    case "mug": {
      // Upright in the hand, its handle out to the side.
      add(new THREE.CylinderGeometry(0.042, 0.036, 0.095, 14), own(0xe9e4da), 0, 0.045, 0);
      add(new THREE.CylinderGeometry(0.036, 0.036, 0.004, 14), own(0x5a3a22), 0, 0.091, 0);
      const handle = add(new THREE.TorusGeometry(0.024, 0.007, 6, 12), own(0xe9e4da), 0.05, 0.048, 0);
      handle.rotation.y = Math.PI / 2;
      break;
    }
    case "watering_can": {
      // Held out ahead: the can at the hand, its spout reaching on and up, so tipped forward it pours.
      add(new THREE.CylinderGeometry(0.065, 0.07, 0.12, 14), own(0x3f8f5a), 0, -0.03, 0.05);
      const spout = add(new THREE.CylinderGeometry(0.009, 0.014, 0.16, 8), own(0x3f8f5a), 0, 0.0, 0.16);
      spout.rotation.x = Math.PI / 2 - 0.55;
      add(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 10), own(0xb8bcc4), 0, 0.045, 0.225).rotation.x =
        Math.PI / 2 - 0.55;
      const grip = add(new THREE.TorusGeometry(0.04, 0.008, 6, 14, Math.PI), own(0x2f6e45), 0, 0.03, 0.02);
      grip.rotation.y = Math.PI / 2;
      break;
    }
    case "magnifier": {
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.11, 8), own(0x6b4a2f), 0, 0, -0.03).rotation.x = Math.PI / 2;
      const ring = add(new THREE.TorusGeometry(0.05, 0.008, 6, 20), own(0xc9a227), 0, 0, 0.075);
      ring.rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.045, 0.045, 0.004, 20), own(0xcfe8ff, 0.15), 0, 0, 0.075);
      break;
    }
    default:
      return g;
  }
  return g;
}

/** Free a held thing's own geometry and materials. */
export function disposeHeld(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) for (const x of m) x.dispose();
    else m?.dispose();
  });
}

/** Free every geometry and material under `root`, the pictures drawn for boards and kiosks, and floors' instances. */
export function disposeTree(root: THREE.Object3D) {
  const free = (m: THREE.Material) => {
    (m as THREE.MeshStandardMaterial).map?.dispose();
    m.dispose();
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // A floor's instances keep a buffer of their own, freed only with the mesh.
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    mesh.geometry?.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) for (const x of m) free(x);
    else if (m) free(m);
  });
  materials.clear();
  glass = undefined;
  // Models agents made share their materials the same way.
  forgetModels();
}
