/**
 * Fading what is in the way: drawn in see-through copies while faded, its
 * own materials back once it is not, and the copies keeping up with what the
 * room changes on the originals meanwhile.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
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
});
