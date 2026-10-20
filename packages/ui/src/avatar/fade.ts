/**
 * Fading what is in the way: a tall thing between the camera and a body, or
 * a wall the camera has gone round behind, drawn in see-through copies of
 * its materials while it is faded, and in its own again once it is not.
 * Copies, since a material can be shared by many things and only this one
 * fades. `sight.ts` says what is in the way; this draws it.
 */
import type * as THREE from "three";
import type { Solid, Wall } from "./sight";

/**
 * Something that can fade so a body can be seen past it: a tall thing on the
 * floor, by the box round it, or a wall, or something hanging on one, by which
 * wall. How much of it shows now, and the see-through materials it wears while
 * it is faded, in place of the ones it was built with.
 */
export interface Fadeable {
  group: THREE.Object3D;
  solid?: Solid;
  wall?: Wall;
  level: number;
  own?: Map<THREE.Mesh, THREE.Material | THREE.Material[]>;
}

/** A see-through copy of a material, which remembers how opaque the material was. */
function seeThroughCopy(m: THREE.Material): THREE.Material {
  const c = m.clone();
  c.userData.opacity = m.opacity;
  c.transparent = true;
  c.depthWrite = false;
  return c;
}

/**
 * What the room goes on changing on a material while it shows, carried onto
 * its see-through copy: a door's light turning to say what whoever is behind
 * it is doing, its plate lit under the pointer, a lamp's shade glowing at
 * dusk. Each changes the material it was built with.
 */
function keepUp(copy: THREE.Material, was: THREE.Material | undefined) {
  const c = copy as Partial<THREE.MeshStandardMaterial>;
  const o = was as Partial<THREE.MeshStandardMaterial> | undefined;
  if (!o) return;
  if (c.color && o.color) c.color.copy(o.color);
  if (c.emissive && o.emissive) c.emissive.copy(o.emissive);
  if (typeof o.emissiveIntensity === "number") c.emissiveIntensity = o.emissiveIntensity;
}

/** Whether a mesh is drawn as a live surface's hole (`surface-layer.ts`). */
const isHole = (mesh: THREE.Mesh) => !!(mesh.material as THREE.Material).userData?.hole;

/**
 * Draw something that can fade at how much of it shows: in see-through
 * copies while it is faded, its own once it isn't. Called every frame while
 * it is faded, so the copies keep up with the originals.
 */
export function paintFaded(f: Fadeable) {
  if (f.level >= 0.995) {
    for (const [mesh, was] of f.own ?? []) {
      // A surface's hole is the surface's to take off again (`surface-layer.ts`), and is shared: left as it is.
      if (isHole(mesh)) continue;
      for (const m of [mesh.material].flat()) m.dispose();
      mesh.material = was;
    }
    f.own = undefined;
    return;
  }
  const own = (f.own ??= new Map());
  f.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // A live surface's hole stays as it is. A surface isn't live while what it hangs on fades, unless it was brought
    // up to read meanwhile: then its face is the surface's from now on, and goes back to its own picture with it.
    if (isHole(mesh)) {
      own.delete(mesh);
      return;
    }
    // A photo hung after it faded is put in see-through copies when it comes.
    if (!own.has(mesh)) {
      own.set(mesh, mesh.material);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(seeThroughCopy) : seeThroughCopy(mesh.material);
    }
    const was = [own.get(mesh)].flat();
    for (const [i, m] of [mesh.material].flat().entries()) {
      keepUp(m, was[i]);
      m.opacity = (m.userData.opacity ?? 1) * f.level;
    }
  });
}
