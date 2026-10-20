/**
 * The town outdoors, built for the stage from the plan (see `town.ts`): the
 * ground, the roads and the square with its fountain, the stream and its
 * bridges, the sand and the sea, the park's pond, every building, the woods
 * round the town, street lamps, fences round the plots, street signs, and a
 * sky with the sun, or the moon and the stars.
 *
 * Built for the frame rate, as a big room would be: each building is one
 * mesh of flat-shaded boxes in its own colours, with its windows a second
 * mesh, so a street of houses is a handful of draws rather than hundreds, and
 * each can still fade on its own when it stands between the camera and you.
 * The roads, the ground, the trees and the lamps are one draw each, whatever
 * the size of the town.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AgentActivity } from "./doing";
import type { Obstacle } from "./locomotion";
import type { Solid } from "./sight";
import {
  type Feature,
  featuresFor,
  footprintBox,
  houseLook,
  lightFrom,
  outsideDoor,
  ribbon,
  skyFor,
  type TownBuilding,
  type TownPlan,
  type WindowLook,
  waterObstacles,
  windowLook,
} from "./town";

type V3 = [number, number, number];

/** Geometry gathered piece by piece, each piece in a colour, and merged into one. */
class Parts {
  readonly list: THREE.BufferGeometry[] = [];
  constructor(private readonly frame = new THREE.Matrix4()) {}

  /** Add a shape, coloured, moved to `at` and turned `turn` radians about Y (and `tilt` about X) in this frame. */
  add(geometry: THREE.BufferGeometry, color: number, at: V3, turn = 0, tilt = 0, scale?: V3) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    g.deleteAttribute("uv");
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...at),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, turn, 0, "YXZ")),
      new THREE.Vector3(...(scale ?? [1, 1, 1])),
    );
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(this.frame, m));
    const c = new THREE.Color(color);
    const n = g.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.list.push(g);
    return this;
  }

  box(w: number, h: number, d: number, color: number, at: V3, turn = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d), color, at, turn);
  }

  /** One geometry of everything added, or none when nothing was. */
  merged(): THREE.BufferGeometry | undefined {
    if (!this.list.length) return undefined;
    const g = mergeGeometries(this.list, false);
    for (const p of this.list) p.dispose();
    this.list.length = 0;
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** A gable roof's two slopes: `w` along the ridge, `d` across, `h` tall, its eaves at y 0. */
function slopes(w: number, d: number, h: number): THREE.BufferGeometry {
  const [x, z] = [w / 2, d / 2];
  // Two quads, each two triangles, wound to face out.
  const v = [
    [-x, 0, z, x, 0, z, x, h, 0, -x, 0, z, x, h, 0, -x, h, 0],
    [x, 0, -z, -x, 0, -z, -x, h, 0, x, 0, -z, -x, h, 0, x, h, 0],
  ].flat();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** A gable's triangle, the wall up under the roof at either end: `d` wide, `h` tall, facing ±X. */
function gables(w: number, d: number, h: number): THREE.BufferGeometry {
  const [x, z] = [w / 2, d / 2];
  const v = [x, 0, z, x, 0, -z, x, h, 0, -x, 0, -z, -x, 0, z, -x, h, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** A roof come to a point: four sides, `w` by `d` at the eaves, `h` tall. */
function pyramid(w: number, d: number, h: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  g.scale(w, h, d);
  g.translate(0, h / 2, 0);
  return g;
}

const STONE = 0x9a948a;
const FRAME = 0xf2efe8;
const BRICK = 0x8a4a3a;
const WOOD = 0x8a5a3b;
const DARK = 0x3a3f47;
const HEDGE = 0x4a7a3c;
const PATH = 0xc9c0ae;

/** What is built for one building: its mesh, its windows', its outline for walking round and fading, and the point to walk to by its door. */
export interface BuiltBuilding {
  building: TownBuilding;
  group: THREE.Group;
  glass: THREE.MeshLambertMaterial;
  obstacles: Obstacle[];
  solid: Solid;
  approach: [number, number];
  look?: WindowLook;
}

/** Window glass for each look: the sky in it by day, a warm light on inside, or dark. */
const GLASS: Record<WindowLook, { color: number; emissive: number; glow: number }> = {
  day: { color: 0x9ec4dc, emissive: 0xbfe3ff, glow: 0.25 },
  lit: { color: 0xffd38a, emissive: 0xffc56e, glow: 1.15 },
  dark: { color: 0x1f2a40, emissive: 0x2b3a66, glow: 0.12 },
};

/** Put a window's look on its glass. */
function paintGlass(glass: THREE.MeshLambertMaterial, look: WindowLook) {
  const g = GLASS[look];
  glass.color.setHex(g.color);
  glass.emissive.setHex(g.emissive);
  glass.emissiveIntensity = g.glow;
}

/** One window on a wall, its middle at `at` in the building's frame, facing `turn`: a frame, a sill, the glass, and shutters if asked. */
function windowAt(body: Parts, glass: Parts, at: V3, turn: number, w = 0.9, h = 0.95, shutters?: number) {
  const out = (k: number): V3 => [at[0] + Math.sin(turn) * k, at[1], at[2] + Math.cos(turn) * k];
  body.add(new THREE.BoxGeometry(w + 0.14, h + 0.14, 0.06), FRAME, out(0.02), turn);
  body.add(
    new THREE.BoxGeometry(w + 0.24, 0.07, 0.18),
    FRAME,
    [...out(0.07)].map((v, i) => (i === 1 ? v - h / 2 - 0.07 : v)) as V3,
    turn,
  );
  glass.add(new THREE.BoxGeometry(w, h, 0.04), 0xffffff, out(0.05), turn);
  if (shutters !== undefined)
    for (const side of [-1, 1]) {
      const across: V3 = [Math.cos(turn) * side * (w / 2 + 0.2), 0, -Math.sin(turn) * side * (w / 2 + 0.2)];
      const p = out(0.04);
      body.add(new THREE.BoxGeometry(0.3, h + 0.1, 0.04), shutters, [p[0] + across[0], p[1], p[2] + across[2]], turn);
    }
}

/** A house: its walls in its owner's colour, its roof, its windows, a front garden with a path, and what its owner does. */
function house(body: Parts, glass: Parts, lights: Parts, b: TownBuilding) {
  const [w, d, wall] = b.size;
  const look = houseLook(b.owner, b.style);
  const tall = wall * look.storeys - (look.storeys > 1 ? 0.4 : 0);
  body.box(w + 0.18, 0.3, d + 0.18, STONE, [0, 0.15, 0]);
  body.box(w, tall, d, look.walls, [0, tall / 2, 0]);
  for (const [x, z] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    body.box(0.16, tall, 0.16, FRAME, [(x * w) / 2, tall / 2, (z * d) / 2]);
  if (look.storeys > 1) body.box(w + 0.08, 0.14, d + 0.08, look.trim, [0, wall - 0.2, 0]);
  // The roof, over the eaves.
  const [rw, rd] = [w + 0.55, d + 0.6];
  if (look.roof === "hip") body.add(pyramid(rw * 1.08, rd * 1.08, 1.5), look.roofColor, [0, tall, 0]);
  else {
    const turn = look.roof === "front-gable" ? Math.PI / 2 : 0;
    const [along, across] = look.roof === "front-gable" ? [rd, rw] : [rw, rd];
    body.add(slopes(along, across, 1.7), look.roofColor, [0, tall, 0], turn);
    body.add(gables(along - 0.56, across - 0.6, 1.62), look.walls, [0, tall, 0], turn);
  }
  if (look.chimney) {
    body.box(0.5, 1.6, 0.5, BRICK, [w * 0.28, tall + 0.9, -d * 0.18]);
    body.box(0.62, 0.1, 0.62, DARK, [w * 0.28, tall + 1.72, -d * 0.18]);
  }
  // Windows either side of the door, round the sides and the back; upstairs too.
  for (const x of [-(w / 2 - 1.05), w / 2 - 1.05]) windowAt(body, glass, [x, 1.55, d / 2], 0, 0.9, 0.95, look.trim);
  for (const side of [-1, 1]) windowAt(body, glass, [(side * w) / 2, 1.55, 0], (side * Math.PI) / 2, 0.85, 0.9);
  for (const x of [-1.2, 1.2]) windowAt(body, glass, [x, 1.55, -d / 2], Math.PI, 0.85, 0.9);
  if (look.storeys > 1)
    for (const x of [-1.4, 0, 1.4]) windowAt(body, glass, [x, wall + 1.1, d / 2], 0, 0.8, 0.85, look.trim);
  // The front garden: a path to the door between low hedges, and a letterbox in the owner's colour.
  body.box(1.2, 0.03, 2, PATH, [0, 0.015, d / 2 + 1]);
  for (const side of [-1, 1]) body.box(w / 2 - 0.85, 0.55, 0.38, HEDGE, [side * (w / 4 + 0.42), 0.275, d / 2 + 1.75]);
  body.box(0.08, 1.05, 0.08, DARK, [1.05, 0.52, d / 2 + 1.95]);
  body.box(0.3, 0.24, 0.42, look.accent, [1.05, 1.15, d / 2 + 1.95]);
  for (const f of featuresFor(b.role, b.style)) feature(body, lights, f, b, look.accent, tall);
}

/** Something by a house for the work its owner does. */
function feature(body: Parts, lights: Parts, f: Feature, b: TownBuilding, accent: number, tall: number) {
  const [w, d] = b.size;
  const yard = d / 2 + 1;
  switch (f) {
    case "dish": {
      // On the roof at the back, turned to the sky.
      body.box(0.08, 0.5, 0.08, DARK, [-w * 0.25, tall + 0.75, -d * 0.25]);
      body.add(
        new THREE.CylinderGeometry(0.55, 0.12, 0.18, 14),
        0xdfe3e8,
        [-w * 0.25, tall + 1.05, -d * 0.25],
        0,
        -0.7,
      );
      return;
    }
    case "mast":
      body.box(0.07, 3.4, 0.07, 0x9aa0a8, [-w * 0.3, tall + 1.7, -d * 0.1]);
      for (const y of [1, 2, 2.9]) body.box(0.5, 0.04, 0.04, 0x9aa0a8, [-w * 0.3, tall + y, -d * 0.1]);
      lights.add(new THREE.SphereGeometry(0.09, 8, 6), 0xff3b30, [-w * 0.3, tall + 3.45, -d * 0.1]);
      return;
    case "rack":
      // A cabinet at the side of the house, its lights blinking blue and green.
      body.box(0.7, 1.7, 0.6, 0x2b2f36, [w / 2 + 0.6, 0.85, d * 0.15]);
      for (let k = 0; k < 6; k++)
        lights.box(0.05, 0.05, 0.02, k % 3 ? 0x3ddc78 : 0x5aa2ff, [
          w / 2 + 0.6 + (k % 2 ? 0.12 : -0.12),
          0.5 + k * 0.2,
          d * 0.15 + 0.31,
        ]);
      return;
    case "easel":
      for (const s of [-1, 1])
        body.add(new THREE.BoxGeometry(0.05, 1.5, 0.05), WOOD, [-1.7 + s * 0.25, 0.72, yard], 0, s * 0.08);
      body.box(0.8, 0.6, 0.04, 0xf6f1e4, [-1.7, 1.15, yard + 0.06]);
      body.box(0.5, 0.25, 0.01, accent, [-1.8, 1.2, yard + 0.09]);
      body.box(0.25, 0.3, 0.01, 0xe0a030, [-1.5, 1.05, yard + 0.09]);
      return;
    case "telescope":
      for (const s of [0, 2.1, 4.2])
        body.add(
          new THREE.CylinderGeometry(0.025, 0.025, 1.2, 5),
          DARK,
          [w / 2 + 0.8 + Math.sin(s) * 0.2, 0.55, -0.6 + Math.cos(s) * 0.2],
          0,
          0.25,
        );
      body.add(new THREE.CylinderGeometry(0.1, 0.13, 1.1, 10), 0xc8a24a, [w / 2 + 0.8, 1.35, -0.6], 0.3, -0.9);
      return;
    case "signpost":
      body.box(0.1, 2, 0.1, WOOD, [-1.9, 1, yard + 0.6]);
      for (const [y, t, c] of [
        [1.75, 0.4, 0xe0b040],
        [1.45, -0.5, 0x4f81bd],
        [1.15, 0.9, 0xc0504d],
      ])
        body.box(0.75, 0.16, 0.04, c, [-1.9, y, yard + 0.6], t);
      return;
    case "garden":
      // Beds of flowers along the front, either side of the path.
      for (const side of [-1, 1]) {
        body.box(w / 2 - 1.1, 0.18, 0.7, 0x5a4030, [side * (w / 4 + 0.5), 0.09, d / 2 + 0.55]);
        for (let k = 0; k < 5; k++)
          body.box(0.16, 0.16, 0.16, [0xe05a77, 0xf2c14e, 0xffffff, 0xb46ae0, 0xff8a4a][(k + (side > 0 ? 2 : 0)) % 5], [
            side * (0.95 + k * ((w / 2 - 1.3) / 4)),
            0.26,
            d / 2 + 0.45 + (k % 2) * 0.2,
          ]);
      }
      return;
    case "woodpile":
      for (let k = 0; k < 7; k++)
        body.add(
          new THREE.CylinderGeometry(0.11, 0.11, 0.9, 7),
          0x9a6a40,
          [w / 2 + 0.6, 0.12 + Math.floor(k / 3) * 0.2, -0.6 + (k % 3) * 0.24 + (Math.floor(k / 3) % 2) * 0.12],
          0,
          Math.PI / 2,
        );
      body.box(0.9, 0.08, 0.3, WOOD, [w / 2 + 0.6, 0.6, 0.9]);
      return;
    case "chalkboard":
      for (const s of [-1, 1])
        body.add(
          new THREE.BoxGeometry(0.7, 1.1, 0.04),
          s > 0 ? 0x2f4a3a : WOOD,
          [1.85, 0.55, yard + 0.3 + s * 0.12],
          0,
          s * 0.2,
        );
      body.box(0.45, 0.04, 0.01, 0xf2f2f2, [1.85, 0.8, yard + 0.46]);
      body.box(0.35, 0.04, 0.01, 0xf2f2f2, [1.82, 0.65, yard + 0.46]);
      return;
    case "banner":
      body.box(0.07, 3, 0.07, 0x5a5050, [-1.9, 1.5, yard + 0.5]);
      body.box(0.04, 1.1, 0.8, 0x7a3fa0, [-1.9, 2.4, yard + 0.95]);
      body.box(0.05, 0.3, 0.3, 0xf2c14e, [-1.9, 2.5, yard + 0.95]);
      return;
    case "sundial":
      body.add(new THREE.CylinderGeometry(0.22, 0.28, 0.8, 8), STONE, [-1.8, 0.4, yard + 0.4]);
      body.add(new THREE.CylinderGeometry(0.38, 0.38, 0.05, 16), 0xd8cfa8, [-1.8, 0.82, yard + 0.4]);
      body.add(new THREE.BoxGeometry(0.03, 0.22, 0.25), DARK, [-1.8, 0.95, yard + 0.4], 0, 0.6);
      return;
    case "awning":
      // Striped over the front windows and the door.
      for (let k = 0; k < 7; k++)
        body.add(
          new THREE.BoxGeometry((w - 0.4) / 7, 0.05, 1.1),
          k % 2 ? 0xf5f1e6 : accent,
          [-(w - 0.4) / 2 + ((k + 0.5) * (w - 0.4)) / 7, 2.45, d / 2 + 0.5],
          0,
          0.35,
        );
      return;
    case "lantern":
      body.box(0.08, 2.1, 0.08, DARK, [-1.85, 1.05, yard + 0.75]);
      body.box(0.26, 0.06, 0.26, DARK, [-1.85, 2.4, yard + 0.75]);
      lights.box(0.18, 0.28, 0.18, 0xffc46a, [-1.85, 2.22, yard + 0.75]);
      return;
    case "flag":
      body.box(0.06, 3.4, 0.06, 0xd0d0d0, [w / 2 + 0.7, 1.7, 0.4]);
      body.box(0.03, 0.55, 0.85, 0x3ddc78, [w / 2 + 0.7, 3.05, 0.85]);
      return;
  }
}

/** The town hall: stone, a pediment over the door, pilasters either side of it, tall windows, and a clock tower. */
function townHall(body: Parts, glass: Parts, b: TownBuilding) {
  const [w, d, h] = b.size;
  const stone = 0xd9d2c3;
  body.box(w + 0.4, 0.35, d + 0.4, 0xb8b0a0, [0, 0.175, 0]);
  body.box(w, h, d, stone, [0, h / 2, 0]);
  body.box(w + 0.5, 0.4, d + 0.5, 0xc4bcaa, [0, h + 0.2, 0]);
  // Where the town says, so what hangs on the front is hung between them.
  const pillars = b.pillars ?? { x: [], width: 0 };
  for (const x of pillars.x) body.box(pillars.width, h - 0.2, 0.3, 0xe8e2d4, [x, h / 2, d / 2 + 0.12]);
  // The pediment over the middle, and the roof behind it.
  body.add(gables(1, 4.4, 1.6), 0xe8e2d4, [0, h + 0.4, d / 2 + 0.1], Math.PI / 2, 0, [0.6, 1, 1]);
  body.add(slopes(d - 0.4, w * 0.92, 1.4), 0x6a6e78, [0, h + 0.4, -0.3], Math.PI / 2);
  // Tall windows upstairs, all along the front, clear of what hangs below them.
  for (const x of [-7.6, -5, -2.6, 2.6, 5, 7.6]) windowAt(body, glass, [x, h - 1.6, d / 2], 0, 0.9, 1.5);
  for (const x of [-6, -2, 2, 6]) windowAt(body, glass, [x, h / 2, -d / 2], Math.PI, 1, 1.6);
  for (const side of [-1, 1])
    for (const z of [-2, 2]) windowAt(body, glass, [(side * w) / 2, h / 2, z], (side * Math.PI) / 2, 0.9, 1.6);
  // The clock tower, with a face on each side.
  const tower: V3 = [0, h + 0.4, -0.8];
  body.box(3, 3.4, 3, stone, [0, tower[1] + 1.7, tower[2]]);
  body.add(pyramid(3.6, 3.6, 2.4), 0x4f5a6a, [0, tower[1] + 3.4, tower[2]]);
  for (const t of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const at: V3 = [Math.sin(t) * 1.52, tower[1] + 2, tower[2] + Math.cos(t) * 1.52];
    body.add(new THREE.CylinderGeometry(0.85, 0.85, 0.06, 20), 0xf6f2e6, at, t, Math.PI / 2);
    body.add(
      new THREE.BoxGeometry(0.06, 0.6, 0.04),
      DARK,
      [at[0] + Math.sin(t) * 0.05, at[1] + 0.25, at[2] + Math.cos(t) * 0.05],
      t,
    );
    body.add(
      new THREE.BoxGeometry(0.42, 0.06, 0.04),
      DARK,
      [at[0] + Math.sin(t) * 0.05 + Math.cos(t) * 0.2, at[1], at[2] + Math.cos(t) * 0.05 - Math.sin(t) * 0.2],
      t,
    );
  }
  body.box(0.06, 1.6, 0.06, 0xd0d0d0, [0, tower[1] + 6.6, tower[2]]);
  body.box(0.03, 0.5, 0.8, 0x4f81bd, [0, tower[1] + 7.1, tower[2] + 0.42]);
}

/** The office: glass all down its front in bands, a floor at a time, a flat roof with its plant on top. */
function office(body: Parts, glass: Parts, b: TownBuilding) {
  const [w, d, h] = b.size;
  body.box(w, h, d, 0xcfd6de, [0, h / 2, 0]);
  const floors = 3;
  const tall = h / floors;
  for (let f = 0; f < floors; f++) {
    // The ground floor's glass stops either side of the door.
    for (let k = 0; k < 6; k++) {
      const x = -w / 2 + 0.9 + (k * (w - 1.8)) / 5;
      if (f === 0 && Math.abs(x) < 1.6) continue;
      glass.add(new THREE.BoxGeometry((w - 1.8) / 5 - 0.25, tall - 0.9, 0.06), 0xffffff, [
        x,
        f * tall + tall / 2 + 0.1,
        d / 2 + 0.03,
      ]);
    }
    body.box(w + 0.1, 0.25, d + 0.1, 0x8a96a4, [0, (f + 1) * tall, 0]);
    for (const side of [-1, 1])
      for (const z of [-2.5, 0, 2.5])
        glass.add(new THREE.BoxGeometry(0.06, tall - 0.9, 1.6), 0xffffff, [
          (side * w) / 2 + side * 0.03,
          f * tall + tall / 2 + 0.1,
          z,
        ]);
  }
  body.box(w + 0.3, 0.5, d + 0.3, 0x7a8696, [0, h + 0.25, 0]);
  body.box(3, 1.2, 2.2, 0x9aa4b0, [w * 0.2, h + 1.1, -d * 0.15]);
  body.box(1.4, 0.9, 1.4, 0x9aa4b0, [-w * 0.25, h + 0.95, -d * 0.2]);
  // A canopy over the door.
  body.box(3.2, 0.12, 1.4, 0x5a6a7a, [0, 2.9, d / 2 + 0.7]);
}

/** A meeting room's building of its own, or a shared place's: each in a look that says what it is. */
function onStreet(body: Parts, glass: Parts, lights: Parts, b: TownBuilding) {
  const [w, d, h] = b.size;
  const looks: Record<string, { walls: number; roof: number; trim: number }> = {
    tavern: { walls: 0xe9dcc0, roof: 0x5a3a2a, trim: 0x4a3020 },
    studio: { walls: 0x3a3646, roof: 0x2a2833, trim: 0x8a7aa8 },
    workshop: { walls: 0xa0503c, roof: 0x4a4f58, trim: 0x6a6a6a },
    library: { walls: 0xd8d0be, roof: 0x4f5a6a, trim: 0xb8ae98 },
    hut: { walls: 0xf4f0e4, roof: 0x3f8fd2, trim: 0x3f8fd2 },
    shop: { walls: (0xf0 << 16) | (0xe0 << 8) | 0xd0, roof: 0x7a5c48, trim: 0x4f81bd },
    cottage: { walls: 0xefe6cf, roof: 0xc9a85a, trim: 0x6b8a5e },
  };
  const look = looks[b.kind] ?? looks.shop;
  const walls = b.kind === "shop" ? (houseLook(b.id, b.style).walls ?? look.walls) : look.walls;
  body.box(w + 0.16, 0.25, d + 0.16, STONE, [0, 0.125, 0]);
  body.box(w, h, d, walls, [0, h / 2, 0]);
  if (b.kind === "tavern") {
    // Timbers across its walls, a steep roof, and a sign hung out over the street.
    for (const x of [-w / 2 + 0.1, -w / 4, w / 4, w / 2 - 0.1])
      body.box(0.18, h, 0.06, look.trim, [x, h / 2, d / 2 + 0.03]);
    body.box(w, 0.18, 0.06, look.trim, [0, h * 0.55, d / 2 + 0.03]);
    body.add(slopes(w + 0.6, d + 0.8, 2.6), look.roof, [0, h, 0]);
    body.add(gables(w, d, 2.5), walls, [0, h, 0]);
    body.box(1.6, 0.08, 0.08, look.trim, [w / 2 - 0.4, 3.4, d / 2 + 0.75]);
    body.box(0.06, 0.8, 1.0, 0x7a3f2a, [w / 2 + 0.1, 2.9, d / 2 + 1.1], Math.PI / 2);
    body.box(0.07, 0.4, 0.4, 0xf2c14e, [w / 2 + 0.1, 2.9, d / 2 + 1.1], Math.PI / 2);
    lights.box(0.2, 0.3, 0.2, 0xffb04a, [-w / 2 + 0.6, 2.4, d / 2 + 0.3]);
  } else if (b.kind === "studio") {
    body.box(w + 0.3, 0.3, d + 0.3, look.roof, [0, h + 0.15, 0]);
    lights.box(1.3, 0.38, 0.06, 0xff3b30, [0, 3.05, d / 2 + 0.05]);
    body.box(0.06, 2.4, 0.06, 0x9aa0a8, [w / 3, h + 1.3, -d / 4]);
    lights.add(new THREE.SphereGeometry(0.08, 8, 6), 0xff3b30, [w / 3, h + 2.55, -d / 4]);
  } else if (b.kind === "workshop") {
    // A saw-tooth roof, a tall chimney, crates by the door.
    for (const k of [-1, 1]) body.add(slopes(d + 0.3, w / 2 + 0.2, 1.4), look.roof, [(k * w) / 4, h, 0], Math.PI / 2);
    body.box(0.9, 4, 0.9, BRICK, [-w / 2 + 0.8, h + 1.5, -d / 2 + 0.8]);
    for (const [x, z, s] of [
      [w / 2 - 0.9, d / 2 + 0.7, 0.6],
      [w / 2 - 1.6, d / 2 + 0.6, 0.5],
      [w / 2 - 1.1, d / 2 + 0.75, 0.4],
    ])
      body.box(s, s, s, 0xb5835a, [x, s / 2 + (s === 0.4 ? 0.6 : 0), z]);
  } else if (b.kind === "library") {
    for (const x of [-w / 2 + 0.6, -1.5, 1.5, w / 2 - 0.6])
      body.add(new THREE.CylinderGeometry(0.22, 0.25, h - 0.3, 10), 0xf0ebe0, [x, h / 2, d / 2 + 0.4]);
    body.box(w + 0.4, 0.35, 1.2, look.trim, [0, h - 0.1, d / 2 + 0.3]);
    body.add(gables(1, w + 0.4, 1.4), look.trim, [0, h + 0.05, d / 2 + 0.3], Math.PI / 2, 0, [1.1, 1, 1]);
    body.add(slopes(d, w + 0.2, 1.3), look.roof, [0, h + 0.05, -0.3], Math.PI / 2);
  } else if (b.kind === "hut") {
    // Striped boards, a little roof, a deck in front on the sand.
    for (let k = 0; k < 6; k++)
      body.box(w / 6 - 0.02, h, 0.04, k % 2 ? 0xf4f0e4 : look.trim, [
        -w / 2 + ((k + 0.5) * w) / 6,
        h / 2,
        d / 2 + 0.02,
      ]);
    body.add(slopes(w + 0.5, d + 0.5, 1.2), 0xf4f0e4, [0, h, 0]);
    body.add(gables(w, d, 1.15), walls, [0, h, 0]);
    body.box(w + 0.6, 0.12, 1.5, 0xc9a477, [0, 0.06, d / 2 + 0.75]);
  } else {
    // A shop front: a wide window either side of the door, a band for its sign, a striped awning.
    body.box(w + 0.1, 0.5, 0.08, look.trim, [0, h - 0.5, d / 2 + 0.04]);
    for (let k = 0; k < 8; k++)
      body.add(
        new THREE.BoxGeometry(w / 8, 0.05, 1.2),
        k % 2 ? 0xf5f1e6 : look.trim,
        [-w / 2 + ((k + 0.5) * w) / 8, 2.55, d / 2 + 0.55],
        0,
        0.35,
      );
    if (b.kind === "cottage") {
      body.add(slopes(w + 0.6, d + 0.6, 1.8), look.roof, [0, h, 0]);
      body.add(gables(w, d, 1.75), walls, [0, h, 0]);
    } else body.box(w + 0.3, 0.3, d + 0.3, 0x6a5a4a, [0, h + 0.15, 0]);
  }
  // Windows: wide ones either side of the door, and along the sides.
  const front = b.kind === "shop" || b.kind === "cottage" ? 1.6 : 1.1;
  if (b.kind !== "studio")
    for (const x of [-(w / 2 - 1.3), w / 2 - 1.3]) windowAt(body, glass, [x, 1.5, d / 2], 0, front, 1.1);
  for (const side of [-1, 1]) windowAt(body, glass, [(side * w) / 2, 1.6, 0], (side * Math.PI) / 2, 1, 1);
}

/**
 * A door painted on a building's front, where the real one stands: the stage
 * draws the real door (see `buildDoor`) only near enough to matter, and from
 * further off this is what shows, so a street of houses isn't hundreds of draws.
 */
function paintedDoor(body: Parts, b: TownBuilding) {
  const panel = b.owner ? 0x8a5a3b : b.kind === "hall" || b.kind === "office" ? 0x5a6a7a : 0x4f6278;
  body.box(1.42, 2.25, 0.04, FRAME, [0, 1.125, b.size[1] / 2 + 0.01]);
  body.box(1.2, 2.16, 0.05, panel, [0, 1.08, b.size[1] / 2 + 0.02]);
  body.box(1.3, 0.3, 0.04, 0x2a2e38, [0, 2.5, b.size[1] / 2 + 0.02]);
}

/** Build one building, standing where the plan says, facing its street. */
function building(b: TownBuilding, paint: THREE.Material, lights: Parts): BuiltBuilding {
  const body = new Parts();
  const glassParts = new Parts();
  const lit = new Parts();
  if (b.kind === "house") house(body, glassParts, lit, b);
  else if (b.kind === "hall") townHall(body, glassParts, b);
  else if (b.kind === "office") office(body, glassParts, b);
  else onStreet(body, glassParts, lit, b);
  paintedDoor(body, b);
  const group = new THREE.Group();
  group.position.set(b.at[0], 0, b.at[1]);
  group.rotation.y = (b.facing * Math.PI) / 180;
  const geometry = body.merged();
  if (geometry) {
    const mesh = new THREE.Mesh(geometry, paint);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const glass = new THREE.MeshLambertMaterial({ color: 0x9ec4dc, emissive: 0xbfe3ff, emissiveIntensity: 0.25 });
  const panes = glassParts.merged();
  if (panes) group.add(new THREE.Mesh(panes, glass));
  // What glows by a building is put in the town's one mesh of lights, where the building stands.
  group.updateMatrix();
  for (const g of lit.list) {
    g.applyMatrix4(group.matrix);
    lights.list.push(g);
  }
  lit.list.length = 0;
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const fp = footprintBox(b);
  return {
    building: b,
    group,
    glass,
    // The walls, and for a house its front garden's hedges: walked round, not through.
    obstacles: [fp, ...(b.kind === "house" ? hedges(b) : [])],
    // What hides you is the building itself: you stand in its front garden at the door, which mustn't count as in it.
    solid: { min: [fp.minX, 0, fp.minZ], max: [fp.maxX, box.max.y, fp.maxZ] },
    approach: outsideDoor(b, 2.2),
  };
}

/** A house's two front hedges, as boxes on the floor. */
function hedges(b: TownBuilding): Obstacle[] {
  const [w, d] = b.size;
  const f = (b.facing * Math.PI) / 180;
  const at = (x: number, z: number): [number, number] => [
    b.at[0] + x * Math.cos(f) + z * Math.sin(f),
    b.at[1] - x * Math.sin(f) + z * Math.cos(f),
  ];
  return [-1, 1].map((side) => {
    const c = at(side * (w / 4 + 0.42), d / 2 + 1.75);
    return footprintBox({ at: c, facing: b.facing, size: [w / 2 - 0.85, 0.38, 0.55] }, 0.05);
  });
}

/** The town as built: what the stage adds to the scene and keeps up. */
export interface BuiltTown {
  group: THREE.Group;
  buildings: BuiltBuilding[];
  /** What can't be walked through: buildings, hedges, the fountain, the stream bar its bridges, the pond, tree trunks. */
  obstacles: Obstacle[];
  /** The sky dome, the stars, the sun and the moon: they keep round the camera. */
  sky: THREE.Group;
  /** Light each building's windows for the hour, by what its owner is doing, and who is in it when that is known. */
  setWindows(activities: Record<string, AgentActivity>, hour: number, inside?: ReadonlySet<string>): void;
  /** Colour the sky, show the stars or not, and light the street lamps, for an hour. */
  setHour(hour: number, lamps: boolean): void;
  dispose(): void;
}

/** The ground's greens, a little uneven, so a big lawn doesn't read as a sheet of paper. */
function ground(plan: TownPlan): THREE.Mesh {
  const size = Math.max(plan.width, plan.depth) + 500;
  const g = new THREE.PlaneGeometry(size, size, 48, 48);
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const n = Math.sin(x * 0.07) * Math.cos(z * 0.06) * 0.5 + Math.sin(x * 0.021 + z * 0.017) * 0.5;
    c.setHex(0x78a85a).offsetHSL(n * 0.02, 0, n * 0.05);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.position.y = -0.01;
  mesh.receiveShadow = true;
  return mesh;
}

/** A strip along a line, on the ground: a road, a kerb, the stream, its banks. */
function strip(parts: Parts, points: [number, number][], width: number, color: number, y: number) {
  const pairs = ribbon(points, width);
  if (pairs.length < 2) return;
  const v: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    const [a1, a2] = pairs[i - 1];
    const [b1, b2] = pairs[i];
    // Wound to face up: left, on along the line, right; and again for the far side of the quad.
    v.push(a1[0], y, a1[1], b1[0], y, b1[1], a2[0], y, a2[1], a2[0], y, a2[1], b1[0], y, b1[1], b2[0], y, b2[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  const normals = new Float32Array(v.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  parts.add(g, color, [0, 0, 0]);
}

/** What each kind of road is paved with, its kerbs, and how high it lies, so crossings don't flicker. */
const PAVING: Record<string, { color: number; kerb?: number; y: number }> = {
  avenue: { color: 0x8d8a84, kerb: 0xcfc8ba, y: 0.03 },
  street: { color: 0xa39a8c, kerb: 0xd8d0c0, y: 0.035 },
  lane: { color: 0xb0a898, kerb: 0xd6cfbf, y: 0.025 },
  path: { color: 0xc9b48a, y: 0.02 },
  promenade: { color: 0xc4a274, kerb: 0x9a7a54, y: 0.02 },
};

/** Build the town from its plan: everything but the doors, which the stage builds with a room's (see `buildDoor`). */
export function buildTown(plan: TownPlan): BuiltTown {
  const group = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const shared = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const obstacles: Obstacle[] = [];
  group.add(ground(plan));

  // The sand along the shore, and the sea past it to the horizon.
  const wide = plan.width + 600;
  const sand = new THREE.Mesh(
    new THREE.PlaneGeometry(wide, plan.shore.sea - plan.shore.sand + 6).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xe6d3a2 }),
  );
  sand.position.set(0, 0.005, (plan.shore.sand + plan.shore.sea) / 2 + 2);
  sand.receiveShadow = true;
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(wide, 700).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x3f86b8, emissive: 0x0d2a44, emissiveIntensity: 0.4 }),
  );
  sea.position.set(0, 0.012, plan.shore.sea + 350);
  group.add(sand, sea);
  // Surf along the water's edge.
  const flat = new Parts();
  flat.box(wide, 0.01, 0.7, 0xeef6f8, [0, 0.016, plan.shore.sea + 0.5]);
  flat.box(wide, 0.01, 0.35, 0xd8ecf2, [0, 0.016, plan.shore.sea + 2.6]);

  // The roads, each over its kerbs; the square over them all, paved round its fountain; the forecourt of the hall.
  for (const r of plan.roads) {
    const p = PAVING[r.kind] ?? PAVING.lane;
    if (p.kerb) strip(flat, r.points, r.width + 0.5, p.kerb, p.y - 0.004);
    strip(flat, r.points, r.width, p.color, p.y);
  }
  const square = plan.square.radius;
  flat.add(new THREE.CircleGeometry(square + 0.5, 64).rotateX(-Math.PI / 2), 0xcdbfa6, [0, 0.045, 0]);
  flat.add(new THREE.CircleGeometry(square, 64).rotateX(-Math.PI / 2), 0xe0d5c0, [0, 0.05, 0]);
  flat.add(new THREE.RingGeometry(3.6, 4.2, 48).rotateX(-Math.PI / 2), 0xbcae94, [0, 0.055, 0]);
  flat.add(new THREE.RingGeometry(7.6, 7.9, 64).rotateX(-Math.PI / 2), 0xc6b89e, [0, 0.055, 0]);
  const hall = plan.buildings.find((b) => b.kind === "hall");
  if (hall) {
    const front = hall.at[1] + hall.size[1] / 2;
    flat.box(hall.size[0] + 4, 0.02, -front - square + 3, 0xe0d5c0, [hall.at[0], 0.05, (front - square + 3) / 2 + 0]);
  }
  // A path from each plot's gate in, and the plot's ground.
  for (const p of plan.plots) flat.box(p.size[0], 0.02, p.size[1], 0x8fb26a, [p.at[0], 0.008, p.at[1]]);

  // The stream, its banks, and the pond.
  strip(flat, plan.stream.points, plan.stream.width + 1.4, 0x6b7f4a, 0.006);
  const water = new Parts();
  strip(water, plan.stream.points, plan.stream.width, 0x4f93c4, 0.02);
  const pond = plan.park.pond;
  flat.add(new THREE.CircleGeometry(0.5, 32).rotateX(-Math.PI / 2), 0x9a948a, [pond.at[0], 0.01, pond.at[1]], 0, 0, [
    pond.size[0] + 1,
    1,
    pond.size[1] + 1,
  ]);
  water.add(new THREE.CircleGeometry(0.5, 32).rotateX(-Math.PI / 2), 0x4f93c4, [pond.at[0], 0.022, pond.at[1]], 0, 0, [
    pond.size[0],
    1,
    pond.size[1],
  ]);
  // The pond, the stream bar at its bridges, and the sea can't be walked into.
  obstacles.push(...waterObstacles(plan));
  const fixtures = new Parts();
  for (const br of plan.stream.bridges) {
    // A wooden deck across, a little arched, with a rail each side.
    const t = (br.facing * Math.PI) / 180;
    fixtures.add(new THREE.BoxGeometry(br.length, 0.18, 3.4), 0x9a6a40, [br.at[0], 0.12, br.at[1]], t - Math.PI / 2);
    for (const s of [-1, 1]) {
      fixtures.add(
        new THREE.BoxGeometry(br.length, 0.08, 0.1),
        0x6b4a33,
        [br.at[0], 0.95, br.at[1] + s * 1.65],
        t - Math.PI / 2,
      );
      for (const k of [-1, 0, 1])
        fixtures.add(
          new THREE.BoxGeometry(0.1, 0.9, 0.1),
          0x6b4a33,
          [br.at[0] + (k * br.length) / 2.4, 0.5, br.at[1] + s * 1.65],
          t - Math.PI / 2,
        );
    }
  }

  // The fountain in the middle of the square: a basin, its water, a column and a bowl on top.
  fixtures.add(new THREE.CylinderGeometry(2.4, 2.5, 0.55, 28), 0xbdb3a0, [0, 0.3, 0]);
  water.add(new THREE.CylinderGeometry(2.15, 2.15, 0.06, 28), 0x6fb2dc, [0, 0.52, 0]);
  fixtures.add(new THREE.CylinderGeometry(0.32, 0.42, 1.6, 12), 0xcfc6b2, [0, 1.1, 0]);
  fixtures.add(new THREE.CylinderGeometry(1, 0.5, 0.35, 20), 0xbdb3a0, [0, 1.9, 0]);
  water.add(new THREE.CylinderGeometry(0.85, 0.85, 0.05, 20), 0x8fc8ea, [0, 2.06, 0]);
  fixtures.add(new THREE.SphereGeometry(0.22, 12, 8), 0xcfc6b2, [0, 2.3, 0]);
  obstacles.push({ minX: -2.5, maxX: 2.5, minZ: -2.5, maxZ: 2.5 });

  // Fences round the plots, a gate left open, and a sign with the plot's name.
  for (const p of plan.plots) {
    const [hx, hz] = [p.size[0] / 2, p.size[1] / 2];
    const posts = (x0: number, z0: number, x1: number, z1: number) => {
      const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 2));
      for (let k = 0; k <= n; k++)
        fixtures.box(0.1, 0.9, 0.1, 0xe8e0cc, [
          p.at[0] + x0 + ((x1 - x0) * k) / n,
          0.45,
          p.at[1] + z0 + ((z1 - z0) * k) / n,
        ]);
      const [mx, mz] = [(x0 + x1) / 2, (z0 + z1) / 2];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const turn = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
      for (const y of [0.35, 0.7])
        fixtures.add(new THREE.BoxGeometry(len, 0.07, 0.05), 0xe8e0cc, [p.at[0] + mx, y, p.at[1] + mz], turn);
    };
    const gateSide = p.gate[0] > p.at[0] ? 1 : -1;
    posts(-hx, -hz, hx, -hz);
    posts(-hx, hz, hx, hz);
    // The gate's side, open in the middle where the path comes in.
    posts(gateSide * hx, -hz, gateSide * hx, -1.6);
    posts(gateSide * hx, 1.6, gateSide * hx, hz);
    posts(-gateSide * hx, -hz, -gateSide * hx, hz);
  }

  // Street lamps: a slim post each, a lantern on top that glows after dark, and a cap over it.
  const iron = new THREE.MeshLambertMaterial({ color: 0x2f343b });
  const lampPost = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.045, 0.07, 3, 6), iron, plan.lamps.length);
  const lampGlow = new THREE.MeshLambertMaterial({ color: 0xfff1d0, emissive: 0xffc46a, emissiveIntensity: 0 });
  const lampHead = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.3, 0.22), lampGlow, plan.lamps.length);
  const lampCap = new THREE.InstancedMesh(pyramid(0.36, 0.36, 0.2), iron, plan.lamps.length);
  const m = new THREE.Matrix4();
  for (const [i, [x, z]] of plan.lamps.entries()) {
    lampPost.setMatrixAt(i, m.makeTranslation(x, 1.5, z));
    lampHead.setMatrixAt(i, m.makeTranslation(x, 3.12, z));
    lampCap.setMatrixAt(i, m.makeTranslation(x, 3.27, z));
    obstacles.push({ minX: x - 0.15, maxX: x + 0.15, minZ: z - 0.15, maxZ: z + 0.15 });
  }
  lampPost.castShadow = true;
  group.add(lampPost, lampHead, lampCap);

  // Trees: a trunk each, and a round crown or a pointed one, in greens of their own.
  const trees = plan.trees;
  const pointed = (i: number) =>
    (Math.sin(i * 12.9898) * 43758.5453) % 1 > 0.62 || (Math.sin(i * 12.9898) * 43758.5453) % 1 < -0.62;
  const round = trees.filter((_, i) => !pointed(i));
  const tall = trees.filter((_, i) => pointed(i));
  const trunk = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.16, 0.22, 1.6, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4a33, flatShading: true }),
    trees.length,
  );
  const crown = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1.5, 0),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    round.length,
  );
  const cone = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.25, 3.4, 7),
    new THREE.MeshLambertMaterial({ flatShading: true }),
    tall.length,
  );
  const tint = new THREE.Color();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (const [i, [x, z, k]] of trees.entries()) {
    trunk.setMatrixAt(i, m.compose(v.set(x, 0.8 * k, z), q.identity(), s.set(k, k, k)));
    obstacles.push({ minX: x - 0.3 * k, maxX: x + 0.3 * k, minZ: z - 0.3 * k, maxZ: z + 0.3 * k });
  }
  for (const [i, [x, z, k]] of round.entries()) {
    crown.setMatrixAt(
      i,
      m.compose(v.set(x, 2.6 * k, z), q.setFromAxisAngle(v.clone().set(0, 1, 0), i), s.set(k, k * 0.9, k)),
    );
    crown.setColorAt(
      i,
      tint.setHex(0x4f8a3a).offsetHSL(((i * 37) % 11) / 300 - 0.015, 0, ((i * 53) % 13) / 130 - 0.05),
    );
  }
  for (const [i, [x, z, k]] of tall.entries()) {
    cone.setMatrixAt(i, m.compose(v.set(x, 2.9 * k, z), q.identity(), s.set(k, k, k)));
    cone.setColorAt(i, tint.setHex(0x2f6a3a).offsetHSL(0, 0, ((i * 41) % 9) / 120 - 0.03));
  }
  for (const t of [trunk, crown, cone]) {
    t.castShadow = true;
    t.receiveShadow = true;
    group.add(t);
  }

  // Every building, each a mesh of its own; what glows by them, one mesh.
  const lit = new Parts();
  const buildings = plan.buildings.map((b) => building(b, paint, lit));
  for (const b of buildings) {
    group.add(b.group);
    obstacles.push(...b.obstacles);
  }

  // A sign at the start of each lane with its name, and one at each plot's gate.
  const sign = (words: string, at: [number, number], turn: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#24303f";
      ctx.fillRect(0, 0, 512, 128);
      ctx.strokeStyle = "#e8e2d4";
      ctx.lineWidth = 6;
      ctx.strokeRect(8, 8, 496, 112);
      ctx.fillStyle = "#f3efe6";
      ctx.font = "600 58px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(words, 256, 68, 470);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({
      map: texture,
      emissive: 0xffffff,
      emissiveMap: texture,
      emissiveIntensity: 0.35,
    });
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.45, 0.06), [
      shared,
      shared,
      shared,
      shared,
      material,
      material,
    ]);
    board.position.set(at[0], 2.25, at[1]);
    board.rotation.y = turn;
    fixtures.box(0.09, 2.5, 0.09, 0x2f343b, [at[0], 1.25, at[1]]);
    group.add(board);
  };
  for (const r of plan.roads.filter((x) => x.kind === "lane" && x.name)) {
    const [a, b] = [r.points[0], r.points[Math.min(3, r.points.length - 1)]];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const n = Math.hypot(dx, dz) || 1;
    // At the corner, to the right as you turn in, facing the avenue.
    const at: [number, number] = [
      a[0] - (dz / n) * (r.width / 2 + 0.8) + (dx / n) * 1.2,
      a[1] + (dx / n) * (r.width / 2 + 0.8) + (dz / n) * 1.2,
    ];
    sign(r.name as string, at, Math.atan2(-dx, -dz));
    obstacles.push({ minX: at[0] - 0.15, maxX: at[0] + 0.15, minZ: at[1] - 0.15, maxZ: at[1] + 0.15 });
  }
  for (const p of plan.plots) {
    const words = p.name.replace(/^(the|a|an)\s+/i, "");
    const name = words.charAt(0).toUpperCase() + words.slice(1);
    const side = p.gate[0] > p.at[0] ? 1 : -1;
    sign(name, [p.gate[0] + side * 0.6, p.gate[1] - 2.2], (side * Math.PI) / 2);
  }

  const flatGeometry = flat.merged();
  if (flatGeometry) {
    const mesh = new THREE.Mesh(flatGeometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const waterGeometry = water.merged();
  const waterPaint = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0d2a44, emissiveIntensity: 0.5 });
  if (waterGeometry) group.add(new THREE.Mesh(waterGeometry, waterPaint));
  const fixtureGeometry = fixtures.merged();
  if (fixtureGeometry) {
    const mesh = new THREE.Mesh(fixtureGeometry, shared);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const litGeometry = lit.merged();
  if (litGeometry)
    group.add(new THREE.Mesh(litGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })));

  // The sky: a dome coloured from the horizon up, stars for the night, the sun and the moon. It keeps round the camera.
  const sky = new THREE.Group();
  const dome = new THREE.SphereGeometry(380, 24, 12);
  const domeColors = new Float32Array(dome.getAttribute("position").count * 3);
  dome.setAttribute("color", new THREE.BufferAttribute(domeColors, 3));
  const domePaint = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const domeMesh = new THREE.Mesh(dome, domePaint);
  domeMesh.renderOrder = -10;
  const starPoints: number[] = [];
  for (let i = 0; i < 700; i++) {
    const a = (i * 2.399963) % (Math.PI * 2);
    const up = 0.08 + ((i * 0.618034) % 1) ** 0.7 * 0.92;
    const r = Math.sqrt(1 - up * up);
    starPoints.push(Math.cos(a) * r * 360, up * 360, Math.sin(a) * r * 360);
  }
  const stars = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(starPoints, 3)),
    new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false }),
  );
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(14, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff4d0, fog: false, depthWrite: false }),
  );
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(9, 24),
    new THREE.MeshBasicMaterial({ color: 0xe8ecf8, fog: false, depthWrite: false }),
  );
  sky.add(domeMesh, stars, sun, moon);

  const setHour = (hour: number, lampsOn: boolean) => {
    const { zenith, horizon, stars: night } = skyFor(hour);
    const top = new THREE.Color(zenith);
    const low = new THREE.Color(horizon);
    const pos = dome.getAttribute("position");
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 380;
      c.copy(low).lerp(top, Math.min(1, Math.max(0, y * 1.6)) ** 0.8);
      if (y < 0) c.copy(low);
      domeColors.set([c.r, c.g, c.b], i * 3);
    }
    dome.getAttribute("color").needsUpdate = true;
    stars.visible = night;
    const day = hour >= 6 && hour < 20;
    sun.visible = day;
    moon.visible = !day;
    // Where the light comes from: the sun high in the south by day, the moon by night, so shadows fall away from it.
    const where = new THREE.Vector3(...lightFrom(hour)).multiplyScalar(340);
    for (const body of [sun, moon]) {
      body.position.copy(where);
      body.lookAt(0, 0, 0);
    }
    lampGlow.emissiveIntensity = lampsOn ? 1.4 : 0;
  };

  const setWindows = (activities: Record<string, AgentActivity>, hour: number, inside?: ReadonlySet<string>) => {
    for (const b of buildings) {
      const doing = b.building.owner ? activities[b.building.owner]?.doing : undefined;
      const look = windowLook(b.building.kind, hour, doing, inside ? inside.has(b.building.id) : undefined);
      if (look === b.look) continue;
      b.look = look;
      paintGlass(b.glass, look);
    }
  };

  return {
    group,
    buildings,
    obstacles,
    sky,
    setWindows,
    setHour,
    dispose() {
      // The rest of the town is in the stage's furniture, freed with it; the sky is the stage's to hand back here.
      sky.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const m2 = mesh.material as THREE.Material | undefined;
        m2?.dispose();
      });
    },
  };
}
