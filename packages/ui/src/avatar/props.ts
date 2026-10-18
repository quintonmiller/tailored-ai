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

/**
 * The floor and the two walls that close the room, as a diorama: a slab you
 * can see the edge of, and walls that let the window's light through, so the
 * room is lit as if the glass were real.
 */
export function buildShell(room: Room): THREE.Group {
  const shell = new THREE.Group();
  const { width: w, depth: d, height: h } = room;
  box(shell, w + 0.1, 0.12, d, 0x7d5639, -0.05, -0.06, 0);
  const plank = 0.3;
  for (let i = 0, x = -w / 2; x < w / 2 - 0.01; i++, x += plank) {
    const pw = Math.min(plank, w / 2 - x);
    box(shell, pw - 0.006, 0.02, d - 0.004, WOOD[i % 2], x + pw / 2, 0.01, 0).castShadow = false;
  }
  const back = box(shell, w + 0.1, h, 0.1, WALL, -0.05, h / 2, -d / 2 - 0.05);
  const left = box(shell, 0.1, h, d, WALL, -w / 2 - 0.05, h / 2, 0);
  for (const wall of [back, left]) wall.castShadow = false;
  box(shell, w, 0.09, 0.02, 0xcdbfa9, 0, 0.065, -d / 2 + 0.01).castShadow = false;
  box(shell, 0.02, 0.09, d, 0xcdbfa9, -w / 2 + 0.01, 0.065, 0).castShadow = false;
  return shell;
}

/** What a built prop exposes: its group, and the material that glows when lit, if any. */
export interface BuiltProp {
  group: THREE.Group;
  glow?: THREE.MeshStandardMaterial;
}

export function buildProp(kind: PropKind): BuiltProp {
  const g = new THREE.Group();
  switch (kind) {
    case "rug": {
      box(g, 2.0, 0.012, 1.4, 0xa5543a, 0, 0.026, 0).castShadow = false;
      box(g, 1.8, 0.014, 1.2, 0xd2b07a, 0, 0.028, 0).castShadow = false;
      box(g, 1.2, 0.016, 0.06, 0xa5543a, 0, 0.03, -0.3).castShadow = false;
      box(g, 1.2, 0.016, 0.06, 0xa5543a, 0, 0.03, 0.3).castShadow = false;
      return { group: g };
    }
    case "couch": {
      const fabric = 0x5b7c99;
      box(g, 1.6, 0.24, 0.8, fabric, 0, 0.22, 0);
      box(g, 0.74, 0.13, 0.6, 0x6d8eab, -0.38, 0.4, 0.07);
      box(g, 0.74, 0.13, 0.6, 0x6d8eab, 0.38, 0.4, 0.07);
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
    case "lamp": {
      cylinder(g, 0.16, 0.18, 0.03, 0x2f2f33, 0, 0.015, 0, 14);
      cylinder(g, 0.014, 0.014, 1.42, 0x2f2f33, 0, 0.74, 0, 6);
      const shade = glowing(0xf3e3c3);
      shade.side = THREE.DoubleSide;
      const mesh = solid(new THREE.CylinderGeometry(0.14, 0.23, 0.3, 14, 1, true), shade, 0, 1.52, 0);
      mesh.castShadow = false;
      g.add(mesh);
      return { group: g, glow: shade };
    }
    case "desk": {
      box(g, 1.2, 0.04, 0.6, 0x8a5a3b, 0, 0.74, 0);
      for (const [x, z] of [
        [-0.56, -0.26],
        [0.56, -0.26],
        [-0.56, 0.26],
        [0.56, 0.26],
      ])
        box(g, 0.04, 0.72, 0.04, 0x3b2f2a, x, 0.36, z);
      box(g, 0.4, 0.16, 0.5, 0x7a4e33, 0.36, 0.63, 0);
      box(g, 0.12, 0.02, 0.01, 0xd9c7a0, 0.36, 0.63, 0.255);
      return { group: g };
    }
    case "laptop": {
      box(g, 0.34, 0.018, 0.24, 0xc9ced6, 0, 0.009, 0);
      const lid = new THREE.Group();
      lid.position.set(0, 0.018, -0.12);
      lid.rotation.x = -0.28;
      box(lid, 0.34, 0.22, 0.012, 0xc9ced6, 0, 0.11, 0);
      const screen = glowing(0x9fd3ff);
      screen.emissiveIntensity = 0.6;
      const panel = solid(new THREE.BoxGeometry(0.31, 0.19, 0.002), screen, 0, 0.11, 0.007);
      panel.castShadow = false;
      lid.add(panel);
      g.add(lid);
      return { group: g };
    }
    case "chair": {
      cylinder(g, 0.26, 0.26, 0.03, 0x2b2b30, 0, 0.04, 0, 5);
      cylinder(g, 0.03, 0.03, 0.4, 0x2b2b30, 0, 0.25, 0, 8);
      box(g, 0.46, 0.07, 0.46, 0x2f3a45, 0, 0.48, 0);
      box(g, 0.44, 0.5, 0.06, 0x2f3a45, 0, 0.8, -0.21);
      return { group: g };
    }
    case "bookshelf": {
      const wood = 0x9a6b45;
      box(g, 0.03, 1.8, 0.32, wood, -0.43, 0.9, 0);
      box(g, 0.03, 1.8, 0.32, wood, 0.43, 0.9, 0);
      box(g, 0.86, 1.8, 0.02, 0x86593a, 0, 0.9, -0.15);
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
    case "plant": {
      cylinder(g, 0.17, 0.12, 0.32, 0xc56b3c, 0, 0.16, 0, 10);
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
    case "window": {
      const frame = 0xf5f1ea;
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
      box(g, 0.9, 0.6, 0.04, 0x3b2f2a, 0, 0.3, 0).castShadow = false;
      box(g, 0.82, 0.52, 0.01, 0xa9cbe0, 0, 0.3, 0.022).castShadow = false;
      box(g, 0.82, 0.2, 0.012, 0x6f9a5e, 0, 0.14, 0.024).castShadow = false;
      const sun = cylinder(g, 0.07, 0.07, 0.012, 0xf2c14e, 0.22, 0.42, 0.026, 16);
      sun.rotation.x = Math.PI / 2;
      sun.castShadow = false;
      return { group: g };
    }
  }
}

/** Free every geometry and material under `root`. */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) for (const x of m) x.dispose();
    else m?.dispose();
  });
  materials.clear();
}
