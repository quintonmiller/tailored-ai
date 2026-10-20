/**
 * The layer surfaces live in: a surface goes live once it is near enough to
 * read and in view, its face turns into a hole in the picture only once the
 * page has drawn into it, and back to its own picture when it stops being
 * live; a room built again round a surface keeps it; and a point on it is
 * found from a line of sight.
 */
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prop } from "./scene";
import { SurfaceLayer } from "./surface-layer";

const STAGE_H = 700;

let layer: SurfaceLayer;
let room: THREE.Group;
let camera: THREE.PerspectiveCamera;

beforeEach(() => {
  layer = new SurfaceLayer();
  document.body.appendChild(layer.dom);
  layer.setSize(1000, STAGE_H);
  room = new THREE.Group();
  camera = new THREE.PerspectiveCamera(35, 1000 / STAGE_H, 0.05, 100);
});

afterEach(() => {
  layer.dispose();
  document.body.innerHTML = "";
});

/** A board's face on the back wall: a plane 1.32 by 0.82, facing into the room, in a picture of its own. */
function face(at: [number, number, number] = [0, 1.4, -4]) {
  const own = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.32, 0.82), own);
  mesh.position.set(...at);
  room.add(mesh);
  room.updateMatrixWorld(true);
  return { mesh, own };
}

/** The camera at a place, looking at a point, and a frame drawn. */
function look(from: [number, number, number], to: [number, number, number], now: number) {
  camera.position.set(...from);
  camera.lookAt(...to);
  camera.updateMatrixWorld(true);
  layer.update(camera, STAGE_H, () => false, now);
}

const board = { id: "0:board", label: "the task board", prop: { id: "board", kind: "board" } as Prop };

describe("SurfaceLayer", () => {
  it("makes a surface live near and in view, and a hole in the picture once the page has drawn into it", () => {
    const { mesh, own } = face();
    layer.add({ ...board, anchor: mesh, size: [1.32, 0.82], face: mesh });
    const heard = vi.fn();
    layer.subscribe(heard);
    look([0, 1.4, -2], [0, 1.4, -4], 1000);
    expect(heard).toHaveBeenLastCalledWith([expect.objectContaining({ id: "0:board", px: [845, 525] })]);
    // Not drawn into yet: the picture of it still shows, so the hole is never seen empty.
    expect(mesh.material).toBe(own);
    layer.ready("0:board");
    expect(mesh.material).not.toBe(own);
    expect((mesh.material as THREE.Material).userData.hole).toBe(true);
  });

  it("goes back to the picture of it, and lets go of the HTML, once it is far off or behind the camera", () => {
    const { mesh, own } = face();
    layer.add({ ...board, anchor: mesh, size: [1.32, 0.82], face: mesh });
    const heard = vi.fn();
    layer.subscribe(heard);
    look([0, 1.4, -2], [0, 1.4, -4], 1000);
    layer.ready("0:board");
    // Turned round: the board is behind the camera.
    look([0, 1.4, -2], [0, 1.4, 4], 2000);
    expect(heard).toHaveBeenLastCalledWith([]);
    expect(mesh.material).toBe(own);
    // Facing it again, from across a hall: too small to read.
    look([0, 1.4, 60], [0, 1.4, -4], 3000);
    expect(heard).toHaveBeenLastCalledWith([]);
  });

  it("is not live while what it hangs on is faded", () => {
    const { mesh } = face();
    layer.add({ ...board, anchor: mesh, size: [1.32, 0.82], face: mesh });
    const heard = vi.fn();
    layer.subscribe(heard);
    camera.position.set(0, 1.4, -2);
    camera.lookAt(0, 1.4, -4);
    camera.updateMatrixWorld(true);
    layer.update(camera, STAGE_H, () => true, 1000);
    expect(heard).toHaveBeenLastCalledWith([]);
  });

  it("keeps the one being read live wherever the camera is, and says so", () => {
    const { mesh } = face();
    layer.add({ ...board, anchor: mesh, size: [1.32, 0.82], face: mesh });
    const heard = vi.fn();
    layer.subscribe(heard);
    layer.focus("0:board");
    look([0, 1.4, 60], [0, 1.4, 100], 1000);
    expect(heard).toHaveBeenLastCalledWith([expect.objectContaining({ id: "0:board", focused: true })]);
    expect(layer.interactive("0:board")).toBe(false);
    layer.ready("0:board");
    expect(layer.interactive("0:board")).toBe(true);
  });

  it("keeps a surface, element and all, when the room is built again round it, and lets go of one no longer there", () => {
    const first = face();
    layer.add({ ...board, anchor: first.mesh, size: [1.32, 0.82], face: first.mesh });
    look([0, 1.4, -2], [0, 1.4, -4], 1000);
    layer.ready("0:board");
    const [was] = layer.views();
    // The room is rebuilt: the old face is put back in its picture before it goes, and the new one is a hole at once.
    layer.release();
    expect(first.mesh.material).toBe(first.own);
    layer.markStale((s) => !!s.prop);
    const again = face();
    layer.add({ ...board, anchor: again.mesh, size: [1.32, 0.82], face: again.mesh });
    layer.sweep();
    expect(layer.views()[0].el).toBe(was.el);
    expect((again.mesh.material as THREE.Material).userData.hole).toBe(true);
    // Rebuilt without it: gone.
    layer.markStale((s) => !!s.prop);
    layer.sweep();
    expect(layer.views()).toEqual([]);
    expect(layer.surfaceAt(again.mesh)).toBeUndefined();
  });

  it("tells the page again when a live surface is laid again with something new on it", () => {
    const first = face();
    layer.add({ ...board, anchor: first.mesh, size: [1.32, 0.82], face: first.mesh });
    const heard = vi.fn();
    layer.subscribe(heard);
    look([0, 1.4, -2], [0, 1.4, -4], 1000);
    layer.ready("0:board");
    // The room is rebuilt with the board renamed: the same surface, live all the while, with its new heading.
    layer.release();
    layer.markStale((s) => !!s.prop);
    const again = face();
    const renamed = { ...board.prop, label: "Trip tasks" } as Prop;
    layer.add({
      ...board,
      label: "the trip board",
      prop: renamed,
      anchor: again.mesh,
      size: [1.32, 0.82],
      face: again.mesh,
    });
    layer.sweep();
    expect(heard).toHaveBeenLastCalledWith([expect.objectContaining({ label: "the trip board", prop: renamed })]);
  });

  it("leaves a face that isn't live where it is when its surface is taken away", () => {
    const { mesh, own } = face();
    layer.add({ ...board, anchor: mesh, size: [1.32, 0.82], face: mesh });
    // Never live, and wearing something else for now (a see-through copy, while its wall fades).
    const copy = new THREE.MeshBasicMaterial({ transparent: true });
    mesh.material = copy;
    const freed = vi.spyOn(mesh.geometry, "dispose");
    layer.remove("0:board");
    expect(mesh.parent).toBe(room);
    expect(freed).not.toHaveBeenCalled();
    expect(mesh.material).toBe(copy);
    expect(mesh.material).not.toBe(own);
  });

  it("takes a surface away only for the laying of it it was asked by", () => {
    const anchor = new THREE.Object3D();
    room.add(anchor);
    const first = layer.add({ id: "note", label: "a note", anchor, size: [0.5, 0.3] });
    const second = layer.add({ id: "note", label: "a note, again", anchor, size: [0.5, 0.3] });
    // A remover from the first laying, called late: the surface laid again stays.
    layer.remove("note", first);
    expect(layer.labelOf("note")).toBe("a note, again");
    layer.remove("note", second);
    expect(layer.labelOf("note")).toBeUndefined();
  });

  it("lets go of the see-through copy a faded face wore when it is brought up to read", () => {
    const { mesh, own } = face();
    layer.add({ ...board, anchor: mesh, size: [1.32, 0.82], face: mesh });
    const copy = own.clone();
    copy.userData.opacity = 1;
    const freed = vi.spyOn(copy, "dispose");
    mesh.material = copy;
    layer.focus("0:board");
    layer.ready("0:board");
    look([0, 1.4, -2], [0, 1.4, -4], 1000);
    expect((mesh.material as THREE.Material).userData.hole).toBe(true);
    expect(freed).toHaveBeenCalled();
    // Put down, it goes back to its own picture, not the copy.
    layer.focus(undefined);
    look([0, 1.4, 60], [0, 1.4, 100], 2000);
    expect(mesh.material).toBe(own);
  });

  it("finds where a line of sight meets a surface, in its own pixels", () => {
    const { mesh } = face();
    layer.add({ ...board, anchor: mesh, size: [1.32, 0.82], face: mesh });
    const through = (x: number, y: number) =>
      layer.pointOn("0:board", new THREE.Ray(new THREE.Vector3(x, y, 0), new THREE.Vector3(0, 0, -1)));
    expect(through(0, 1.4)).toEqual([422.5, 262.5]);
    const corner = through(-0.66, 1.81);
    expect(corner?.[0]).toBeCloseTo(0);
    expect(corner?.[1]).toBeCloseTo(0);
  });
});
