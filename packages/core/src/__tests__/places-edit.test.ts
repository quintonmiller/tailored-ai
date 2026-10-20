/**
 * A person rearranging a place on the page: each change is checked the way
 * the `place` tool checks its own, says why when it can't be made, and
 * comes back as the room it makes, for the page to write.
 */
import { describe, expect, it } from "vitest";
import { applyEdit, doorsFor, type Edit, type Edited, editFrom } from "../plugins/places-edit.js";
import {
  DOOR_HOLD,
  doorOf,
  firstHome,
  type Place,
  type PlaceItem,
  placeProblems,
  whyNotOnFloor,
  withDoorsHeld,
} from "../plugins/places-layout.js";
import { LOBBY, LOBBY_DOORS, lobby } from "../plugins/places-rooms.js";

const HOME = "home:assistant";
const item = (place: Place, id: string) => place.props.find((p) => p.id === id) as PlaceItem;

/** A change that must go through, and the room it made. */
function made(edit: Edit, place = firstHome(), id = HOME): Edited {
  const out = applyEdit(id, place, edit);
  if (typeof out === "string") throw new Error(out);
  expect(placeProblems(out.place)).toEqual([]);
  return out;
}

/** Why a change can't be made. */
function refused(edit: Edit, place = firstHome(), id = HOME): string {
  const out = applyEdit(id, place, edit);
  expect(typeof out, JSON.stringify(out)).toBe("string");
  return out as string;
}

describe("moving things", () => {
  it("puts a thing exactly where it was dropped, turned as it was turned", () => {
    const { place } = made({ op: "move", item: "plant", at: [-1.2, 1.4], facing: 30 });
    expect(item(place, "plant")).toMatchObject({ at: [-1.2, 1.4], facing: 30 });
  });

  it("carries what stands on a thing, and its spot, along with it", () => {
    const before = firstHome();
    const { place } = made({ op: "move", item: "desk", at: [1.45, -1.47], facing: 0 }, before);
    const laptop = item(place, "laptop");
    expect(laptop.at[0]).toBeCloseTo(item(before, "laptop").at[0] + 0.1);
    expect(laptop.elevation).toBe(0.76);
    expect(place.spots.find((s) => s.id === "desk")?.at[0]).toBeCloseTo(1.45);
  });

  it("says why a thing can't go where it was dropped", () => {
    expect(refused({ op: "move", item: "plant", at: [2.2, 0], facing: 0 })).toBe("It would stick out of the room.");
    expect(refused({ op: "move", item: "plant", at: [0.25, -1.45], facing: 0 })).toBe(
      "It would bump into the floor lamp.",
    );
    // The small first room's door is a gate at the open front, its way in held clear.
    expect(refused({ op: "move", item: "plant", at: [1.8, 1.4], facing: 0 })).toBe(
      "It would block the way through the door.",
    );
  });

  it("won't put a thing where someone stands to use another", () => {
    // In front of the couch, where whoever sits on it stands first.
    expect(refused({ op: "move", item: "plant", at: [-0.85, -0.75], facing: 0 })).toBe(
      "It would be where someone stands to use the couch.",
    );
  });

  it("slides what hangs on a wall along it, and over to the other wall", () => {
    const along = made({ op: "move", item: "picture", at: [0.9, -1.79], facing: 0 }).place;
    expect(item(along, "picture")).toMatchObject({ at: [0.9, -1.79], facing: 0, elevation: 1.55 });
    // The left wall's bookshelf would hide it there: with that gone, there's room.
    const cleared = made({ op: "remove", item: "bookshelf" }).place;
    const over = made({ op: "move", item: "picture", at: [-2.09, 1.2], facing: 0 }, cleared).place;
    // On the left wall it faces into the room from there.
    expect(item(over, "picture")).toMatchObject({ at: [-2.09, 1.2], facing: 90, elevation: 1.55 });
  });

  it("keeps what hangs on a wall on a wall, clear of what else hangs there", () => {
    expect(refused({ op: "move", item: "picture", at: [0.9, 0], facing: 0 })).toBe(
      "The picture hangs on the back or left wall.",
    );
    expect(refused({ op: "move", item: "picture", at: [-2.09, -0.3], facing: 90 })).toBe(
      "It would overlap the window.",
    );
    expect(refused({ op: "move", item: "picture", at: [2.0, -1.79], facing: 0 })).toBe(
      "It would run off the end of the wall.",
    );
  });

  it("moves a small thing about on top of what it stands on, but not off its edge", () => {
    const { place } = made({ op: "move", item: "laptop", at: [1.6, -1.5], facing: 0 });
    expect(item(place, "laptop")).toMatchObject({ at: [1.6, -1.5], on: "desk", elevation: 0.76 });
    expect(refused({ op: "move", item: "laptop", at: [1.9, -1.5], facing: 0 })).toBe(
      "It would hang off the edge of the desk.",
    );
    expect(refused({ op: "move", item: "laptop", at: [0.25, -1.5], facing: 0, on: "lamp" })).toBe(
      "You can't put things on the floor lamp.",
    );
  });

  it("says so when the thing has gone, as when an agent took it away a moment ago", () => {
    expect(refused({ op: "move", item: "piano", at: [0, 0], facing: 0 })).toMatch(/isn't in the room any more/);
  });
});

describe("adding, copying, recolouring and taking away", () => {
  it("adds a new thing near the middle, with a name and id of its own", () => {
    const place = lobby();
    const { place: next, item: id } = made({ op: "add", kind: "armchair" }, place, LOBBY);
    const added = item(next, id as string);
    expect(added.kind).toBe("armchair");
    expect(Math.hypot(...added.at)).toBeLessThan(1.5);
    expect(place.props.some((p) => p.id === added.id || p.name === added.name)).toBe(false);
    // It brings a spot to sit at, like any armchair.
    expect(next.spots.some((s) => s.item === added.id)).toBe(true);
  });

  it("hangs a new wall thing on a wall and stands a small one on something", () => {
    const wall = made({ op: "add", kind: "clock" });
    const clock = item(wall.place, wall.item as string);
    expect(Math.abs(clock.at[1] + 1.8) < 0.02 || Math.abs(clock.at[0] + 2.1) < 0.02).toBe(true);
    const small = made({ op: "add", kind: "mug" });
    expect(item(small.place, small.item as string).on).toBeDefined();
  });

  it("copies a thing beside it, colour and size and all", () => {
    const place = made({ op: "color", item: "plant", color: "#2a8a8a" }).place;
    const { place: next, item: id } = made({ op: "add", kind: "plant", like: "plant" }, place);
    const copy = item(next, id as string);
    expect(copy).toMatchObject({ kind: "plant", color: "#2a8a8a", name: "the plant 2" });
    expect(Math.hypot(copy.at[0] - item(place, "plant").at[0], copy.at[1] - item(place, "plant").at[1])).toBeLessThan(
      1.2,
    );
  });

  it("refuses a kind there is none of, and a room already full", () => {
    expect(refused({ op: "add", kind: "spaceship" })).toMatch(/no kind of thing/);
    const plant = item(firstHome(), "plant");
    const full = { ...firstHome(), props: Array.from({ length: 100 }, (_, i) => ({ ...plant, id: `plant-${i}` })) };
    expect(refused({ op: "add", kind: "lamp" }, full)).toMatch(/at most 100/);
  });

  it("recolours a thing and takes one away with what stands on it", () => {
    expect(item(made({ op: "color", item: "couch", color: "#2a8a8a" }).place, "couch").color).toBe("#2a8a8a");
    const gone = made({ op: "remove", item: "desk" });
    expect(gone.place.props.some((p) => p.id === "desk" || p.id === "laptop")).toBe(false);
    expect(gone.removed).toEqual(["the laptop"]);
  });
});

describe("doors", () => {
  it("keeps the lobby's way out on to the square clear, at its open front", () => {
    expect(doorsFor(LOBBY, lobby())).toEqual(LOBBY_DOORS);
    // Just inside the way out, in the middle of the front.
    const [out] = LOBBY_DOORS;
    expect(refused({ op: "move", item: "kiosk-task", at: [out.along, 4.2], facing: 0 }, lobby(), LOBBY)).toBe(
      "It would block the way through the door.",
    );
  });

  it("keeps anywhere else's door clear, as the place tool does", () => {
    expect(doorsFor(HOME, firstHome())).toEqual([doorOf(firstHome())]);
  });

  it("holds several doorways at once, each called the door", () => {
    const doors = [...LOBBY_DOORS, { wall: "back" as const, along: 5.7 }, { wall: "left" as const, along: 3.7 }];
    const held = withDoorsHeld(lobby(), doors);
    const holds = held.props.filter((p) => p.id.startsWith(DOOR_HOLD));
    expect(holds.map((h) => h.id)).toEqual([DOOR_HOLD, `${DOOR_HOLD}-2`, `${DOOR_HOLD}-3`]);
    expect(new Set(holds.map((h) => h.name))).toEqual(new Set(["the door"]));
    // Holding them again replaces them rather than adding more.
    expect(withDoorsHeld(held, doors).props.length).toBe(held.props.length);
    expect(whyNotOnFloor(held, { kind: "plant" }, [5.7, -4.5], 0)).toBe("It would block the way through the door.");
  });

  it("keeps the lobby's kiosks and task board, which nothing in the catalogue can stand in for", () => {
    expect(refused({ op: "remove", item: "kiosk-task" }, lobby(), LOBBY)).toBe(
      "The new task kiosk is how you make a task from the lobby, so it stays. Move it instead.",
    );
    expect(refused({ op: "remove", item: "board" }, lobby(), LOBBY)).toBe(
      "The task board is how you see the open tasks from the lobby, so it stays. Move it instead.",
    );
    // They can still be moved; and anything else in the lobby, the big screen too, can go.
    made({ op: "move", item: "kiosk-task", at: [0, -2.5], facing: 180 }, lobby(), LOBBY);
    expect(made({ op: "remove", item: "screen" }, lobby(), LOBBY).place.props.some((p) => p.id === "screen")).toBe(
      false,
    );
    // Somewhere else, a task board is anyone's to take down, as the place tool lets its agents.
    const board = made({ op: "add", kind: "board" });
    made({ op: "remove", item: board.item as string }, board.place);
  });

  it("makes a new task board a working one, showing the tasks and opening them", () => {
    const { place, item: id } = made({ op: "add", kind: "board" });
    expect(item(place, id as string)).toMatchObject({ kind: "board", label: "Tasks", action: "tasks" });
  });

  it("won't change the town or a floor of the office, which are laid out from what there is", () => {
    expect(refused({ op: "add", kind: "plant" }, firstHome(), "town")).toMatch(/The town is laid out/);
    expect(refused({ op: "add", kind: "plant" }, firstHome(), "office:2")).toMatch(/The office is laid out/);
  });
});

describe("what the page sends", () => {
  it("takes each kind of change, and says what's missing from one that isn't", () => {
    expect(editFrom({ op: "move", item: "couch", at: [1, 2], facing: 90, on: " desk " })).toEqual({
      op: "move",
      item: "couch",
      at: [1, 2],
      facing: 90,
      on: "desk",
    });
    expect(editFrom({ op: "add", kind: "lamp", like: "lamp" })).toEqual({ op: "add", kind: "lamp", like: "lamp" });
    expect(editFrom({ op: "remove", item: "lamp" })).toEqual({ op: "remove", item: "lamp" });
    expect(editFrom({ op: "color", item: "lamp", color: "#AABBCC" })).toEqual({
      op: "color",
      item: "lamp",
      color: "#aabbcc",
    });
    expect(editFrom({ op: "move", item: "couch", at: [1, "x"], facing: 0 })).toMatch(/needs/);
    expect(editFrom({ op: "color", item: "lamp", color: "teal" })).toMatch(/#rrggbb/);
    expect(editFrom({ op: "paint" })).toMatch(/one of/);
    expect(editFrom(null)).toMatch(/one of/);
  });
});
