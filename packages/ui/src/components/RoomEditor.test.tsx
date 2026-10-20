/**
 * Rearranging a room yourself: each change is asked of the server, then
 * written to the place's record with the version it was made to, as yours;
 * a change the server refuses goes back and says why; one that crosses an
 * agent's says who changed the room instead of writing over it; and undo
 * takes your own changes back, the first change of a meeting room by
 * letting it be drawn fresh again. The server is faked.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Move } from "../avatar/editing";
import { DEFAULT_ROOM, type Room } from "../avatar/scene";
import type { MapPlace } from "../lib/wayfinding";
import { type EditablePlace, type RoomEditor, recordOf, useRoomEditor } from "./RoomEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const kinds = {
  couch: { noun: "couch", mount: "floor", footprint: [1.6, 0.8], height: 0.8 },
  plant: { noun: "plant", mount: "floor", footprint: [0.34, 0.34], height: 1 },
  picture: { noun: "picture", mount: "wall", footprint: [0.9, 0.04], height: 0.6, elevation: 1.55 },
  model: { noun: "model", mount: "floor", footprint: [0.5, 0.5], height: 0.5, shaped: true },
};

/** A model an agent made, as the catalogue lists it and as a place is sent it. */
const bookcase = { id: "planner:bookcase", name: "bookcase", owner: "planner", kind: "model", size: [0.9, 1.8, 0.34] };
/** One the home's own agent made, which the catalogue offers before anyone else's. */
const nook = { id: "assistant:reading_nook", name: "reading_nook", owner: "assistant", kind: "model", size: [1, 1, 1] };
const bookcaseDef = {
  name: "bookcase",
  owner: "planner",
  mount: "floor",
  size: [0.9, 1.8, 0.34],
  parts: [{ shape: "box", size: [0.9, 1.8, 0.34], at: [0, 0.9, 0], color: "#6b4a33" }],
};

/** The fake server: what each write was sent, and how the next ones answer. */
interface Server {
  edits: { id: string; place: Room; edit: Record<string, unknown> }[];
  writes: { url: string; data: Room; expectedVersion: number; scope?: string }[];
  deletes: string[];
  /** The version the record is at; a write expecting another is refused. */
  version: number;
  /** Who wrote it last, for a refused write's notice, and what it holds. */
  by: { kind: string; name: string };
  data?: Room;
  /** Held until it settles: the server thinking about a change, while the page may hear of another. */
  hold?: Promise<void>;
  /** What the server says of a change: the room it makes, or why not. */
  answer: (
    edit: Record<string, unknown>,
    place: Room,
  ) => { place?: Room; item?: string; why?: string; models?: Record<string, unknown>; far?: unknown };
  /** The versions other places' records are at, by URL: the far side of a door put in. */
  others?: Record<string, number>;
}
let server: Server;

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  if (url.endsWith("/edit/kinds")) return json({ kinds, models: [bookcase, nook], person: "sam" });
  if (url.endsWith("/builtin:places/edit")) {
    const body = JSON.parse(String(init?.body));
    server.edits.push(body);
    return (server.hold ?? Promise.resolve()).then(() => json(server.answer(body.edit, body.place)));
  }
  if (url.startsWith("/api/state/place/")) {
    const method = init?.method ?? "GET";
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body));
      server.writes.push({ url, ...body });
      const other = server.others?.[url];
      if (other !== undefined) {
        if (body.expectedVersion !== other) return json({ error: "changed" }, 409);
        (server.others as Record<string, number>)[url] = other + 1;
        return json({ version: other + 1 });
      }
      if (body.expectedVersion !== server.version) return json({ error: "changed" }, 409);
      server.version += 1;
      server.by = { kind: "user", name: "owner" };
      return json({ version: server.version });
    }
    if (method === "DELETE") {
      server.deletes.push(url);
      const expected = new URL(url, "http://t").searchParams.get("expectedVersion");
      if (expected !== null && Number(expected) !== server.version) return json({ error: "changed" }, 409);
      server.version = 0;
      return json({});
    }
    return server.version
      ? json({ version: server.version, updatedBy: server.by, data: server.data })
      : json({ error: "none" }, 404);
  }
  return json({}, 404);
}

/** The couch moved to `at`: what the server makes of a move there. */
const movedTo = (place: Room, item: string, at: [number, number], facing?: number): Room => ({
  ...place,
  props: place.props.map((p) => (p.id === item ? { ...p, at, ...(facing !== undefined ? { facing } : {}) } : p)),
});

let root: Root;
let editor: RoomEditor;
/** Every place there is, as the map has them, for where a door can lead. */
let mapPlaces: MapPlace[] = [];
function Harness({ place }: { place: EditablePlace }) {
  editor = useRoomEditor(place, undefined, mapPlaces);
  return (
    <div>
      {editor.tools}
      {editor.bar}
      {editor.shelf}
    </div>
  );
}

const home = (version = 3, room: Room = DEFAULT_ROOM): EditablePlace => ({
  id: "home:assistant",
  room,
  version,
  scope: "agent:assistant",
});

async function render(place: EditablePlace) {
  await act(async () => root.render(<Harness place={place} />));
  await act(async () => editor.start());
}
/** The page hearing of a newer version of the place, as the live stream tells it. */
const hear = (place: EditablePlace) => act(async () => root.render(<Harness place={place} />));
/** An agent's change, on the server: the plant taken away. */
function agentTakesThePlant(): Room {
  server.version += 1;
  server.by = { kind: "agent", name: "planner" };
  server.data = { ...recordOf(DEFAULT_ROOM), props: DEFAULT_ROOM.props.filter((p) => p.id !== "plant") };
  return server.data;
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const move = (at: [number, number], facing = 0): Move => ({ item: "couch", at, facing });

beforeEach(() => {
  mapPlaces = [];
  server = {
    edits: [],
    writes: [],
    deletes: [],
    version: 3,
    by: { kind: "plugin", name: "places" },
    answer: (edit, place) => ({ place: movedTo(place, String(edit.item), edit.at as [number, number]) }),
  };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("rearranging a room", () => {
  it("saves a thing let go where it fits, with the version it was made to, as yours", async () => {
    await render(home());
    expect(editor.editing).toBe(true);
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    // Asked of the server about the record (no doors), then written to it.
    expect(server.edits[0].edit).toEqual({ op: "move", item: "couch", at: [0.3, 0.6], facing: 0 });
    expect(server.edits[0].place.doors).toBeUndefined();
    const [w] = server.writes;
    expect(w).toMatchObject({ url: "/api/state/place/home%3Aassistant", expectedVersion: 3, scope: "agent:assistant" });
    expect(w.data.changes?.[0]).toMatchObject({ who: "sam", what: "moved the couch", person: true });
    expect(w.data.props.find((p) => p.id === "couch")?.at).toEqual([0.3, 0.6]);
    // Shown as saved, ahead of the page hearing of it.
    expect(editor.room?.props.find((p) => p.id === "couch")?.at).toEqual([0.3, 0.6]);
    expect(button("Undo").disabled).toBe(false);
  });

  it("keeps the models a room is drawn with out of its record, and still draws them once saved", async () => {
    const models = { "planner:bookcase": bookcaseDef } as unknown as Room["models"];
    await render(home(3, { ...DEFAULT_ROOM, models }));
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    expect(server.edits[0].place).not.toHaveProperty("models");
    expect(server.writes[0].data).not.toHaveProperty("models");
    expect(editor.room?.models).toEqual(models);
  });

  it("puts a thing back where it was and says why, when the server says it doesn't fit", async () => {
    server.answer = () => ({ why: "It would bump into the floor lamp." });
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.25, -1.45])));
    await settle();
    expect(server.writes).toEqual([]);
    expect(editor.stage?.pending).toBeUndefined();
    expect(text()).toMatch(/It would bump into the floor lamp\./);
  });

  it("shows where a dragged thing would go, and whether it fits there, as the server says", async () => {
    server.answer = (edit, place) =>
      (edit.at as number[])[0] > 1
        ? { why: "It would stick out of the room." }
        : { place: movedTo(place, "couch", [0, 0]) };
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrag(move([0.5, 0.5])));
    await settle();
    expect(editor.stage?.pending).toMatchObject({ at: [0.5, 0.5], fits: true });
    await act(async () => editor.stage?.onDrag(move([1.5, 0.5])));
    await settle();
    expect(editor.stage?.pending).toMatchObject({ at: [1.5, 0.5], fits: false });
    expect(text()).toMatch(/stick out of the room/);
    // Over nothing it could stand on, a small thing says so without asking.
    const asked = server.edits.length;
    await act(async () => editor.stage?.onDrag({ ...move([0, 0]), loose: true }));
    expect(server.edits.length).toBe(asked);
    expect(text()).toMatch(/needs something with a top/);
  });

  it("writes nothing over an agent's change made meanwhile: says who, and shows the room as it is now", async () => {
    // The agent took the plant away, and the page hasn't heard yet.
    server.version = 4;
    server.by = { kind: "agent", name: "planner" };
    server.data = { ...recordOf(DEFAULT_ROOM), props: DEFAULT_ROOM.props.filter((p) => p.id !== "plant") };
    await render(home(3));
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    expect(server.writes).toHaveLength(1);
    expect(server.version).toBe(4);
    expect(text()).toMatch(/planner changed this room while you were rearranging it, so your last change wasn't saved/);
    expect(editor.room?.props.some((p) => p.id === "plant")).toBe(false);
    expect(button("Undo").disabled).toBe(true);
    // The next change is made to the room as it is now, and saves.
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    expect(server.writes[1]).toMatchObject({ expectedVersion: 4 });
    expect(server.edits.at(-1)?.place.props.some((p) => p.id === "plant")).toBe(false);
    expect(server.version).toBe(5);
  });

  it("takes your change back with undo, and makes it again with redo", async () => {
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    await act(async () => button("Undo").click());
    await settle();
    const undo = server.writes[1];
    expect(undo.expectedVersion).toBe(4);
    expect(undo.data).toEqual(recordOf(DEFAULT_ROOM));
    await act(async () => button("Redo").click());
    await settle();
    expect(server.writes[2].expectedVersion).toBe(5);
    expect(server.writes[2].data.changes?.[0].what).toBe("moved the couch");
  });

  it("makes a meeting room's record with its first change, without what it only borrows, and undoes it by letting it go", async () => {
    server.version = 0;
    const meeting: EditablePlace = {
      id: "room:local:trip",
      room: { ...DEFAULT_ROOM, purpose: "Plan the trip" },
      version: 0,
      scope: "global",
      lent: ["purpose"],
    };
    await render(meeting);
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    const [w] = server.writes;
    expect(w).toMatchObject({ expectedVersion: 0, scope: "global" });
    expect(w.data.purpose).toBeUndefined();
    // Still shown with its room's purpose.
    expect(editor.room?.purpose).toBe("Plan the trip");
    await act(async () => button("Undo").click());
    await settle();
    // Only if nobody has changed it since your change made it.
    expect(server.deletes).toEqual(["/api/state/place/room%3Alocal%3Atrip?expectedVersion=1"]);
  });

  it("won't undo or redo over an agent's change the page has already heard of", async () => {
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    // The agent takes the plant away, and the page hears of it before you press Undo.
    await hear(home(5, agentTakesThePlant()));
    await act(async () => button("Undo").click());
    await settle();
    // Written over your version, not the agent's, so refused: the plant stays gone, and you're told.
    expect(server.writes[1]).toMatchObject({ expectedVersion: 4 });
    expect(server.version).toBe(5);
    expect(text()).toMatch(/planner changed this room while you were rearranging it, so nothing was taken back/);
    expect(button("Undo").disabled).toBe(true);

    // The same for a redo.
    await act(async () => editor.stage?.onDrop(move([0.4, 0.6])));
    await settle();
    await act(async () => button("Undo").click());
    await settle();
    expect(server.version).toBe(7);
    await hear(home(8, agentTakesThePlant()));
    await act(async () => button("Redo").click());
    await settle();
    expect(server.writes.at(-1)).toMatchObject({ expectedVersion: 7 });
    expect(server.version).toBe(8);
    expect(text()).toMatch(/so nothing was made again/);
  });

  it("lets go of your earlier changes once an agent's comes between, so undo never reaches past it", async () => {
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    const theirs = agentTakesThePlant();
    await hear(home(5, theirs));
    // Your next change is made to the room as the agent left it, and saves.
    await act(async () => editor.stage?.onDrop(move([0.4, 0.6])));
    await settle();
    expect(server.writes[1]).toMatchObject({ expectedVersion: 5 });
    await act(async () => button("Undo").click());
    await settle();
    // Back to the room as the agent left it, and no further.
    expect(server.writes[2]).toMatchObject({ expectedVersion: 6, data: theirs });
    expect(button("Undo").disabled).toBe(true);
  });

  it("writes a change with the version the server was asked about, not one the page heard of meanwhile", async () => {
    let answer = () => {};
    server.hold = new Promise((r) => {
      answer = r;
    });
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    // While the server thinks, the agent takes the plant away and the page hears of it.
    await hear(home(4, agentTakesThePlant()));
    await act(async () => answer());
    await settle();
    // Your move was made to the room with the plant: written with that room's version, so refused.
    expect(server.writes[0]).toMatchObject({ expectedVersion: 3 });
    expect(server.version).toBe(4);
    expect(text()).toMatch(/so your last change wasn't saved/);
  });

  it("won't let a meeting room go back to being drawn over an agent's change since your first", async () => {
    server.version = 0;
    const meeting = (version: number): EditablePlace => ({
      id: "room:local:trip",
      room: DEFAULT_ROOM,
      version,
      scope: "global",
    });
    await render(meeting(0));
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    await hear(meeting(2));
    agentTakesThePlant();
    await act(async () => button("Undo").click());
    await settle();
    expect(server.deletes).toEqual(["/api/state/place/room%3Alocal%3Atrip?expectedVersion=1"]);
    expect(server.version).toBe(2);
    expect(text()).toMatch(/planner changed this room/);
  });

  it("hands the room back to the page once it hears of your change, with its doors asked for again", async () => {
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => editor.stage?.onDrop(move([0.3, 0.6])));
    await settle();
    expect(editor.room).toBeDefined();
    await hear(
      home(4, {
        ...server.writes[0].data,
        doors: [{ wall: "left", along: 0, to: "town", label: "Maple Lane", kind: "town" }],
      }),
    );
    // The page's own room, the same record with its fresh doors, is the one shown now.
    expect(editor.room).toBeUndefined();
  });

  it("turns with R, removes with Delete, and stops with Escape", async () => {
    server.answer = (edit, place) =>
      edit.op === "remove"
        ? { place: { ...place, props: place.props.filter((p) => p.id !== edit.item) } }
        : { place: movedTo(place, String(edit.item), edit.at as [number, number], edit.facing as number) };
    await render(home());
    await act(async () => editor.stage?.onSelect("couch"));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", key: "r" })));
    await settle();
    expect(server.edits[0].edit).toMatchObject({ op: "move", item: "couch", facing: -90 });
    expect(server.writes[0].data.changes?.[0].what).toBe("turned the couch");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));
    await settle();
    expect(server.edits[1].edit).toEqual({ op: "remove", item: "couch" });
    expect(server.writes[1].data.changes?.[0].what).toBe("removed the couch");
    expect(editor.stage?.selected).toBeUndefined();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(editor.editing).toBe(false);
  });

  it("adds from the catalogue, and picks what it added", async () => {
    server.answer = (_edit, place) => ({
      place: {
        ...place,
        props: [...place.props, { id: "plant-2", name: "the plant 2", kind: "plant", at: [0, 0], facing: 0 }],
      },
      item: "plant-2",
    });
    await render(home());
    await act(async () => button("Add things").click());
    expect(text()).toMatch(/Seating/);
    await act(async () => button("Plant").click());
    await settle();
    expect(server.edits[0].edit).toEqual({ op: "add", kind: "plant" });
    expect(server.writes[0].data.changes?.[0].what).toBe("added the plant 2");
    expect(editor.stage?.selected).toBe("plant-2");
  });

  it("offers what agents made first, adds one by its record, and draws it at once without writing its parts", async () => {
    server.answer = (_edit, place) => ({
      place: {
        ...place,
        props: [
          ...place.props,
          {
            id: "model",
            name: "the bookcase",
            kind: "model",
            model: "planner:bookcase",
            size: [0.9, 1.8, 0.34],
            at: [0, 0],
            facing: 0,
          },
        ],
      },
      item: "model",
      models: { "planner:bookcase": bookcaseDef },
    });
    await render(home());
    await act(async () => button("Add things").click());
    const groups = [...document.querySelectorAll(".room-edit-group")].map((g) => g.getAttribute("aria-label"));
    expect(groups[0]).toBe("Made by agents");
    // The home's own agent's first; everyone else's folded away until asked for.
    expect(text()).toMatch(/Reading nookby assistant/);
    expect(text()).not.toMatch(/Bookcaseby planner/);
    // A model is offered by its own name, never as a blank one among the decor.
    expect(groups).not.toContain("Model");
    await act(async () => button("More by other agents (1)").click());
    expect(text()).toMatch(/Bookcaseby planner/);
    const shelf = [...document.querySelectorAll(".room-edit-group button")].find((b) =>
      b.textContent?.startsWith("Bookcase"),
    ) as HTMLButtonElement;
    await act(async () => shelf.click());
    await settle();
    expect(server.edits[0].edit).toEqual({ op: "add", kind: "model", model: "planner:bookcase" });
    // Its parts are a record of their own: the room's record keeps only where it stands.
    expect(server.writes[0].data).not.toHaveProperty("models");
    expect(server.writes[0].data.props.at(-1)).toMatchObject({ model: "planner:bookcase" });
    expect(editor.room?.models?.["planner:bookcase"]).toEqual(bookcaseDef);
    expect(editor.stage?.selected).toBe("model");
    // Its colours are its parts': nothing to repaint.
    expect((document.querySelector(".room-edit-swatches") as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("puts in a door with its way back saved first, picks it once it is there, and takes it out", async () => {
    mapPlaces = [
      { id: "home:assistant", name: "assistant's room", kind: "home", owner: "assistant", agents: [] },
      { id: "shared:reading-room", name: "the reading room", kind: "shared", agents: [] },
      { id: "town", name: "the town", kind: "town", agents: [] },
    ];
    const far = "/api/state/place/shared%3Areading-room";
    server.others = { [far]: 2 };
    const link = { to: "shared:reading-room", wall: "front", along: 0, by: "sam" };
    server.answer = (edit, place) =>
      edit.op === "door"
        ? {
            place: { ...place, links: [link] } as Room,
            item: "door:shared:reading-room",
            far: {
              id: "shared:reading-room",
              name: "the reading room",
              place: { ...recordOf(DEFAULT_ROOM), links: [{ ...link, to: "home:assistant" }] },
              version: 2,
              scope: "global",
            },
          }
        : { place: { ...place, links: undefined } as Room, item: String(edit.item) };
    await render(home());
    await act(async () => button("Add things").click());
    await act(async () => button("A door to another placeits way back goes in there").click());
    // Only the places this one has no door to: not itself, nor the town.
    const offered = [...document.querySelectorAll(".room-edit-doors li button")].map((b) => b.textContent);
    expect(offered).toEqual(["the reading roomShared place"]);
    await act(async () => (document.querySelector(".room-edit-doors li button") as HTMLButtonElement).click());
    await settle();
    expect(server.edits.at(-1)?.edit).toEqual({ op: "door", to: "shared:reading-room" });
    // The way back first, with its own version and scope; then the door here, each saying what you did.
    expect(server.writes.map((w) => [w.url, w.expectedVersion, w.scope])).toEqual([
      [far, 2, "global"],
      ["/api/state/place/home%3Aassistant", 3, "agent:assistant"],
    ]);
    expect(server.writes[0].data.changes?.[0]).toMatchObject({ who: "sam", what: "put in a door to assistant's home" });
    expect(server.writes[1].data.changes?.[0]).toMatchObject({ what: "put in a door to the reading room" });
    expect(editor.stage?.selected).toBe("door:shared:reading-room");
    // The page hears of the door, with its plate: picked, it can be taken out, and nothing else.
    const door = {
      wall: "front" as const,
      along: 0,
      to: "shared:reading-room",
      label: "Reading room",
      kind: "shared" as const,
      by: "sam",
    };
    await hear({ ...home(4, { ...DEFAULT_ROOM, doors: [door] }) });
    expect(text()).toMatch(/the door to the reading room/);
    expect(text()).toMatch(/Put in by you/);
    expect(button("Copy")).toBeUndefined();
    await act(async () => button("Take out").click());
    await settle();
    expect(server.edits.at(-1)?.edit).toEqual({ op: "remove", item: "door:shared:reading-room" });
    expect(server.writes.at(-1)?.data.changes?.[0]).toMatchObject({ what: "took out the door to the reading room" });
  });

  it("says why when there is no room for a door, and writes nothing", async () => {
    mapPlaces = [{ id: "shared:lounge", name: "the lounge", kind: "shared", agents: [] }];
    server.answer = () => ({ why: "There's no room in the lounge for the way back." });
    await render(home());
    await act(async () => button("Add things").click());
    await act(async () => button("A door to another placeits way back goes in there").click());
    await act(async () => (document.querySelector(".room-edit-doors li button") as HTMLButtonElement).click());
    await settle();
    expect(server.writes).toEqual([]);
    expect(text()).toMatch(/no room in the lounge for the way back/);
  });
});
