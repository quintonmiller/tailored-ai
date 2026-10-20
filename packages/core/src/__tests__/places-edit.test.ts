/**
 * A person rearranging a place on the page: each change is checked the way
 * the `place` tool checks its own, says why when it can't be made, and
 * comes back as the room it makes, for the page to write.
 */
import { describe, expect, it } from "vitest";
import { applyEdit, doorsFor, type Edit, type Edited, editFrom } from "../plugins/places-edit.js";
import {
  BEHIND,
  DOOR_HOLD,
  doorOf,
  firstHome,
  footprintOf,
  KINDS,
  OPEN_FLOOR,
  type Place,
  type PlaceItem,
  placeProblems,
  VIEW_STRIP,
  whyNotOnFloor,
  withDoorsHeld,
} from "../plugins/places-layout.js";
import { LOBBY, LOBBY_DOORS, lobby, meetingRoom } from "../plugins/places-rooms.js";

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

describe("moving a thing with what goes with it", () => {
  const CHAIRS = ["chair", "chair-2", "chair-3"];

  it("moves a table with its chairs, each keeping its place round it, and what stands on it", () => {
    const before = lobby();
    const { place } = made({ op: "move", item: "round-table", at: [3.4, 1.8], facing: 0, with: CHAIRS }, before, LOBBY);
    expect(item(place, "round-table").at).toEqual([3.4, 1.8]);
    for (const id of CHAIRS) {
      const [x, z] = item(before, id).at;
      expect(item(place, id).at).toEqual([x, Math.round((z - 0.5) * 100) / 100]);
      expect(item(place, id).facing).toBe(item(before, id).facing);
    }
    expect(item(place, "vase").at).toEqual([3.4, 1.8]);
  });

  it("can't move the table alone a short way, into its own chairs", () => {
    expect(refused({ op: "move", item: "round-table", at: [3.4, 2.7], facing: 0 }, lobby(), LOBBY)).toMatch(
      /bump into the dining chair/,
    );
    // With them, the same move goes.
    made({ op: "move", item: "round-table", at: [3.4, 2.7], facing: 0, with: CHAIRS }, lobby(), LOBBY);
  });

  it("turns a table's chairs round it as it turns", () => {
    const { place } = made(
      { op: "move", item: "round-table", at: [3.4, 2.3], facing: 90, with: CHAIRS },
      lobby(),
      LOBBY,
    );
    // The chair in front of it goes round to its right, a quarter turned.
    expect(item(place, "chair")).toMatchObject({ at: [4.18, 2.3], facing: -90 });
  });

  it("says which piece doesn't fit when the group can't go there", () => {
    // Up against the right of the room, the chair on that side would go through the wall.
    expect(refused({ op: "move", item: "round-table", at: [6.2, 2.3], facing: 0, with: CHAIRS }, lobby(), LOBBY)).toBe(
      "The dining chair 2 would stick out of the room.",
    );
  });

  it("moves a rug with the beanbags on it", () => {
    const before = lobby();
    const { place } = made(
      { op: "move", item: "round-rug-2", at: [-2.3, 3.2], facing: 0, with: ["beanbag", "beanbag-2"] },
      before,
      LOBBY,
    );
    expect(item(place, "beanbag").at[1]).toBeCloseTo(item(before, "beanbag").at[1] + 0.5);
    expect(item(place, "beanbag-2").at[1]).toBeCloseTo(item(before, "beanbag-2").at[1] + 0.5);
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

  it("never puts something new down where someone is standing", () => {
    const place = lobby();
    const alone = made({ op: "add", kind: "armchair" }, place, LOBBY);
    const where = item(alone.place, alone.item as string).at;
    // Someone stands just there: the armchair goes somewhere else, clear of them.
    const avoided = made({ op: "add", kind: "armchair", avoid: [where] }, place, LOBBY);
    const at = item(avoided.place, avoided.item as string).at;
    expect(Math.hypot(at[0] - where[0], at[1] - where[1])).toBeGreaterThan(0.6);
    // Nobody standing is kept in the room.
    expect(avoided.place.props.some((p) => p.id.startsWith("someone-standing"))).toBe(false);
  });

  /** How far a point is from the edge of a thing on the floor, in metres: 0 on or inside it. */
  const away = (point: [number, number], thing: PlaceItem) => {
    const [w, d] = footprintOf(thing);
    const f = (thing.facing * Math.PI) / 180;
    const [dx, dz] = [point[0] - thing.at[0], point[1] - thing.at[1]];
    const [lx, lz] = [dx * Math.cos(f) - dz * Math.sin(f), dx * Math.sin(f) + dz * Math.cos(f)];
    return Math.hypot(Math.max(0, Math.abs(lx) - w / 2), Math.max(0, Math.abs(lz) - d / 2));
  };

  it("puts something new down a metre clear of you and of anyone standing near you", () => {
    const place = lobby();
    // You in the middle of the hall, an agent beside you, and one across the room.
    const standing: [number, number][] = [
      [0, 0.5],
      [1.1, 0.4],
      [-3, -2],
    ];
    for (const kind of ["armchair", "tall_plant", "bookshelf"]) {
      const { place: next, item: id } = made({ op: "add", kind, avoid: standing }, place, LOBBY);
      const added = item(next, id as string);
      for (const p of standing) expect(away(p, added), `${kind} from ${p}`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("puts something new on open floor, not in among the furniture in the middle", () => {
    // A meeting room for six: a round table in the middle, with its armchairs round it.
    const place = meetingRoom("general", 6, "Everyday chat for everyone");
    const { place: next, item: id } = made(
      { op: "add", kind: "plant", avoid: [[0, 2.4]] },
      place,
      "room:local:general",
    );
    const added = item(next, id as string);
    const half = Math.max(...footprintOf(added)) / 2;
    const furniture = place.props.filter(
      (p) => !p.on && !["rug", "round_rug"].includes(p.kind) && KINDS[p.kind]?.mount === "floor",
    );
    // A metre of floor clear round it, as near the middle as there is that much.
    for (const p of furniture) expect(away(added.at, p), p.name).toBeGreaterThanOrEqual(OPEN_FLOOR + half - 0.01);
  });

  it("keeps something tall out of the view in: by the back or the left wall, not across the open front", () => {
    // The page looks in across the open front, a little from the right; meeting rooms leave their front strip clear.
    const view = [Math.sin(0.42), Math.cos(0.42)];
    const rooms: [Place, string][] = [
      [meetingRoom("general", 6, "Everyday chat for everyone"), "room:local:general"],
      [meetingRoom("general", 16, "Everyday chat for everyone"), "room:local:general"],
      [lobby(), LOBBY],
      [firstHome(), HOME],
    ];
    for (const [place, room] of rooms) {
      for (const kind of ["tall_plant", "bookshelf", "palm", "lamp"]) {
        const { place: next, item: id } = made({ op: "add", kind, avoid: [[0, 0.5]] }, place, room);
        const [x, z] = item(next, id as string).at;
        expect(z, `${kind} in ${room}`).toBeLessThanOrEqual(place.depth / 2 - VIEW_STRIP);
        // Little of the room behind it, looking in: it is up by the back or the left wall.
        const behind = Math.min((z + place.depth / 2) / view[1], (x + place.width / 2) / view[0]);
        expect(behind, `${kind} in ${room} at ${x}, ${z}`).toBeLessThanOrEqual(BEHIND);
      }
    }
    // With the back and the left wall taken, out on the floor rather than across the open front, though the front
    // has more room round it.
    const blocked: Place = {
      ...firstHome(),
      width: 8,
      depth: 6,
      props: [
        { id: "back", name: "the back", kind: "block", at: [0, -1.25], facing: 0, size: [8, 1, 3.5] },
        { id: "left", name: "the left", kind: "block", at: [-3.25, 1.75], facing: 0, size: [1.5, 1, 2.5] },
      ],
    };
    const out = made({ op: "add", kind: "tall_plant" }, blocked);
    expect(item(out.place, out.item as string).at[1]).toBeLessThanOrEqual(3 - VIEW_STRIP);
    // Something low may go there: it hides nothing.
    const low = made({ op: "add", kind: "armchair" }, meetingRoom("general", 16), "room:local:general");
    expect(item(low.place, low.item as string)).toBeDefined();
  });

  it("doesn't stand something tall between you and the view in", () => {
    // The view in comes from the front, a little to the right. Wherever you stand, nothing tall goes in front of you.
    const view = [Math.sin(0.42), Math.cos(0.42)];
    const rooms: [Place, string][] = [
      [meetingRoom("general", 16, "Everyday chat for everyone"), "room:local:general"],
      [meetingRoom("general", 6, "Everyday chat for everyone"), "room:local:general"],
      [lobby(), LOBBY],
      [firstHome(), HOME],
    ];
    const spots: [number, number][] = [
      [0, 0.5],
      [0, -1],
      [2, -1],
      [-2, -1],
      [1, -2],
      [-1, 0.5],
    ];
    for (const [place, id] of rooms) {
      for (const you of spots) {
        for (const kind of ["tall_plant", "bookshelf"]) {
          const { place: next, item: added } = made({ op: "add", kind, avoid: [you] }, place, id);
          const thing = item(next, added as string);
          const [dx, dz] = [thing.at[0] - you[0], thing.at[1] - you[1]];
          const across = Math.abs(dx * view[1] - dz * view[0]);
          if (dx * view[0] + dz * view[1] <= 0) continue;
          // Nearer the view than you: far enough to one side that your body is still in sight.
          expect(across, `${kind} in ${id} with you at ${you}`).toBeGreaterThanOrEqual(
            Math.max(...footprintOf(thing)) / 2 + 0.25,
          );
        }
      }
    }
  });

  it("keeps a metre clear of you in a little room with no open floor to spare, or as near that as it can", () => {
    // A small furnished room, you standing in the middle of what floor there is.
    const you: [number, number] = [0.1, 0.4];
    const plant = made({ op: "add", kind: "plant", avoid: [you] });
    expect(away(you, item(plant.place, plant.item as string))).toBeGreaterThanOrEqual(0.95);
    // An armchair has no floor a metre from you here: it goes as far off as the room lets it, never against you.
    const chair = made({ op: "add", kind: "armchair", avoid: [you] });
    expect(away(you, item(chair.place, chair.item as string))).toBeGreaterThanOrEqual(0.65);
  });

  it("still finds room for something new in a room too full to keep a metre clear of everyone", () => {
    const place = firstHome();
    // Six standing all over the little room: a metre either side of each leaves no floor at all.
    const standing: [number, number][] = [-1.2, 0, 1.2].flatMap((x): [number, number][] => [
      [x, -0.8],
      [x, 1.0],
    ]);
    const { place: next, item: id } = made({ op: "add", kind: "plant", avoid: standing }, place);
    const added = item(next, id as string);
    for (const p of standing) expect(away(p, added)).toBeGreaterThan(0.2);
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
    // What goes along with a thing moved, and where people stand when one is added: only what makes sense of each.
    expect(editFrom({ op: "move", item: "table", at: [0, 0], facing: 0, with: ["chair", " chair ", 3, ""] })).toEqual({
      op: "move",
      item: "table",
      at: [0, 0],
      facing: 0,
      with: ["chair"],
    });
    // More than it moves at once is refused in words, never cut short with the rest left behind.
    const many = Array.from({ length: 30 }, (_, i) => `chair-${i}`);
    expect(editFrom({ op: "move", item: "table", at: [0, 0], facing: 0, with: many })).toMatch(/more than 24 things/);
    expect(editFrom({ op: "move", item: "table", at: [0, 0], facing: 0, with: many.slice(0, 24) })).toMatchObject({
      with: many.slice(0, 24),
    });
    expect(editFrom({ op: "add", kind: "lamp", avoid: [[1, 2], [1, "x"], "y"] })).toEqual({
      op: "add",
      kind: "lamp",
      avoid: [[1, 2]],
    });
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
