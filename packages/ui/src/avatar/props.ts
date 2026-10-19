/**
 * The room's shell and furniture, built from boxes and cylinders with flat
 * shading: no model files to ship or licence, and the same low-poly look as
 * most VRM avatars. Each builder returns a group standing on the floor at its
 * own origin, front toward +Z; the stage places and turns it.
 */
import * as THREE from "three";
import type { PropKind, Room } from "./scene";

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
  box(shell, w, 0.09, 0.02, skirting, 0, 0.065, -d / 2 + 0.01).castShadow = false;
  box(shell, 0.02, 0.09, d, skirting, -w / 2 + 0.01, 0.065, 0).castShadow = false;
  return shell;
}

/** What a built prop exposes: its group, and the material that glows, if any. */
export interface BuiltProp {
  group: THREE.Group;
  glow?: THREE.MeshStandardMaterial;
  /** A face the stage draws on: a task board's tasks. */
  screen?: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
}

/** How a prop looks beyond its kind: the colour of its main part, and the basic shapes' size. */
export interface PropLook {
  color?: string;
  size?: [number, number, number];
  /** Words it shows, for a kiosk or a board. */
  label?: string;
}

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
    emissiveIntensity: 0.45,
    roughness: 0.9,
  });
  return { canvas, texture, material };
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
      // A whiteboard in an aluminium frame; the stage writes the tasks on it.
      box(g, 1.4, 0.9, 0.04, 0x9aa1ab, 0, 0.45, 0).castShadow = false;
      const face = canvasFace(1.32, 0.82, 640);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.82), face.material);
      mesh.position.set(0, 0.45, 0.022);
      g.add(mesh);
      box(g, 1.2, 0.03, 0.06, 0x9aa1ab, 0, 0.0, 0.03).castShadow = false;
      return { group: g, screen: { canvas: face.canvas, texture: face.texture } };
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
      const back = solid(new THREE.BoxGeometry(0.6, 0.42, 0.05), paint(0x2a2e38), 0, 0, -0.03);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.38), face.material);
      glass.position.z = 0.0;
      screen.add(back, glass);
      g.add(screen);
      return { group: g };
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
  }
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
}
