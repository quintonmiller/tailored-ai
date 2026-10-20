/**
 * Widgets in places: kinds of thing the page draws live pages of what the
 * server keeps on (a status board, a feed, a chart, a ticker…), which agents
 * add with the `place` tool and people from the catalogue, `shows` choosing
 * what some of them show, the photos every place keeps gathered for a photo
 * wall, and where the building hangs them: the lobby, over a meeting room's
 * task board, by a new home's desk.
 */
import { describe, expect, it } from "vitest";
import { applyAction, WALL_PHOTOS, wallPhotos } from "../plugins/places.js";
import { applyEdit, editFrom } from "../plugins/places-edit.js";
import {
  describe as describeRoom,
  firstHome,
  heightOf,
  KINDS,
  PLACE_SCHEMA,
  type Place,
  type PlaceItem,
  placeProblems,
  SHOWS_KINDS,
  SHOWS_LENGTH,
} from "../plugins/places-layout.js";
import { homePlace, LOBBY, lobby, meetingRoom, officeFloor } from "../plugins/places-rooms.js";
import { layTown, townPlace } from "../plugins/places-town.js";

const WIDGETS = [
  "status_board",
  "feed",
  "needs_board",
  "todo",
  "photo_wall",
  "ticker",
  "chart",
  "agenda",
  "display",
  "monitor",
];

/** Apply a tool call that must succeed, returning the room after it and what it said. */
function must(place: Place, args: Record<string, unknown>): { place: Place; text: string } {
  const out = applyAction(place, args);
  expect(out.ok, out.text).toBe(true);
  return { place: out.place as Place, text: out.text };
}

const kind = (place: Place, k: string) => place.props.find((p) => p.kind === k) as PlaceItem;

describe("widget kinds", () => {
  it("are kinds like any other, on the walls but a stand for the floor and a monitor for a desk", () => {
    for (const k of WIDGETS) expect(KINDS[k], k).toBeDefined();
    expect(KINDS.display?.mount).toBe("floor");
    expect(KINDS.monitor?.mount).toBe("on");
    for (const k of WIDGETS.filter((w) => w !== "display" && w !== "monitor")) expect(KINDS[k]?.mount, k).toBe("wall");
    // A ticker fits between the floor and the lowest ceiling a room can have.
    expect((KINDS.ticker?.elevation ?? 0) + (KINDS.ticker?.height ?? 0)).toBeLessThan(2.2);
  });

  it("are added by an agent as any other thing is, and listed with what it can add", () => {
    const { place, text } = must(firstHome(), { action: "add", kind: "status board" });
    expect(text).toMatch(/Added the status board/);
    const words = describeRoom(place);
    expect(words).toContain("status_board");
    expect(words).toContain("Some show what you choose with `shows`: screen, chart, ticker, display, monitor.");
  });
});

describe("what a widget shows", () => {
  it("is chosen when it is added, and said when the room is looked at", () => {
    const { place } = must(firstHome(), { action: "add", kind: "chart", shows: "tokens" });
    expect(kind(place, "chart").shows).toBe("tokens");
    expect(describeRoom(place)).toMatch(/the chart \(chart, showing tokens\)/);
    const stand = must(firstHome(), { action: "add", kind: "display", shows: "chart: tasks" }).place;
    expect(kind(stand, "display").shows).toBe("chart: tasks");
  });

  it("is changed later, and cleared back to the kind's own", () => {
    let { place } = must(firstHome(), { action: "add", kind: "ticker" });
    expect(kind(place, "ticker").shows).toBeUndefined();
    ({ place } = must(place, { action: "change", item: "the room ticker", shows: "lisbon-trip" }));
    expect(kind(place, "ticker").shows).toBe("lisbon-trip");
    const cleared = must(place, { action: "change", item: "the room ticker", shows: "default" });
    expect(kind(cleared.place, "ticker").shows).toBeUndefined();
    expect(cleared.text).toMatch(/shows what it shows by itself/);
  });

  it("is refused for a kind that shows what it is, and when it runs long", () => {
    const board = applyAction(firstHome(), { action: "add", kind: "status_board", shows: "feed" });
    expect(board.ok).toBe(false);
    expect(board.text).toMatch(/shows what it is/);
    const long = applyAction(firstHome(), { action: "add", kind: "chart", shows: "x".repeat(SHOWS_LENGTH + 1) });
    expect(long.ok).toBe(false);
    expect([...SHOWS_KINDS]).toEqual(["screen", "chart", "ticker", "display", "monitor"]);
  });

  it("is kept by the record's schema", () => {
    const props = PLACE_SCHEMA.properties.props.items.properties as Record<string, unknown>;
    expect(props.shows).toEqual({ type: "string", maxLength: SHOWS_LENGTH });
  });

  it("is set by a person on the page, copied with the thing, and refused for a kind with nothing to choose", () => {
    // A room with wall enough for two.
    const room = meetingRoom("review", 8);
    const added = applyEdit("room:local:review", room, { op: "add", kind: "chart" });
    if (typeof added === "string") throw new Error(added);
    const chart = added.item as string;
    const edit = editFrom({ op: "shows", item: chart, shows: "time" });
    expect(edit).toEqual({ op: "shows", item: chart, shows: "time" });
    const set = applyEdit("room:local:review", added.place, edit as never);
    if (typeof set === "string") throw new Error(set);
    expect(set.place.props.find((p) => p.id === chart)?.shows).toBe("time");
    const copied = applyEdit("room:local:review", set.place, { op: "add", kind: "chart", like: chart });
    if (typeof copied === "string") throw new Error(copied);
    expect(copied.place.props.find((p) => p.id === copied.item)?.shows).toBe("time");
    const back = applyEdit("room:local:review", set.place, { op: "shows", item: chart, shows: null });
    if (typeof back === "string") throw new Error(back);
    expect(back.place.props.find((p) => p.id === chart)).not.toHaveProperty("shows");
    expect(applyEdit("home:assistant", firstHome(), { op: "shows", item: "couch", shows: "x" })).toMatch(
      /shows what it is/,
    );
    expect(editFrom({ op: "shows", item: chart, shows: null })).toEqual({ op: "shows", item: chart, shows: null });
    expect(editFrom({ op: "shows" })).toMatch(/needs `item`/);
  });
});

describe("the photos for a photo wall", () => {
  const place = (name: string, photos: { media: string; what: string; at: string }[], changes: unknown[] = []) => ({
    name,
    photos,
    changes,
  });

  it("are every place's, newest first, each saying where and who took it", () => {
    const photos = wallPhotos([
      {
        id: "home:planner",
        data: place("planner's home", [{ media: "a", what: "a selfie", at: "2026-10-19T10:00:00Z" }]),
      },
      {
        id: "shared:lounge",
        data: place(
          "the lounge",
          [
            { media: "b", what: "the lounge", at: "2026-10-20T09:00:00Z" },
            { media: "c", what: "the lounge", at: "2026-10-18T09:00:00Z" },
          ],
          [{ who: "writer", what: "took a photo of the room", at: "2026-10-20T09:00:00Z" }],
        ),
      },
      { id: "lobby", data: { name: "the lobby" } },
    ]);
    expect(photos.map((p) => p.media)).toEqual(["b", "a", "c"]);
    expect(photos[0]).toMatchObject({ place: "shared:lounge", placeName: "the lounge", by: "writer" });
    // A home's photos are its owner's when no change says otherwise; anyone else's, nobody's in particular.
    expect(photos[1]?.by).toBe("planner");
    expect(photos[2]).not.toHaveProperty("by");
  });

  it("are the newest so many at most", () => {
    const many = Array.from({ length: WALL_PHOTOS + 5 }, (_, i) => ({
      media: `m${i}`,
      what: "x",
      at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    expect(wallPhotos([{ id: "shared:x", data: place("x", many) }])).toHaveLength(WALL_PHOTOS);
  });
});

describe("where the building hangs widgets", () => {
  it("in the lobby: who is doing what, what waits on you, the photos, the latest talk, and stands for the feed and a chart", () => {
    const place = lobby();
    expect(placeProblems(place)).toEqual([]);
    for (const k of ["status_board", "needs_board", "photo_wall", "ticker"]) expect(kind(place, k), k).toBeDefined();
    const stands = place.props.filter((p) => p.kind === "display").map((p) => p.shows);
    expect(stands.sort()).toEqual(["chart", "feed"]);
    // The ticker hangs over the task board, clear of it.
    const board = kind(place, "board");
    const ticker = kind(place, "ticker");
    expect(Math.abs(ticker.at[0] - board.at[0])).toBeLessThan(0.5);
    expect(ticker.elevation ?? 0).toBeGreaterThan((board.elevation ?? 0) + heightOf(board));
    // The photos took the painting's place over the couch.
    expect(kind(place, "painting")).toBeUndefined();
    expect(LOBBY).toBe("lobby");
  });

  it("on the town square: on the town hall's front either side of the door and over it, and on stands at its top corners", () => {
    const town = layTown(
      { homes: [], street: [], huts: [], office: true, plots: [] },
      { hall: LOBBY, office: "office" },
    );
    const square = townPlace(town);
    const status = kind(square, "status_board");
    const needs = kind(square, "needs_board");
    const ticker = kind(square, "ticker");
    const screen = kind(square, "screen");
    const board = kind(square, "board");
    // On the hall's front, as the screen and the board are.
    for (const w of [status, needs, ticker]) expect(w.at[1]).toBe(screen.at[1]);
    // Clear of the screen and the board along the front: nothing overlaps.
    const span = (p: PlaceItem) => {
      const half = ((KINDS[p.kind]?.footprint[0] ?? 0) * (p.scale ?? 1)) / 2;
      return [p.at[0] - half, p.at[0] + half] as const;
    };
    const low = [status, needs, screen, board].map(span).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < low.length; i++) expect(low[i]?.[0] ?? 0).toBeGreaterThan(low[i - 1]?.[1] ?? 0);
    // The ticker over the door, above everything else on the front.
    expect(ticker.at[0]).toBe(0);
    expect(ticker.elevation ?? 0).toBeGreaterThan((board.elevation ?? 0) + heightOf(board));
    const stands = square.props.filter((p) => p.kind === "display");
    expect(stands.map((p) => p.shows).sort()).toEqual(["chart", "feed"]);
    // Turned toward the middle of the square, from either side.
    expect(stands.map((p) => Math.sign(p.at[0]) * Math.sign(p.facing))).toEqual([-1, -1]);
  });

  it("in the office, by its way in, a stand of every room's latest lines", () => {
    const floor = officeFloor("the ground floor", 12, 12, [{ wall: "back", along: -3 }]);
    expect(placeProblems(floor)).toEqual([]);
    const stand = floor.props.find((p) => p.kind === "display");
    expect(stand?.shows).toBe("ticker");
  });

  it("over a meeting room's task board, a ticker of what was said there", () => {
    for (const [name, seats, purpose] of [
      ["trip", 3, "plan the trip"],
      ["review", 8, ""],
      ["beach-day", 4, "surf and sun"],
    ] as const) {
      const room = meetingRoom(name, seats, purpose);
      expect(placeProblems(room), name).toEqual([]);
      const board = kind(room, "board");
      const ticker = kind(room, "ticker");
      expect(ticker, name).toBeDefined();
      expect(ticker.at).toEqual(board.at);
      expect(ticker.elevation ?? 0).toBeGreaterThan((board.elevation ?? 0) + heightOf(board));
      expect((ticker.elevation ?? 0) + heightOf(ticker)).toBeLessThan(room.height);
    }
  });

  it("by a new home's desk, a to-do list of its owner's tasks, whatever the preset", () => {
    let missing = 0;
    for (let i = 0; i < 24; i++) {
      const home = homePlace(`agent-${i}`, `home ${i}`);
      expect(placeProblems(home)).toEqual([]);
      if (!home.props.some((p) => p.kind === "todo")) missing++;
    }
    // A wall too full for one even at a smaller size can go without, but hardly any home is that full.
    expect(missing).toBeLessThanOrEqual(2);
  });
});
