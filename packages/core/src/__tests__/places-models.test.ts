/**
 * Models agents make from parts: what the agent wrote read into a sound
 * model, or a sentence saying what is wrong; the box it fills; where it
 * stands; its faces; and the ready-made ones every agent can place.
 */
import { describe, expect, it } from "vitest";
import { KINDS } from "../plugins/places-layout.js";
import {
  bounds,
  describeModel,
  faceArgs,
  faceFrom,
  facesOf,
  isModelKind,
  MODEL_LIMITS,
  MOUNT_KIND,
  type Model,
  type ModelFace,
  modelFrom,
  modelName,
  nameProblem,
  partFrom,
  partsToCopy,
  READY,
  sameFace,
  sizeOf,
} from "../plugins/places-models.js";

const box = (extra: Record<string, unknown> = {}) => ({ shape: "box", size: [0.5, 1, 0.4], at: [0, 0.5, 0], ...extra });

/** A model that must be made, and what it became. */
function made(parts: unknown[], mount?: string): Model {
  const out = modelFrom({ name: "thing", owner: "planner", parts, ...(mount ? { mount } : {}) });
  if (typeof out === "string") throw new Error(out);
  return out;
}

/** Why a model can't be made. */
function refused(parts: unknown[], mount?: string): string {
  const out = modelFrom({ name: "thing", owner: "planner", parts, ...(mount ? { mount } : {}) });
  expect(typeof out, JSON.stringify(out)).toBe("string");
  return out as string;
}

describe("reading a part", () => {
  it("takes numbers as lists, as text, or one number for a cube", () => {
    expect(partFrom({ shape: "box", size: "0.5 1 0.4", at: [0, 0.5, 0] }, 1)).toMatchObject({ size: [0.5, 1, 0.4] });
    expect(partFrom({ shape: "box", size: "0.5x1x0.4" }, 1)).toMatchObject({ size: [0.5, 1, 0.4] });
    expect(partFrom({ shape: "sphere", size: 0.3 }, 1)).toMatchObject({ size: [0.3, 0.3, 0.3] });
    expect(partFrom({ shape: "box", size: ["0.2", "0.2", "0.2"] }, 1)).toMatchObject({ size: [0.2, 0.2, 0.2] });
  });

  it("stands a part with no place on the model's floor, in the middle", () => {
    expect(partFrom({ shape: "cylinder", size: [0.2, 0.8, 0.2] }, 1)).toMatchObject({ at: [0, 0.4, 0] });
  });

  it("refuses numbers that aren't finite, or sizes out of bounds, naming the part", () => {
    expect(partFrom({ shape: "box", size: [0.5, Number.NaN, 0.5] }, 3)).toMatch(/^Part 3: `size`/);
    expect(partFrom({ shape: "box", size: [0.5, Number.POSITIVE_INFINITY, 0.5] }, 1)).toMatch(/`size`/);
    expect(partFrom({ shape: "box", size: [0.5, 9, 0.5] }, 2)).toMatch(/^Part 2: each side is 0.01 to 3 m/);
    expect(partFrom({ shape: "box", size: [0.5, 0.5, 0.001] }, 1)).toMatch(/each side/);
    expect(partFrom({ shape: "box", size: [0.5, 0.5, 0.5], at: [0, 40, 0] }, 1)).toMatch(/within 3 m/);
    expect(partFrom({ shape: "box", size: [0.5, 0.5, 0.5], at: [0, "high", 0] }, 1)).toMatch(/`at`/);
    expect(partFrom({ shape: "box", size: [0.5, 0.5, 0.5], turn: [0, "x", 0] }, 1)).toMatch(/`turn`/);
  });

  it("knows shapes and finishes by other words", () => {
    expect(partFrom({ shape: "cube", size: 0.3 }, 1)).toMatchObject({ shape: "box" });
    expect(partFrom({ shape: "Ball", size: 0.3 }, 1)).toMatchObject({ shape: "sphere" });
    expect(partFrom({ shape: "ring", size: [0.3, 0.05, 0.3] }, 1)).toMatchObject({ shape: "torus" });
    expect(partFrom({ shape: "panel", size: [0.3, 0.3, 0.01] }, 1)).toMatchObject({ shape: "plane" });
    expect(partFrom({ shape: "box", size: 0.3, finish: "shiny" }, 1)).toMatchObject({ finish: "glossy" });
    expect(partFrom({ shape: "box", size: 0.3, finish: "chrome" }, 1)).toMatchObject({ finish: "metal" });
    expect(partFrom({ shape: "pyramid", size: 0.3 }, 1)).toMatch(/`shape` is one of box, cylinder/);
    expect(partFrom({ shape: "box", size: 0.3, finish: "velvet" }, 1)).toMatch(/`finish` is one of/);
  });

  it("reads colours by name or hex, and leaves matte and no turn unsaid", () => {
    const part = partFrom({ shape: "box", size: 0.3, color: "dark green", finish: "matte", turn: 0 }, 1);
    expect(part).toMatchObject({ color: "#315b30" });
    expect(part).not.toHaveProperty("finish");
    expect(part).not.toHaveProperty("turn");
    expect(partFrom({ shape: "box", size: 0.3, color: "sparkly" }, 1)).toMatch(/"sparkly" isn't a colour/);
    expect(partFrom({ shape: "box", size: 0.3, turn: 45 }, 1)).toMatchObject({ turn: [0, 45, 0] });
    expect(partFrom({ shape: "box", size: 0.3, turn: [0, 270, 0] }, 1)).toMatchObject({ turn: [0, -90, 0] });
  });

  it("puts a face only on the front of a box or a plane big enough to read", () => {
    const face = { kind: "card", title: "Hello" };
    expect(partFrom({ shape: "box", size: [0.6, 0.4, 0.02], face }, 1)).toMatchObject({ face: { kind: "card" } });
    expect(partFrom({ shape: "sphere", size: 0.5, face }, 4)).toMatch(/^Part 4: a face goes on the front of a box/);
    expect(partFrom({ shape: "box", size: [0.06, 0.4, 0.02], face }, 1)).toMatch(/at least 12 cm wide/);
  });
});

describe("a face", () => {
  it("lifts which records it shows, and its title, from where small models put them", () => {
    expect(faceFrom({ kind: "list", type: "todo", where: { done: false }, check: "done", name: "Chores" })).toEqual({
      kind: "list",
      props: { title: "Chores", check: { field: "done" } },
      bind: { type: "todo", where: { done: false } },
    });
    expect(
      faceFrom({ props: { title: "Bills" }, bind: { type: "bill" }, kind: "table", columns: '["payee"]' }),
    ).toEqual({
      kind: "table",
      props: { title: "Bills", columns: ["payee"] },
      bind: { type: "bill" },
    });
  });

  it("works out what it is when not told: a record by id a card, records a list, columns a table", () => {
    expect(faceFrom({ bind: { type: "note", id: "fridge" } })).toMatchObject({ kind: "card" });
    expect(faceFrom({ bind: { type: "todo" } })).toMatchObject({ kind: "list" });
    expect(faceFrom({ bind: { type: "bill" }, columns: ["payee"] })).toMatchObject({ kind: "table" });
  });

  it("shows only what can be used by whoever is in the room", () => {
    expect(faceFrom({ kind: "choice", question: "?" })).toMatch(/card, a list or a table, not a choice/);
    expect(faceFrom({ kind: "card", title: "Plan", actions: [{ label: "Yes", effect: "reply" }] })).toMatch(
      /can't reply: a face is used by whoever is in the room/,
    );
  });

  it("makes a button with a patch write state, and one without announce an event", () => {
    const face = faceFrom({
      kind: "card",
      bind: { type: "plan", id: "trip" },
      actions: [{ label: "Start", patch: { status: "active" } }, { label: "Ring" }],
    }) as ModelFace;
    expect(face.actions).toEqual([
      { label: "Start", effect: "state", patch: { status: "active" } },
      { label: "Ring", effect: "event" },
    ]);
    expect(faceFrom({ kind: "card", title: "Plan", actions: [{ label: "Go", patch: { a: 1 } }] })).toMatch(
      /the card needs `bind`/,
    );
    expect(
      faceFrom({ kind: "card", bind: { type: "plan", id: "t" }, actions: [{ label: "Go", effect: "state" }] }),
    ).toMatch(/give it a `patch`/);
  });

  it("says what is missing or doesn't belong", () => {
    expect(faceFrom({ kind: "card" })).toMatch(/needs a `title`/);
    expect(faceFrom({ kind: "list", title: "x" })).toMatch(/give `bind` with their type/);
    expect(faceFrom({ kind: "card", bind: { type: "note" } })).toMatch(/`bind` is \{type, id\}/);
    expect(faceFrom({ kind: "table", bind: { type: "bill" }, check: "paid" })).toMatch(/takes title, columns; `check`/);
    expect(faceFrom({ kind: "list", bind: { type: "todo" }, actions: [{ label: "x" }] })).toMatch(
      /Only a card has buttons/,
    );
    expect(faceFrom({ kind: "list", bind: { type: "todo" }, check: {} })).toMatch(/names the field a tick flips/);
  });

  it("is the same face whatever component shows it, and is sent as the interface tool takes it", () => {
    const a = faceFrom({ kind: "list", bind: { type: "todo" }, title: "To do" }) as ModelFace;
    expect(sameFace(a, { ...a, component: "c-123456" })).toBe(true);
    expect(sameFace(a, { ...a, props: { title: "Done" } })).toBe(false);
    expect(faceArgs(a)).toEqual({ kind: "list", props: { title: "To do" }, bind: { type: "todo" } });
  });
});

describe("a whole model", () => {
  it("stands where a room expects it: foot on the floor, middle at the origin", () => {
    const model = made([box({ at: [2, -0.3, 1] }), box({ at: [2.5, 0.7, 1], size: [0.5, 1, 0.4] })]);
    const [min, max] = bounds(model.parts);
    expect(min[1]).toBeCloseTo(0);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0);
    expect((min[2] + max[2]) / 2).toBeCloseTo(0);
    expect(model.size).toEqual([1, 2, 0.4]);
  });

  it("hangs something for a wall with its back against it", () => {
    const model = made([box({ at: [0, 1, 0.5], size: [1, 0.6, 0.04] })], "wall");
    const [min] = bounds(model.parts);
    expect(min[2]).toBeCloseTo(0);
    expect(min[1]).toBeCloseTo(0);
    expect(model.mount).toBe("wall");
  });

  it("measures parts as turned", () => {
    const flat = made([{ shape: "box", size: [1, 0.2, 0.4] }]);
    const turned = made([{ shape: "box", size: [1, 0.2, 0.4], turn: [0, 90, 0] }]);
    expect(flat.size).toEqual([1, 0.2, 0.4]);
    expect(turned.size).toEqual([0.4, 0.2, 1]);
    // Stood on end by a quarter turn about z: as tall as it was wide.
    expect(made([{ shape: "box", size: [1, 0.2, 0.4], turn: [0, 0, 90] }]).size).toEqual([0.2, 1, 0.4]);
    // A plate is as thin as a plate, whatever depth it was given.
    expect(sizeOf(made([{ shape: "plane", size: [1, 1, 0.5] }]).parts)).toEqual([1, 1, 0.01]);
  });

  it("refuses a model too big for where it goes, saying how big it is", () => {
    expect(refused([box({ size: [1.5, 0.4, 0.4] })], "on")).toMatch(
      /1.5 × 0.4 × 0.4 m: too wide for something on a desk/,
    );
    expect(refused([box({ size: [1, 1, 0.9] })], "wall")).toMatch(/too deep for something on a wall/);
    expect(made([box({ size: [1, 1, 0.5] })], "wall").size).toEqual([1, 1, 0.5]);
  });

  it("keeps to its limits on parts and faces", () => {
    expect(refused([])).toMatch(/at least one part/);
    const many = Array.from({ length: MODEL_LIMITS.parts + 1 }, () => box());
    expect(refused(many)).toMatch(/at most 40 parts; this one has 41/);
    const faced = Array.from({ length: MODEL_LIMITS.faces + 1 }, () =>
      box({ face: { kind: "card", title: "Hi" }, size: [0.5, 0.5, 0.02] }),
    );
    expect(refused(faced)).toMatch(/at most 4 faces; this one has 5/);
    expect(refused([box()], "ceiling")).toMatch(/`mount` is where it goes/);
  });

  it("passes the first bad part's sentence back", () => {
    expect(refused([box(), { shape: "box", size: [1, -1, 1] }])).toMatch(/^Part 2: /);
  });

  it("reads back part by part, faces and all, and copies without the component showing a face", () => {
    const model = made([
      box({ color: "teal" }),
      box({
        size: [0.5, 0.4, 0.02],
        at: [0, 1.2, 0.19],
        face: { kind: "list", bind: { type: "todo" }, check: "done" },
      }),
    ]);
    model.parts[1].face = { ...(model.parts[1].face as ModelFace), component: "c-abcdef" };
    const words = describeModel(model);
    expect(words).toMatch(/^thing: stands on the floor, 0.5 × 1.4 × 0.4 m\./);
    expect(words).toMatch(/1\. box 0.5 × 1 × 0.4 m at \(0, 0.5, 0\), #2a8a8a/);
    expect(words).toMatch(/2\. box .* with a face: a list of todo records; a tick flips done/);
    expect(facesOf(model)).toHaveLength(1);
    expect(JSON.stringify(partsToCopy(model))).not.toMatch(/c-abcdef/);
  });
});

describe("names", () => {
  it("reads a name the way it would be typed, and keeps clear of the room's own kinds", () => {
    expect(modelName("My Reading Nook")).toBe("reading_nook");
    expect(modelName("the to-do board")).toBe("to_do_board");
    expect(modelName("!!!")).toBeUndefined();
    expect(nameProblem("couch")).toMatch(/already a kind of thing a room has \(couch\)/);
    expect(nameProblem("coffee_table")).toMatch(/already a kind/);
    expect(nameProblem("bookcase")).toBeUndefined();
  });

  it("gives each mount a kind of its own that the room lays out by size", () => {
    for (const kind of Object.values(MOUNT_KIND)) {
      expect(KINDS[kind]?.shaped).toBe(true);
      expect(isModelKind(kind)).toBe(true);
    }
    expect(KINDS[MOUNT_KIND.wall].mount).toBe("wall");
    expect(KINDS[MOUNT_KIND.on].mount).toBe("on");
    expect(isModelKind("block")).toBe(false);
  });
});

describe("ready-made models", () => {
  it("are each a sound model that fits where it goes, with the face it is for", () => {
    for (const ready of READY) {
      const model = modelFrom({
        name: ready.name,
        owner: "planner",
        mount: ready.mount,
        parts: ready.parts("planner"),
      });
      expect(typeof model, `${ready.name}: ${model}`).toBe("object");
      expect(facesOf(model as Model)).toHaveLength(1);
      expect(nameProblem(ready.name)).toBeUndefined();
    }
  });

  it("show the agent's own records: a notes card the agent's own note", () => {
    const notes = READY.find((r) => r.name === "notes_card");
    const model = modelFrom({ name: "notes_card", owner: "writer", mount: "on", parts: notes?.parts("writer") ?? [] });
    expect(facesOf(model as Model)[0].face.bind).toEqual({ type: "note", id: "writer-notes" });
    expect(notes?.seeds?.("writer")[0]).toMatchObject({ type: "note", id: "writer-notes" });
  });
});
