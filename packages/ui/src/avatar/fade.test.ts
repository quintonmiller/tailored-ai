/**
 * Fading what is in the way: drawn in see-through copies while faded, its
 * own materials back once it is not, and the copies keeping up with what the
 * room changes on the originals meanwhile.
 */
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { type Fadeable, paintFaded } from "./fade";

/** A door, near enough: a plate that lights under the pointer, and a light that says who is behind it. */
function door() {
  const plate = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.2 });
  const light = new THREE.MeshBasicMaterial({ color: 0xe6eaf0 });
  const group = new THREE.Group();
  const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.3), plate);
  const lightMesh = new THREE.Mesh(new THREE.SphereGeometry(0.08), light);
  group.add(plateMesh, lightMesh);
  return { group, plate, light, plateMesh, lightMesh };
}

describe("paintFaded", () => {
  it("fades in see-through copies, leaving the materials it was built with as they were, and puts them back", () => {
    const d = door();
    const f: Fadeable = { group: d.group, level: 0.3 };
    paintFaded(f);
    const copy = d.plateMesh.material as THREE.MeshStandardMaterial;
    expect(copy).not.toBe(d.plate);
    expect(copy.transparent).toBe(true);
    expect(copy.opacity).toBeCloseTo(0.3, 6);
    expect(d.plate.opacity).toBe(1);
    expect(d.plate.transparent).toBe(false);
    f.level = 1;
    paintFaded(f);
    expect(d.plateMesh.material).toBe(d.plate);
    expect(d.lightMesh.material).toBe(d.light);
    expect(f.own).toBeUndefined();
  });

  it("keeps up with a door's light changing colour and its plate lighting up while it is faded", () => {
    const d = door();
    const f: Fadeable = { group: d.group, level: 0.22 };
    paintFaded(f);
    // Whoever is behind the door starts something, and the pointer comes over the door.
    d.light.color.setHex(0x55cc77);
    d.plate.emissiveIntensity = 0.9;
    paintFaded(f);
    expect((d.lightMesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x55cc77);
    expect((d.plateMesh.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.9);
    // Back to itself, it shows them too: they were made on its own materials.
    f.level = 1;
    paintFaded(f);
    expect((d.lightMesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x55cc77);
  });

  it("leaves a surface's hole alone, even one put on while it was faded, and lets go of it", () => {
    const d = door();
    const f: Fadeable = { group: d.group, level: 0.3 };
    paintFaded(f);
    // The plate is a surface brought up to read meanwhile: its face is a hole now (`surface-layer.ts`).
    const hole = new THREE.MeshBasicMaterial({ opacity: 0 });
    hole.userData.hole = true;
    const freed = vi.spyOn(hole, "dispose");
    (d.plateMesh as THREE.Mesh).material = hole;
    paintFaded(f);
    expect(d.plateMesh.material).toBe(hole);
    // The wall comes back while it is still read: the hole stays, the rest go back to their own.
    f.level = 1;
    paintFaded(f);
    expect(d.plateMesh.material).toBe(hole);
    expect(freed).not.toHaveBeenCalled();
    expect(d.lightMesh.material).toBe(d.light);
  });

  it("fades a surface's face afresh once it is put down while its wall is still faded", () => {
    const d = door();
    const f: Fadeable = { group: d.group, level: 0.3 };
    paintFaded(f);
    const hole = new THREE.MeshBasicMaterial({ opacity: 0 });
    hole.userData.hole = true;
    (d.plateMesh as THREE.Mesh).material = hole;
    paintFaded(f);
    // Put down: the surface gives the face its own picture back (`surface-layer.ts`), and the wall is still faded.
    d.plateMesh.material = d.plate;
    paintFaded(f);
    expect(d.plateMesh.material).not.toBe(d.plate);
    expect((d.plateMesh.material as THREE.Material).transparent).toBe(true);
    expect(d.plate.opacity).toBe(1);
  });

  it("leaves a hole put on in the frame the fading ends", () => {
    const d = door();
    const f: Fadeable = { group: d.group, level: 0.3 };
    paintFaded(f);
    const hole = new THREE.MeshBasicMaterial({ opacity: 0 });
    hole.userData.hole = true;
    (d.plateMesh as THREE.Mesh).material = hole;
    f.level = 1;
    paintFaded(f);
    expect(d.plateMesh.material).toBe(hole);
  });
});
