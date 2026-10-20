/**
 * What the stage draws round a thing you are rearranging: a box round it,
 * and its footprint where it stands, or the patch of wall it hangs on, a
 * little bigger than the thing so it shows round its foot. Both are blue
 * while the thing is only picked, green where you are putting it and it
 * fits, red where it doesn't, and pale while the server is still saying
 * which. The box and the footprint's edge show through whatever is in front.
 * What goes with it, like the chairs at a table, has its footprint's edge
 * drawn too, in the same colour, so you can see what you are moving.
 */
import * as THREE from "three";

/** Whether the thing fits where it is being put: not being moved, still being asked, yes, or no. */
export type Fit = "picked" | "asking" | "fits" | "no";

const COLORS: Record<Fit, number> = { picked: 0x6ea8ff, asking: 0xe8e2d0, fits: 0x3fbf6f, no: 0xe5484d };
/** How far the footprint reaches past the thing on each side, in metres, so it shows round its foot. */
const MARGIN = 0.08;

/** A footprint: on the floor or a top (`y` up), or on the back or left wall. Sizes in metres; `facing` in degrees. */
export type Patch =
  | { on: "floor"; at: [number, number]; y: number; width: number; depth: number; facing: number }
  | { on: "back" | "left"; at: [number, number]; elevation: number; width: number; height: number };

export class Handles {
  readonly group = new THREE.Group();
  private readonly outline: THREE.Box3Helper;
  private readonly box = new THREE.Box3();
  private readonly fill: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly edge: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private target: THREE.Object3D | undefined;
  /** The edges round what goes with the thing, as many as have been needed, the ones not in use hidden. */
  private readonly along: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private readonly square = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([x, y]) => new THREE.Vector3(x, y, 0));

  constructor() {
    this.outline = new THREE.Box3Helper(this.box, new THREE.Color(0xffffff));
    const lines = this.outline.material as THREE.LineBasicMaterial;
    // Drawn over everything, so a box round a thing behind another still shows where it is.
    lines.depthTest = false;
    lines.transparent = true;
    lines.opacity = 0.85;
    this.outline.renderOrder = 20;
    this.fill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // Over the thing itself, faintly, so its colour shows on the thing being moved, not only round its foot.
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    this.fill.renderOrder = 19;
    this.edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(this.square),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.edge.renderOrder = 21;
    this.group.add(this.outline, this.fill, this.edge);
    this.group.visible = false;
  }

  /**
   * Mark a thing: the box round `target`, its footprint as `patch` says, coloured by `fit`, and the edges of the
   * footprints of what goes with it (`also`). Nothing hides them.
   */
  show(target: THREE.Object3D | undefined, patch: Patch | undefined, fit: Fit, also: Patch[] = []) {
    this.target = target;
    for (const [i, loop] of this.along.entries()) loop.visible = i < also.length && !!target && !!patch;
    if (!target || !patch) {
      this.group.visible = false;
      return;
    }
    while (this.along.length < also.length) {
      const loop = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(this.square),
        new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8, depthTest: false }),
      );
      loop.renderOrder = 21;
      this.along.push(loop);
      this.group.add(loop);
    }
    for (const [i, p] of also.entries()) {
      const loop = this.along[i];
      loop.visible = true;
      loop.material.color.setHex(COLORS[fit]);
      place(loop, p);
    }
    this.group.visible = true;
    const color = COLORS[fit];
    this.fill.material.color.setHex(color);
    this.edge.material.color.setHex(color);
    (this.outline.material as THREE.LineBasicMaterial).color.setHex(color);
    for (const o of [this.fill, this.edge]) place(o, patch);
    this.update();
  }

  /** Each frame: the box keeps up with the thing, which may be growing in, or being dragged. */
  update() {
    if (!this.target || !this.group.visible) return;
    this.box.setFromObject(this.target);
    if (this.box.isEmpty()) this.group.visible = false;
  }

  dispose() {
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.fill.geometry.dispose();
    this.fill.material.dispose();
    this.edge.geometry.dispose();
    this.edge.material.dispose();
    for (const loop of this.along) {
      loop.geometry.dispose();
      loop.material.dispose();
    }
  }
}

/** Lay a unit square flat over a footprint: on what it stands on, a hair above it, or on its wall. */
function place(o: THREE.Object3D, patch: Patch) {
  o.rotation.set(0, 0, 0);
  if (patch.on === "floor") {
    // Flat on what it stands on, a hair above it, turned as the thing is.
    o.position.set(patch.at[0], patch.y + 0.012, patch.at[1]);
    o.rotation.set(-Math.PI / 2, 0, (patch.facing * Math.PI) / 180);
    o.scale.set(patch.width + 2 * MARGIN, patch.depth + 2 * MARGIN, 1);
  } else if (patch.on === "back") {
    o.position.set(patch.at[0], patch.elevation + patch.height / 2, patch.at[1] + 0.03);
    o.scale.set(patch.width + 2 * MARGIN, patch.height + 2 * MARGIN, 1);
  } else {
    o.position.set(patch.at[0] + 0.03, patch.elevation + patch.height / 2, patch.at[1]);
    o.rotation.set(0, Math.PI / 2, 0);
    o.scale.set(patch.width + 2 * MARGIN, patch.height + 2 * MARGIN, 1);
  }
}
