import { describe, expect, it } from "vitest";
import {
  COLOURS,
  catalogue,
  changeWords,
  doorItem,
  doorItemTo,
  doorPatch,
  doorPoint,
  doorSlotAt,
  doorsAsSaved,
  footprint,
  GROUPS,
  type Kinds,
  linkable,
  madeByAgents,
  madeDoors,
  madeHere,
  noSteps,
  onFloor,
  onTop,
  onWall,
  palette,
  redoing,
  ridersOf,
  SAME_CHANGE_MS,
  STEPS_KEPT,
  showsChoices,
  snap,
  stepped,
  turned,
  undoing,
  withYourChange,
} from "./editing";
import { DEFAULT_ROOM, type Prop, type Room } from "./scene";

/** The kinds the stand-in room uses, as the server sends them. */
const kinds: Kinds = {
  rug: { noun: "rug", mount: "floor", footprint: [2, 1.4], height: 0.03 },
  couch: { noun: "couch", mount: "floor", footprint: [1.6, 0.8], height: 0.8 },
  desk: { noun: "desk", mount: "floor", footprint: [1.2, 0.6], height: 0.76, surface: 0.76 },
  laptop: { noun: "laptop", mount: "on", footprint: [0.34, 0.24], height: 0.25 },
  lamp: { noun: "lamp", mount: "floor", footprint: [0.36, 0.36], height: 1.67, round: true },
  picture: { noun: "picture", mount: "wall", footprint: [0.9, 0.04], height: 0.6, elevation: 1.55 },
  window: { noun: "window", mount: "wall", footprint: [1.2, 0.08], height: 1, elevation: 1 },
  bookshelf: { noun: "bookshelf", mount: "floor", footprint: [0.9, 0.32], height: 1.8 },
  chair: { noun: "chair", mount: "floor", footprint: [0.5, 0.5], height: 1.05 },
  plant: { noun: "plant", mount: "floor", footprint: [0.34, 0.34], height: 1, round: true },
  block: { noun: "block", mount: "floor", footprint: [0.5, 0.5], height: 0.5, shaped: true, surface: 0.5 },
  side_table: { noun: "side table", mount: "floor", footprint: [0.45, 0.45], height: 0.55, surface: 0.55 },
};
const room: Room = DEFAULT_ROOM;
const prop = (id: string) => room.props.find((p) => p.id === id) as Prop;

describe("where a dragged thing lands", () => {
  it("snaps to a 10 cm grid, or to the centimetre with Shift held", () => {
    expect(snap(0.94)).toBe(0.9);
    expect(snap(0.96)).toBe(1);
    expect(snap(-1.249)).toBe(-1.2);
    expect(snap(0.943, true)).toBe(0.94);
    expect(onFloor(room, [0.37, -1.12])).toEqual([0.4, -1.1]);
  });

  it("keeps a thing wholly in the room, turned as it is, so it goes right up to a wall but never through it", () => {
    expect(onFloor(room, [9, -9])).toEqual([2.08, -1.78]);
    // A couch 1.6 by 0.8, square on and then turned a quarter: its long side across, then from back to front.
    expect(onFloor(room, [9, -9], false, [1.6, 0.8], 0)).toEqual([1.28, -1.38]);
    expect(onFloor(room, [9, -9], false, [1.6, 0.8], 90)).toEqual([1.68, -0.98]);
    // Inside, it is only snapped.
    expect(onFloor(room, [0.33, 0.47], false, [1.6, 0.8], 0)).toEqual([0.3, 0.5]);
  });

  it("turns by steps either way, coming round past a half turn", () => {
    expect(turned(0, 90)).toBe(90);
    expect(turned(170, 15)).toBe(-175);
    expect(turned(-90, -90)).toBe(180);
    expect(turned(180, 90)).toBe(-90);
  });

  it("slides what hangs on a wall along the nearer of the back and left walls, facing into the room", () => {
    // Nearer the back wall: along it, and on its line.
    expect(onWall(room, [0.42, -1.5], 0.9)).toEqual({ wall: "back", along: 0.4, at: [0.4, -1.79], facing: 0 });
    // Nearer the left: over onto it.
    expect(onWall(room, [-1.9, 0.33], 0.9)).toEqual({ wall: "left", along: 0.3, at: [-2.09, 0.3], facing: 90 });
    // Never off its end: a 0.9 m picture on a 4.2 m wall stops 0.05 short of the corner.
    expect(onWall(room, [3, -1.7], 0.9).along).toBe(1.6);
  });

  it("puts a small thing on the highest top under the pointer, wholly on it", () => {
    const laptop = prop("laptop");
    // Straight down: wherever the line of sight crosses a height, it is over this point.
    const over = (x: number, z: number) => () => [x, z] as [number, number];
    // Over the desk, by its far edge: kept on, a laptop's half depth in from it.
    expect(onTop(room, kinds, laptop, over(1.4, -1.76))).toEqual({ on: "desk", at: [1.4, -1.6], elevation: 0.76 });
    // Over the floor, nothing to land on.
    expect(onTop(room, kinds, laptop, over(0, 0.5))).toBeUndefined();
  });

  it("never lands a thing on itself, or on what stands on it", () => {
    const withBlock: Room = {
      ...room,
      props: [
        ...room.props,
        { id: "block", name: "the block", kind: "block", at: [0, 0], facing: 0, size: [0.6, 0.4, 0.6] },
        {
          id: "box",
          name: "the box",
          kind: "block",
          at: [0, 0],
          facing: 0,
          size: [0.3, 0.3, 0.3],
          on: "block",
          elevation: 0.4,
        },
      ],
    };
    const block = withBlock.props.find((p) => p.id === "block") as Prop;
    expect(ridersOf(withBlock, "block")).toEqual(["box"]);
    expect(ridersOf(withBlock, "box")).toEqual([]);
    expect(onTop(withBlock, kinds, block, () => [0, 0])).toBeUndefined();
  });

  it("measures a shape by its size, and anything else by its kind, scaled", () => {
    expect(footprint({ kind: "couch", scale: 1.5 }, kinds)).toEqual([2.4000000000000004, 1.2000000000000002]);
    expect(footprint({ kind: "block", size: [0.3, 1, 0.7] }, kinds)).toEqual([0.3, 0.7]);
    expect(footprint({ kind: "spaceship" } as never, kinds)).toEqual([0.5, 0.5]);
  });
});

describe("the catalogue", () => {
  it("groups the kinds the server has, in order, saying which go on a wall or on something", () => {
    const groups = catalogue(kinds);
    expect(groups.map((g) => g.id)).toEqual([
      "seating",
      "tables",
      "storage",
      "lights",
      "plants",
      "decor",
      "wall",
      "screens",
    ]);
    expect(groups.find((g) => g.id === "seating")?.kinds.map((k) => k.kind)).toEqual(["couch", "chair"]);
    expect(groups.find((g) => g.id === "wall")?.kinds).toEqual([
      { kind: "window", noun: "window", goes: "on a wall" },
      { kind: "picture", noun: "picture", goes: "on a wall" },
    ]);
    expect(groups.find((g) => g.id === "screens")?.kinds).toEqual([
      { kind: "laptop", noun: "laptop", goes: "on something" },
    ]);
  });

  it("puts a kind it has no group for under the walls or decor, so a new kind is never missing", () => {
    const more: Kinds = {
      ...kinds,
      hammock: { noun: "hammock", mount: "floor", footprint: [2, 1], height: 1 },
      mirror: { noun: "mirror", mount: "wall", footprint: [0.6, 0.03], height: 1 },
      kiosk: { noun: "kiosk", mount: "floor", footprint: [0.6, 0.5], height: 1.25 },
    };
    const groups = catalogue(more);
    expect(groups.find((g) => g.id === "decor")?.kinds.map((k) => k.kind)).toContain("hammock");
    expect(groups.find((g) => g.id === "wall")?.kinds.map((k) => k.kind)).toContain("mirror");
    // Every kind there is, once, but a kiosk: one is only any use as the lobby's.
    expect(groups.flatMap((g) => g.kinds.map((k) => k.kind)).sort()).toEqual(
      Object.keys(more)
        .filter((k) => k !== "kiosk")
        .sort(),
    );
    expect(new Set(GROUPS.flatMap((g) => g.kinds)).size).toBe(GROUPS.flatMap((g) => g.kinds).length);
  });

  it("offers agents' models by their own names and whose they are, never a blank model among the decor", () => {
    const withModels: Kinds = {
      ...kinds,
      model: { noun: "model", mount: "floor", footprint: [0.5, 0.5], height: 0.5, shaped: true },
      wall_model: { noun: "model", mount: "wall", footprint: [0.5, 0.05], height: 0.5, shaped: true },
    };
    expect(catalogue(withModels).flatMap((g) => g.kinds.map((k) => k.kind))).not.toContain("model");
    expect(catalogue(withModels).flatMap((g) => g.kinds.map((k) => k.kind))).not.toContain("wall_model");
    expect(
      madeByAgents(
        [
          { id: "planner:reading_nook", name: "reading_nook", owner: "planner", kind: "model", size: [1, 1, 1] },
          {
            id: "planner:todo_board",
            name: "todo_board",
            owner: "planner",
            kind: "wall_model",
            size: [1.1, 0.8, 0.1],
            faces: 1,
            about: "A to-do list",
          },
        ],
        withModels,
        ["planner"],
      ),
    ).toEqual({
      here: [
        { id: "planner:reading_nook", label: "reading nook", by: "planner" },
        { id: "planner:todo_board", label: "todo board", by: "planner", goes: "on a wall", about: "A to-do list" },
      ],
      others: [],
    });
  });

  it("offers the models of whoever a place is for first, and everyone else's apart", () => {
    const made = (owner: string) => ({
      id: `${owner}:todo_board`,
      name: "todo_board",
      owner,
      kind: "model",
      size: [1, 1, 1] as [number, number, number],
    });
    const offered = madeByAgents([made("writer"), made("planner"), made("reviewer")], kinds, ["planner"]);
    expect(offered.here.map((m) => m.by)).toEqual(["planner"]);
    expect(offered.others.map((m) => m.by)).toEqual(["writer", "reviewer"]);
    // A home is its agent's; any place is for the agents whose models are in it already.
    const def = {
      name: "lamp",
      owner: "writer",
      mount: "floor" as const,
      parts: [],
      size: [1, 1, 1] as [number, number, number],
    };
    expect(madeHere("home:planner", { models: { "writer:lamp": def } }).sort()).toEqual(["planner", "writer"]);
    expect(madeHere("room:discord:123", {})).toEqual([]);
  });
});

describe("colours to repaint with", () => {
  it("offers the room's own colours first, each saying where it is from, then a few that go with most", () => {
    const painted: Room = {
      ...room,
      walls: "#e9dfd0",
      props: room.props.map((p) => (p.id === "rug" ? { ...p, color: "#2A8A8A" } : p)),
    };
    const swatches = palette(painted);
    expect(swatches[0]).toEqual({ color: "#e9dfd0", from: "the walls" });
    // The rug's colour is teal: named, and from the rug.
    expect(swatches[1]).toEqual({ color: "#2a8a8a", word: "teal", from: "the rug" });
    // No repeats, and the rest are the ones that go with most.
    expect(swatches.filter((s) => s.color === "#2a8a8a")).toHaveLength(1);
    expect(swatches.slice(2).map((s) => s.word)).toEqual(COLOURS.filter((c) => c.word !== "teal").map((c) => c.word));
  });
});

describe("what a change says", () => {
  const moved = (id: string, at: [number, number], facing: number, on?: string): Room => ({
    ...room,
    props: room.props.map((p) => (p.id === id ? { ...p, at, facing, ...(on ? { on } : {}) } : p)),
  });

  it("says moved, turned or moved onto, by what changed", () => {
    expect(changeWords({ op: "move", item: "couch", at: [0, 0.5], facing: 0 }, room, moved("couch", [0, 0.5], 0))).toBe(
      "moved the couch",
    );
    expect(changeWords({ op: "move", item: "couch", at: prop("couch").at, facing: 90 }, room, room)).toBe(
      "turned the couch",
    );
    const onTable: Room = {
      ...room,
      props: [
        ...room.props,
        { id: "side", name: "the side table", kind: "side_table" as never, at: [0, 0], facing: 0 },
      ],
    };
    expect(changeWords({ op: "move", item: "laptop", at: [0, 0], facing: 0, on: "side" }, onTable, onTable)).toBe(
      "moved the laptop onto the side table",
    );
  });

  it("names what was added, copied or taken away, and what went with it", () => {
    const added: Room = { ...room, props: [...room.props, { ...prop("lamp"), id: "lamp-2", name: "the lamp 2" }] };
    expect(changeWords({ op: "add", kind: "lamp" }, room, added)).toBe("added the lamp 2");
    expect(changeWords({ op: "add", kind: "lamp", like: "lamp" }, room, added)).toBe("copied the floor lamp");
    const gone: Room = { ...room, props: room.props.filter((p) => p.id !== "desk" && p.id !== "laptop") };
    expect(changeWords({ op: "remove", item: "desk" }, room, gone)).toBe("removed the desk, and the laptop on it");
  });

  it("names a colour by its name, or by what in the room has it", () => {
    const rugged: Room = { ...room, props: room.props.map((p) => (p.id === "rug" ? { ...p, color: "#123456" } : p)) };
    expect(changeWords({ op: "color", item: "couch", color: "#9CAF88" }, rugged, rugged)).toBe("made the couch sage");
    expect(changeWords({ op: "color", item: "couch", color: "#123456" }, rugged, rugged)).toBe(
      "made the couch the colour of the rug",
    );
    expect(changeWords({ op: "color", item: "couch", color: "#010203" }, rugged, rugged)).toBe("repainted the couch");
  });

  it("puts your change at the top of the room's changes, marked as yours", () => {
    const at = "2026-10-19T09:00:00.000Z";
    const was: Pick<Room, "changes"> = {
      changes: [{ who: "planner", what: "added the lamp", at: "2026-10-19T08:00:00.000Z" }],
    };
    const next = withYourChange(was, { who: "sam", what: "moved the couch", at });
    expect(next.changes?.map((c) => `${c.who} ${c.what}${c.person ? " (person)" : ""}`)).toEqual([
      "sam moved the couch (person)",
      "planner added the lamp",
    ]);
  });

  it("counts the same change again a moment later as one, and keeps only the last few", () => {
    const t = Date.parse("2026-10-19T09:00:00.000Z");
    const at = (ms: number) => new Date(t + ms).toISOString();
    let r: { changes?: Room["changes"] } = {};
    r = withYourChange(r, { who: "sam", what: "moved the couch", at: at(0) });
    r = withYourChange(r, { who: "sam", what: "moved the couch", at: at(30_000) });
    expect(r.changes).toEqual([{ who: "sam", what: "moved the couch", at: at(30_000), person: true }]);
    // Long after, or something else, is a change of its own.
    r = withYourChange(r, { who: "sam", what: "moved the couch", at: at(30_000 + SAME_CHANGE_MS) });
    r = withYourChange(r, { who: "sam", what: "turned the couch", at: at(SAME_CHANGE_MS * 2) });
    expect(r.changes?.map((c) => c.what)).toEqual(["turned the couch", "moved the couch", "moved the couch"]);
    for (let i = 0; i < 12; i++) r = withYourChange(r, { who: "sam", what: `added the lamp ${i}`, at: at(i) });
    expect(r.changes).toHaveLength(8);
    const none: Pick<Room, "changes"> = {};
    expect(withYourChange(none, { who: "sam", what: "x".repeat(400), at: at(0) }).changes?.[0].what).toHaveLength(160);
  });
});

describe("undo and redo", () => {
  const step = (n: number) => ({ before: `room ${n - 1}`, after: `room ${n}`, from: n - 1, what: `change ${n}` });

  it("takes back your changes newest first, and makes them again in order", () => {
    let steps = stepped(stepped(noSteps<string>(), step(1)), step(2));
    const first = undoing(steps);
    expect(first?.step.what).toBe("change 2");
    steps = first?.steps ?? steps;
    expect(undoing(steps)?.step.what).toBe("change 1");
    const again = redoing(steps);
    expect(again?.step.what).toBe("change 2");
    expect(again?.steps.done.map((s) => s.what)).toEqual(["change 1", "change 2"]);
  });

  it("forgets what could be redone once you make a new change, and has nothing to do when empty", () => {
    const undone = undoing(stepped(stepped(noSteps<string>(), step(1)), step(2)))?.steps;
    expect(redoing(stepped(undone ?? noSteps<string>(), step(3)))).toBeUndefined();
    expect(undoing(noSteps())).toBeUndefined();
    expect(redoing(noSteps())).toBeUndefined();
  });

  it("keeps the last fifty", () => {
    let steps = noSteps<string>();
    for (let i = 1; i <= STEPS_KEPT + 5; i++) steps = stepped(steps, step(i));
    expect(steps.done).toHaveLength(STEPS_KEPT);
    expect(steps.done[0].what).toBe("change 6");
  });
});

describe("what a person can set a widget to show", () => {
  it("offers a chart's four measures, and going through them all first", () => {
    const choices = showsChoices("chart");
    expect(choices?.map((c) => c.value)).toEqual(["", "tokens", "turns", "tasks", "time"]);
  });

  it("offers a ticker the rooms there are, and a screen the Board's widgets", () => {
    expect(showsChoices("ticker", { rooms: ["trip"] })).toEqual([
      { value: "", label: "Its own room, or every room" },
      { value: "trip", label: "#trip" },
    ]);
    expect(
      showsChoices("screen", { widgets: [{ id: "needs", title: "Needs you" }, { id: "plain" }] })?.slice(1),
    ).toEqual([
      { value: "needs", label: "Needs you" },
      { value: "plain", label: "plain" },
    ]);
  });

  it("offers a display stand any widget, its own first", () => {
    const choices = showsChoices("display") ?? [];
    expect(choices[0]).toEqual({ value: "", label: "Who's doing what" });
    expect(choices.map((c) => c.value)).toContain("chart: tokens");
    // A chart that goes through all four, as the stands the building puts up are, can be chosen again.
    expect(choices.find((c) => c.value === "chart")?.label).toBe("Chart: all four, in turn");
    expect(showsChoices("monitor")?.[0]?.label).toBe("The clock and agenda");
  });

  it("offers nothing for a kind that shows what it is", () => {
    expect(showsChoices("status_board")).toBeUndefined();
    expect(showsChoices("couch")).toBeUndefined();
  });

  it("reads in the room's recent changes", () => {
    const room = { props: [{ id: "c", name: "the chart" } as Prop] };
    expect(changeWords({ op: "shows", item: "c", shows: "tokens" }, room, room)).toBe("set the chart to show tokens");
    expect(changeWords({ op: "shows", item: "c", shows: null }, room, room)).toBe("set the chart back to its own");
  });
});

describe("doors put in", () => {
  const places = [
    { id: "town", name: "the town", kind: "town", agents: [] },
    { id: "lobby", name: "the town hall", kind: "lobby", agents: [] },
    { id: "office", name: "the office", kind: "office", agents: [] },
    { id: "home:writer", name: "writer's room", kind: "home", owner: "writer", agents: [] },
    { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", agents: [] },
    { id: "shared:lounge", name: "the lounge", kind: "shared", agents: [] },
    { id: "shared:attic", name: "the attic", kind: "shared", agents: [] },
    { id: "room:local:trip", name: "trip", kind: "room", agents: [] },
  ] as Parameters<typeof linkable>[0];
  const room: Pick<Room, "doors"> = {
    doors: [
      { wall: "back", along: 1, to: "town", label: "Maple Lane", kind: "town" },
      { wall: "right", along: 0, to: "shared:attic", label: "Attic", kind: "shared", by: "planner" },
    ],
  };

  it("offers every home, shared place, meeting room and the town hall a door can lead to, but here and those it has", () => {
    expect(linkable(places, "home:planner", room).map((p) => [p.label, p.kind])).toEqual([
      ["writer's home", "Home"],
      ["the lounge", "Shared place"],
      ["#trip", "Meeting room"],
      ["the town hall", "The town hall"],
    ]);
    expect(linkable(places, "home:planner", room, "#tr").map((p) => p.id)).toEqual(["room:local:trip"]);
  });

  it("knows the doors put in by who put them in, picks one by an id of its own, and says what a change to one did", () => {
    expect(madeDoors(room).map((d) => d.to)).toEqual(["shared:attic"]);
    expect(doorItem("shared:attic")).toBe("door:shared:attic");
    expect(doorItemTo("door:shared:attic")).toBe("shared:attic");
    expect(doorItemTo("couch")).toBeUndefined();
    const named = (to: string) => ({ "shared:attic": "the attic", "shared:lounge": "the lounge" })[to];
    expect(changeWords({ op: "door", to: "shared:lounge" }, DEFAULT_ROOM, DEFAULT_ROOM, named)).toBe(
      "put in a door to the lounge",
    );
    expect(changeWords({ op: "remove", item: "door:shared:attic" }, DEFAULT_ROOM, DEFAULT_ROOM, named)).toBe(
      "took out the door to the attic",
    );
    expect(
      changeWords({ op: "move", item: "door:shared:attic", at: [0, 3], facing: 0 }, DEFAULT_ROOM, DEFAULT_ROOM, named),
    ).toBe("moved the door to the attic");
  });

  it("slides a dragged door to the side nearest the pointer, short of the corners, as the server reads it back", () => {
    const size = { width: 7, depth: 6 };
    expect(doorSlotAt(size, [1.23, 3.4])).toEqual({ wall: "front", along: 1.25 });
    expect(doorSlotAt(size, [-3.2, 0.4])).toEqual({ wall: "left", along: 0.4 });
    expect(doorSlotAt(size, [3.6, -9])).toEqual({ wall: "back", along: 2.4 });
    expect(doorSlotAt(size, [3.4, -2.6])).toEqual({ wall: "right", along: -1.9 });
    // Let go there, it says the point on its side, which is that slot again.
    for (const slot of [
      { wall: "back", along: -1 },
      { wall: "left", along: 1.5 },
      { wall: "front", along: 2 },
      { wall: "right", along: 0 },
    ] as const)
      expect(doorSlotAt(size, doorPoint(size, slot))).toEqual(slot);
    // The floor in front of it, square to its side and a metre in.
    expect(doorPatch(size, { wall: "left", along: 1 })).toEqual({ at: [-3, 1], width: 1.6, depth: 1, facing: 90 });
    expect(doorPatch(size, { wall: "front", along: 2 })).toEqual({ at: [2, 2.5], width: 1.6, depth: 1, facing: 0 });
  });

  it("shows a door put in where its record now has it, and none it took out, leaving the town's alone", () => {
    expect(doorsAsSaved(room.doors, { links: [{ to: "shared:attic", wall: "front", along: 1.5 }] })).toEqual([
      room.doors?.[0],
      { ...room.doors?.[1], wall: "front", along: 1.5 },
    ]);
    expect(doorsAsSaved(room.doors, {})).toEqual([room.doors?.[0]]);
    expect(doorsAsSaved(undefined, {})).toBeUndefined();
  });
});
