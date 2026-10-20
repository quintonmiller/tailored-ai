/**
 * The `build` tool and the models it keeps: a model made from parts is the
 * agent's own record, the `place` tool adds it to a room by name, a face on
 * it is a live interface made as the agent (so its query runs as the agent
 * and a tick writes as the person), and remaking a model keeps, changes or
 * closes its faces rather than leaving them broken.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { respondToComponent } from "../interfaces/respond.js";
import { InterfaceStore } from "../interfaces/store.js";
import { homeId, PLACE_TYPE, PlaceTool, readHome } from "../plugins/places.js";
import { BuildTool, ModelShelf, modelsIn } from "../plugins/places-build.js";
import { applyEdit } from "../plugins/places-edit.js";
import { firstHome, type Place, type PlaceItem, placeProblems } from "../plugins/places-layout.js";
import { FACE_TYPES, MODEL_SCHEMA, MODEL_TYPE, type Model } from "../plugins/places-models.js";
import "../state/builtin.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { ToolContext } from "../tools/interface.js";

const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
const as = (agentName: string): ToolContext => ({ agentName, sessionId: `s-${agentName}` }) as ToolContext;

const bookcase = [
  { shape: "box", size: [0.9, 1.8, 0.04], at: [0, 0.9, -0.15], color: "walnut" },
  { shape: "box", size: [0.04, 1.8, 0.34], at: [-0.43, 0.9, 0], color: "walnut" },
  { shape: "box", size: [0.04, 1.8, 0.34], at: [0.43, 0.9, 0], color: "walnut" },
  { shape: "box", size: [0.86, 0.03, 0.32], at: [0, 0.6, 0], color: "oak" },
  { shape: "box", size: [0.86, 0.03, 0.32], at: [0, 1.2, 0], color: "oak" },
];

const board = (face: Record<string, unknown>) => [
  { shape: "box", size: [1, 0.7, 0.04], at: [0, 0.35, 0.02], color: "walnut" },
  { shape: "box", size: [0.9, 0.6, 0.01], at: [0, 0.35, 0.045], color: "ivory", face },
];

describe("the build tool", () => {
  let db: Database.Database;
  let state: StateService;
  let store: InterfaceStore;
  let build: BuildTool;
  let place: PlaceTool;
  const bodies = new Set(["planner", "writer"]);

  beforeEach(() => {
    db = new Database(":memory:");
    const types = [
      { name: PLACE_TYPE, scope: "agent" as const },
      { name: MODEL_TYPE, scope: "agent" as const, title: "name", schema: MODEL_SCHEMA as never },
      ...FACE_TYPES.map((t) => ({ ...t, schema: t.schema as never })),
    ];
    state = new StateService({ getConfig: () => ({ state: { backend: "sqlite", types } }), db });
    // A clock that moves on with every write, so a component written again shows it.
    let clock = Date.parse("2026-10-19T09:00:00Z");
    store = new InterfaceStore(db, () => new Date((clock += 1000)));
    const shelf = new ModelShelf(
      () => state,
      () => store,
    );
    build = new BuildTool(shelf);
    place = new PlaceTool(
      () => state,
      (agent) => bodies.has(agent ?? "default"),
      undefined,
      undefined,
      undefined,
      undefined,
      shelf,
    );
  });

  const model = async (id: string) => (await state.get(owner, { type: MODEL_TYPE, id }))?.data as unknown as Model;
  const home = async (agent: string) => (await readHome(state, owner, agent)).place;
  const thing = (p: Place, kind: string) => p.props.find((i) => i.kind === kind) as PlaceItem;

  it("keeps a model as the agent's own record, and reads it back part by part", async () => {
    const made = await build.execute(
      { action: "make", name: "Bookcase", parts: bookcase, about: "for the travel guides" },
      as("planner"),
    );
    expect(made.success, made.error).toBe(true);
    expect(String(made.output)).toMatch(/^Made bookcase \(floor, 0.9 × 1.8 × 0.34 m, 5 parts\)/);
    const record = await state.get(owner, { type: MODEL_TYPE, id: "planner:bookcase" });
    expect(record).toMatchObject({ scope: "agent:planner", updatedBy: { kind: "agent", name: "planner" } });
    expect(String((await build.execute({ action: "show", name: "bookcase" }, as("planner"))).output)).toMatch(
      /2\. box 0.04 × 1.8 × 0.34 m at \(-0.43, 0.9, 0\), #6b4a33/,
    );
    expect(String((await build.execute({ action: "list" }, as("planner"))).output)).toMatch(
      /Your models:\n- bookcase \(floor.*\): for the travel guides/,
    );
    // Another agent can't see it: its own list is empty.
    expect(String((await build.execute({ action: "list" }, as("writer"))).output)).toMatch(/no models yet/);
  });

  it("refuses a bad model with a sentence it can act on, and saves nothing", async () => {
    const bad = await build.execute(
      { action: "make", name: "lamp_post", parts: [{ shape: "box", size: [0.2, "tall", 0.2] }] },
      as("planner"),
    );
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/^Part 1: `size`/);
    expect(await model("planner:lamp_post")).toBeUndefined();
    expect((await build.execute({ action: "make", name: "couch", parts: bookcase }, as("planner"))).error).toMatch(
      /already a kind of thing a room has/,
    );
  });

  it("adds a model to a room by its name, laid out by the box it fills", async () => {
    await build.execute({ action: "make", name: "bookcase", parts: bookcase }, as("planner"));
    const added = await place.execute({ action: "add", kind: "bookcase" }, as("planner"));
    expect(added.success, added.error).toBe(true);
    const room = await home("planner");
    const it = thing(room, "model");
    expect(it).toMatchObject({ model: "planner:bookcase", size: [0.9, 1.8, 0.34], name: "the bookcase" });
    expect(placeProblems(room)).toEqual([]);
    const look = String((await place.execute({ action: "look" }, as("planner"))).output);
    expect(look).toMatch(/the bookcase \(model bookcase, 0.9 × 1.8 × 0.34 m\)/);
    expect(look).toMatch(/- models, by name: bookcase, todo_board, habit_tracker, notes_card/);
    // Bigger by a scale, it fills a bigger box; a size or a colour belongs to its parts.
    expect((await place.execute({ action: "change", item: "the bookcase", scale: 1.2 }, as("planner"))).success).toBe(
      true,
    );
    expect(thing(await home("planner"), "model").size).toEqual([1.08, 2.16, 0.41]);
    const sized = await place.execute({ action: "change", item: "the bookcase", size: "1 1 1" }, as("planner"));
    expect(sized.error).toMatch(/as big as its parts make it/);
    const painted = await place.execute({ action: "change", item: "the bookcase", color: "red" }, as("planner"));
    expect(painted.error).toMatch(/keeps its parts' own colours/);
  });

  it("makes a ready-made model the agent's own the first time it is placed, its face live as the agent", async () => {
    const added = await place.execute({ action: "add", kind: "todo_board" }, as("planner"));
    expect(added.success, added.error).toBe(true);
    expect(thing(await home("planner"), "wall_model")).toMatchObject({ model: "planner:todo_board" });
    const made = await model("planner:todo_board");
    expect(made).toMatchObject({ owner: "planner", mount: "wall", from: "todo_board" });
    const face = made.parts.find((p) => p.face)?.face;
    const component = store.get(face?.component ?? "");
    expect(component).toMatchObject({ agent: "planner", status: "open" });
    // Its list runs as the agent: the scopes it could see, kept.
    expect(component?.spec.query).toEqual({ type: "todo", limit: 12, scopes: ["agent:planner", "global"] });
  });

  it("lets a person tick a to-do on a face, writing as the person, and only one the agent could see", async () => {
    await place.execute({ action: "add", kind: "todo_board" }, as("planner"));
    const planner = { actor: { kind: "agent" as const, name: "planner" } };
    const writer = { actor: { kind: "agent" as const, name: "writer" } };
    const mine = await state.put(planner, { type: "todo", data: { title: "Book the ferry" } });
    const theirs = await state.put(writer, { type: "todo", data: { title: "Draft chapter two" } });
    const id = (await model("planner:todo_board")).parts.find((p) => p.face)?.face?.component as string;

    const ticked = await respondToComponent(
      store,
      undefined,
      { id, actionId: `check:${mine.id}`, by: "owner" },
      { state },
    );
    expect(ticked).toMatchObject({ effect: "state", record: { data: { title: "Book the ferry", done: true } } });
    expect((await state.get(owner, { type: "todo", id: mine.id }))?.updatedBy).toEqual({ kind: "user", name: "owner" });
    // Another agent's to-do isn't on this board, whatever is sent.
    await expect(
      respondToComponent(store, undefined, { id, actionId: `check:${theirs.id}`, by: "owner" }, { state }),
    ).rejects.toThrow(/no longer on this list/);
  });

  it("keeps a face's component when the model is made again with the same face, and changes it in place when not", async () => {
    const face = { kind: "list", title: "Chores", bind: { type: "todo" }, check: "done" };
    await build.execute({ action: "make", name: "chores", mount: "wall", parts: board(face) }, as("planner"));
    const first = (await model("planner:chores")).parts[1].face?.component as string;
    const written = store.get(first)?.updatedAt;

    await build.execute(
      { action: "add", name: "chores", parts: [{ shape: "sphere", size: 0.04, at: [0.48, 0.68, 0.05] }] },
      as("planner"),
    );
    expect((await model("planner:chores")).parts[1].face?.component).toBe(first);
    // The same face isn't even written again.
    expect(store.get(first)?.updatedAt).toBe(written);

    await build.execute(
      { action: "make", name: "chores", parts: board({ ...face, title: "Today's chores" }) },
      as("planner"),
    );
    expect((await model("planner:chores")).parts[1].face?.component).toBe(first);
    expect(store.get(first)?.spec.props.title).toBe("Today's chores");

    // Taken off: the face stops taking ticks.
    const removed = await build.execute({ action: "remove", name: "chores", part: [2] }, as("planner"));
    expect(removed.success, removed.error).toBe(true);
    expect(store.get(first)?.status).toBe("closed");
  });

  it("passes back what is wrong with a face, leaving nothing half made", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM interface_components WHERE status = 'open'").get() as {
      n: number;
    };
    const wrong = await build.execute(
      {
        action: "make",
        name: "two_faces",
        mount: "wall",
        parts: [
          ...board({ kind: "list", title: "Fine", bind: { type: "todo" } }),
          {
            shape: "plane",
            size: [0.4, 0.3, 0.01],
            at: [0, 1, 0.05],
            face: { kind: "list", bind: { type: "nothing" } },
          },
        ],
      },
      as("planner"),
    );
    expect(wrong.success).toBe(false);
    expect(wrong.error).toMatch(/^Part 3's face: .*no state type called "nothing"/);
    expect(await model("planner:two_faces")).toBeUndefined();
    const after = db.prepare("SELECT COUNT(*) AS n FROM interface_components WHERE status = 'open'").get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
    const replying = await build.execute(
      {
        action: "make",
        name: "asker",
        parts: board({ kind: "card", title: "Go?", actions: [{ label: "Yes", effect: "reply" }] }),
      },
      as("planner"),
    );
    expect(replying.error).toMatch(/can't reply/);
  });

  it("copies a ready-made model under a new name, with the record its face shows", async () => {
    const copied = await build.execute({ action: "copy", name: "notes_card", as: "desk_note" }, as("writer"));
    expect(copied.success, copied.error).toBe(true);
    const made = await model("writer:desk_note");
    expect(made).toMatchObject({ from: "notes_card", mount: "on" });
    expect(await state.get(owner, { type: "note", id: "writer-notes" })).toMatchObject({ scope: "agent:writer" });
    const card = store.get(made.parts.find((p) => p.face)?.face?.component ?? "");
    expect(card?.spec).toMatchObject({ kind: "card", bind: { type: "note", id: "writer-notes" } });
    // The ready-made one wasn't made the agent's own along the way.
    expect(await model("writer:notes_card")).toBeUndefined();
  });

  it("deletes a model and closes its faces", async () => {
    await build.execute(
      { action: "make", name: "chores", mount: "wall", parts: board({ title: "Chores", bind: { type: "todo" } }) },
      as("planner"),
    );
    const id = (await model("planner:chores")).parts[1].face?.component as string;
    const gone = await build.execute({ action: "delete", name: "chores" }, as("planner"));
    expect(gone.success, gone.error).toBe(true);
    expect(await model("planner:chores")).toBeUndefined();
    expect(store.get(id)?.status).toBe("closed");
  });

  it("hands the page each model in a place, with the component on each face", async () => {
    await place.execute({ action: "add", kind: "todo_board" }, as("planner"));
    const room = await home("planner");
    const shown = await modelsIn(state, owner, store, room.props);
    const face = shown["planner:todo_board"].parts.find((p) => p.face)?.face as { spec?: { kind: string } };
    expect(face.spec?.kind).toBe("list");
    expect(Object.keys(shown)).toEqual(["planner:todo_board"]);
  });
});

describe("a person adding a model", () => {
  it("puts it in from the catalogue, by the box it fills, and copies it as a model", () => {
    const out = applyEdit(homeId("planner"), firstHome(), {
      op: "add",
      kind: "model",
      model: "planner:bookcase",
      size: [0.9, 1.8, 0.34],
      name: "bookcase",
    });
    if (typeof out === "string") throw new Error(out);
    const added = out.place.props.find((p) => p.id === out.item) as PlaceItem;
    expect(added).toMatchObject({
      kind: "model",
      model: "planner:bookcase",
      size: [0.9, 1.8, 0.34],
      name: "the bookcase",
    });
    const copy = applyEdit(homeId("planner"), out.place, { op: "add", kind: "model", like: added.id });
    if (typeof copy === "string") throw new Error(copy);
    expect(copy.place.props.find((p) => p.id === copy.item)).toMatchObject({ model: "planner:bookcase" });
    expect(applyEdit(homeId("planner"), firstHome(), { op: "add", kind: "model" })).toMatch(/Say which model/);
  });
});
