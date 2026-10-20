/**
 * Models agents make, as the room draws them: parts merged by colour and
 * finish, a model fitted whole into the box the room gave it, a face on the
 * front of its part, and the picture a face shows from across a room.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ComponentSpec } from "../lib/content.js";
import { buildModel, faceAnchor, faceDensity, faceLines, fitScale, type ModelDef, mergePlan } from "./models";

// jsdom draws nothing on a canvas, and says so on every try: a picture of a face is simply left blank here.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

const shelf: ModelDef = {
  name: "bookcase",
  owner: "planner",
  mount: "floor",
  size: [0.9, 1.8, 0.34],
  parts: [
    { shape: "box", size: [0.9, 1.8, 0.04], at: [0, 0.9, -0.15], color: "#6b4a33" },
    { shape: "box", size: [0.04, 1.8, 0.34], at: [-0.43, 0.9, 0], color: "#6b4a33" },
    { shape: "box", size: [0.86, 0.03, 0.32], at: [0, 0.6, 0], color: "#b5835a" },
    { shape: "sphere", size: [0.1, 0.1, 0.1], at: [0, 1.85, 0], color: "#6b4a33", finish: "metal" },
    { shape: "box", size: [0.04, 1.8, 0.34], at: [0.43, 0.9, 0], color: "#6b4a33" },
  ],
};

describe("merging parts", () => {
  it("draws every part of one colour in one finish as one mesh, in the order first met", () => {
    expect(mergePlan(shelf.parts)).toEqual({
      groups: [
        { key: "matte:#6b4a33", parts: [0, 1, 4] },
        { key: "matte:#b5835a", parts: [2] },
        { key: "metal:#6b4a33", parts: [3] },
      ],
      faces: [],
    });
  });

  it("builds a mesh for each, whatever the shapes, and nothing else", () => {
    const mixed: ModelDef = {
      ...shelf,
      parts: (["box", "cylinder", "sphere", "cone", "torus", "capsule", "plane"] as const).map((shape, i) => ({
        shape,
        size: [0.3, 0.4, 0.3],
        at: [i * 0.4, 0.2, 0],
        turn: [0, i * 15, 0],
        color: "#2a8a8a",
      })),
    };
    const { group } = buildModel(mixed, mixed.size);
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(1);
    expect(meshes[0].geometry.getAttribute("position").count).toBeGreaterThan(500);
  });
});

describe("fitting a model in its box", () => {
  it("draws it at the scale it was placed at", () => {
    expect(fitScale([0.9, 1.8, 0.34], [1.08, 2.16, 0.41])).toBeCloseTo(1.2, 2);
    expect(fitScale([0.9, 1.8, 0.34], undefined)).toBe(1);
  });

  it("keeps a model remade bigger inside the box it was placed in, its shape kept", () => {
    expect(fitScale([1.8, 1.8, 0.34], [0.9, 1.8, 0.34])).toBeCloseTo(0.5);
  });

  it("doesn't let a plate's thinness shrink it", () => {
    expect(fitScale([1, 1, 0.01], [2, 2, 0.01])).toBeCloseTo(2);
  });

  it("stands a model on its foot, scaled about it", () => {
    const { group } = buildModel(shelf, [0.45, 0.9, 0.17]);
    const box = new THREE.Box3().setFromObject(group);
    expect(box.min.y).toBeCloseTo(0, 2);
    expect(box.max.y).toBeLessThanOrEqual(0.95);
  });

  it("shows an empty frame where a model that is gone stood", () => {
    const { group, faces } = buildModel(undefined, [1, 2, 0.5]);
    expect(faces).toEqual([]);
    const box = new THREE.Box3().setFromObject(group);
    expect(box.max.y).toBeCloseTo(2);
  });
});

describe("a face", () => {
  const spec: ComponentSpec = {
    id: "c-123456",
    kind: "list",
    props: {
      title: "To do",
      check: { field: "done" },
      items: [
        { id: "a", label: "Book the ferry", checked: true },
        { id: "b", label: "Pack", checked: false },
      ],
    },
    fallback: "",
  };

  it("goes on the front of its part, turned with it", () => {
    const front = faceAnchor({ shape: "box", size: [1, 0.6, 0.04], at: [0, 1, 0.02] });
    expect(front.size).toEqual([1, 0.6]);
    expect(front.at[1]).toBeCloseTo(1);
    expect(front.at[2]).toBeCloseTo(0.042);
    expect(front.turn).toBeUndefined();
    // Leaning back by a quarter turn, the front faces up.
    const up = faceAnchor({ shape: "box", size: [0.4, 0.3, 0.02], at: [0, 0.2, 0], turn: [-90, 0, 0] });
    expect(up.at[1]).toBeCloseTo(0.211);
    expect(up.at[2]).toBeCloseTo(0);
    // A plate's front is a plate's thickness from its middle.
    expect(faceAnchor({ shape: "plane", size: [0.5, 0.5, 0.3], at: [0, 0, 0] }).at[2]).toBeCloseTo(0.007);
  });

  it("is built with a plate of its own, as big as its part's front", () => {
    const board: ModelDef = {
      ...shelf,
      mount: "wall",
      size: [1, 0.7, 0.05],
      parts: [
        { shape: "box", size: [1, 0.7, 0.04], at: [0, 0.35, 0.02], color: "#6b4a33" },
        { shape: "box", size: [0.9, 0.66, 0.01], at: [0, 0.35, 0.045], color: "#f6f1e3", face: { kind: "list", spec } },
      ],
    };
    const { faces } = buildModel(board, board.size);
    expect(faces).toHaveLength(1);
    expect(faces[0]).toMatchObject({ part: 1, size: [0.9, 0.66], spec });
    expect(faces[0].mesh.position.z).toBeCloseTo(0.052);
    // Big enough to read laid out at a metre to 640 pixels: its HTML lies on the plate as it is.
    expect(faces[0].surface).toEqual([0.9, 0.66]);
  });

  it("lays a small face's page out denser, scaled down to fit, so it reads sharp close up", () => {
    expect(faceDensity([1, 0.7])).toBe(1);
    expect(faceDensity([0.42, 0.3])).toBeCloseTo(400 / 192);
    expect(faceDensity([0.1, 0.1])).toBe(3);
    const card: ModelDef = {
      ...shelf,
      mount: "on",
      size: [0.42, 0.3, 0.02],
      parts: [
        { shape: "box", size: [0.42, 0.3, 0.02], at: [0, 0.15, 0], color: "#efe6d2", face: { kind: "card", spec } },
      ],
    };
    const [face] = buildModel(card, card.size).faces;
    expect(face.surface[1]).toBeCloseTo(0.3 * (400 / 192));
    // Whatever it is laid out at, it covers the plate: its anchor is scaled back down by as much.
    expect(face.anchor.scale.x * face.surface[0]).toBeCloseTo(0.42);
    expect(face.anchor.parent).toBe(face.mesh);
  });

  it("shows from across a room the title and the lines its component last had, ticks and all", () => {
    expect(faceLines(spec)).toEqual({
      title: "To do",
      lines: [
        { text: "Book the ferry", ticked: true },
        { text: "Pack", ticked: false },
      ],
    });
    expect(
      faceLines({ ...spec, kind: "card", props: { title: "Notes", fields: [{ label: "note", value: "Hi" }] } }).lines,
    ).toEqual([{ text: "note: Hi" }]);
    expect(
      faceLines({ ...spec, kind: "table", props: { title: "Bills", rows: [{ id: "x", cells: ["Rent", "900"] }] } })
        .lines,
    ).toEqual([{ text: "Rent" }]);
    expect(faceLines(undefined)).toEqual({ title: "", lines: [] });
  });
});
