/**
 * Doors agents and people put in between places: who may join which two
 * places, the place words name, where on a wall a door goes from words, and
 * that a door is only there while its way back is. A door put in never stands
 * in the way of the town's own door, or moves it, so every place keeps its way
 * out to the street; and the place tool puts one in, walks it both ways in the
 * world's doors, refuses what it can't do with the reason, and takes one out
 * from either side.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyAction,
  buildWorld,
  homeId,
  PLACE_TYPE,
  PlaceTool,
  roomPlaceId,
  scene,
  tidyByReading,
  WHEREABOUTS_TYPE,
} from "../plugins/places.js";
import {
  findLink,
  type Joining,
  joinPlaces,
  LINK_GRACE_MS,
  type LinkEnd,
  matchLinks,
  placeNamed,
  tidyLinks,
  townDoorsOf,
  whyNoLink,
  withLink,
  withoutLink,
} from "../plugins/places-doors.js";
import { applyEdit, doorsFor, editFrom } from "../plugins/places-edit.js";
import {
  DOORWAY,
  type DoorSlot,
  doorOf,
  doorPlaceWords,
  doorProblems,
  doorSlotAt,
  findDoorSlot,
  findPlacement,
  type Place,
  type PlaceItem,
  type PlaceLink,
  placeProblems,
  resize,
  whyNoDoor,
  withDoorwayHeld,
  withSpots,
} from "../plugins/places-layout.js";
import { homePlace, LOBBY, meetingRoom, sharedPlace } from "../plugins/places-rooms.js";
import { doorsIn, layWorld, type WorldPlace } from "../plugins/places-world.js";
import "../state/builtin.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { ToolContext } from "../tools/interface.js";

const mine: LinkEnd = { id: "home:planner", kind: "home", owner: "planner", name: "planner's home" };
const theirs: LinkEnd = { id: "home:writer", kind: "home", owner: "writer", name: "writer's home" };
const lounge: LinkEnd = { id: "shared:lounge", kind: "shared", name: "the lounge" };
const trip: LinkEnd = { id: "room:local:trip", kind: "room", name: "#trip's meeting room", members: ["planner"] };
const budget: LinkEnd = { id: "room:local:budget", kind: "room", name: "#budget's meeting room", members: ["writer"] };
const hall: LinkEnd = { id: LOBBY, kind: "lobby", name: "the town hall" };
const town: LinkEnd = { id: "town", kind: "town", name: "the town" };
const office: LinkEnd = { id: "office", kind: "office", name: "the office" };
const ENDS = [mine, theirs, lounge, trip, budget, hall, town, office];

describe("who may join two places with a door", () => {
  it("lets an agent join its own home, shared places, and the meeting rooms of rooms it talks in", () => {
    const planner = { agent: "planner" };
    expect(whyNoLink(planner, mine, lounge)).toBeUndefined();
    expect(whyNoLink(planner, lounge, mine)).toBeUndefined();
    expect(whyNoLink(planner, mine, trip)).toBeUndefined();
    expect(whyNoLink(planner, trip, { ...lounge, id: "shared:attic", name: "the attic" })).toBeUndefined();
  });

  it("refuses an agent, saying why, someone else's home, a room it doesn't talk in, and the town's own places", () => {
    const planner = { agent: "planner" };
    expect(whyNoLink(planner, mine, theirs)).toBe("That's writer's home: only writer can put a door into it.");
    expect(whyNoLink(planner, lounge, theirs)).toMatch(/only writer can/);
    expect(whyNoLink(planner, mine, budget)).toBe(
      "#budget's meeting room is for the members of #budget: join the room first, or ask one of them.",
    );
    expect(whyNoLink(planner, mine, hall)).toMatch(/town hall is the town's/);
    expect(whyNoLink(planner, mine, town)).toMatch(/town is outdoors/);
    expect(whyNoLink(planner, mine, office)).toMatch(/The office is laid out from the meeting rooms/);
    expect(whyNoLink(planner, mine, mine)).toMatch(/has to lead somewhere else/);
  });

  it("lets a person join any two places but the town and the office", () => {
    const person = { person: "sam" };
    expect(whyNoLink(person, mine, theirs)).toBeUndefined();
    expect(whyNoLink(person, budget, hall)).toBeUndefined();
    expect(whyNoLink(person, lounge, town)).toMatch(/outdoors/);
    expect(whyNoLink(person, office, lounge)).toMatch(/laid out/);
  });
});

describe("the place words name", () => {
  it("finds home, a shared place, a meeting room, an agent's home, the town hall and the town", () => {
    expect(placeNamed("home", ENDS, "planner")).toBe(mine);
    expect(placeNamed("my room", ENDS, "planner")).toBe(mine);
    expect(placeNamed("the Lounge", ENDS, "planner")).toBe(lounge);
    expect(placeNamed("shared:lounge", ENDS)).toBe(lounge);
    expect(placeNamed("#trip", ENDS)).toBe(trip);
    expect(placeNamed("the trip meeting room", ENDS)).toBe(trip);
    expect(placeNamed("writer", ENDS)).toBe(theirs);
    expect(placeNamed("writer's home", ENDS)).toBe(theirs);
    expect(placeNamed("the town hall", ENDS)).toBe(hall);
    expect(placeNamed("the street", ENDS)).toBe(town);
    expect(placeNamed("the attic", ENDS)).toBeUndefined();
  });

  it("finds a meeting room by its room's name whatever its ref, and a shared place before the town's words", () => {
    // A room on a backend whose refs aren't words: only its name can find it.
    const team: LinkEnd = { id: "room:discord:123456", kind: "room", name: "#budget's meeting room", members: [] };
    const ends = [mine, lounge, team, hall, town];
    for (const words of [
      "#budget",
      "budget",
      "the budget meeting room",
      "budget meeting room",
      "#budget's meeting room",
    ])
      expect(placeNamed(words, ends), words).toBe(team);
    // A shared place someone named after one of the town's words is that place.
    const theHall: LinkEnd = { id: "shared:the-hall", kind: "shared", name: "the hall" };
    const square: LinkEnd = { id: "shared:square", kind: "shared", name: "the square" };
    expect(placeNamed("the hall", [...ends, theHall, square])).toBe(theHall);
    expect(placeNamed("the square", [...ends, theHall, square])).toBe(square);
    expect(placeNamed("the town hall", [...ends, theHall])).toBe(hall);
    expect(placeNamed("the hall", ends)).toBe(hall);
  });

  it("finds a door put in by where it goes, or the only one by itself", () => {
    const names = new Map([
      ["shared:lounge", "the lounge"],
      ["home:writer", "writer's home"],
    ]);
    const nameOf = (id: string) => names.get(id);
    const place = {
      links: [
        { to: "shared:lounge", wall: "left", along: 0 },
        { to: "home:writer", wall: "back", along: 1 },
      ] as PlaceLink[],
    };
    expect(findLink(place, "the door to the lounge", nameOf)?.to).toBe("shared:lounge");
    expect(findLink(place, "the lounge door", nameOf)?.to).toBe("shared:lounge");
    expect(findLink(place, "door to writer's home", nameOf)?.to).toBe("home:writer");
    expect(findLink(place, "door:home:writer", nameOf)?.to).toBe("home:writer");
    // Two doors: "the door" alone could be either.
    expect(findLink(place, "the door", nameOf)).toBeUndefined();
    expect(findLink({ links: place.links.slice(0, 1) }, "the door", nameOf)?.to).toBe("shared:lounge");
    expect(findLink(place, "the couch", nameOf)).toBeUndefined();
  });

  it("never takes a thing's name for a door's, though the words share some letters", () => {
    const names = new Map([
      ["shared:den", "the den"],
      ["shared:bar", "the bar"],
      ["shared:reading-room", "the reading room"],
    ]);
    const nameOf = (id: string) => names.get(id);
    const place = {
      links: [
        { to: "shared:den", wall: "left", along: 0 },
        { to: "shared:bar", wall: "back", along: 1 },
        { to: "shared:reading-room", wall: "front", along: 1 },
      ] as PlaceLink[],
    };
    for (const thing of ["golden lamp", "the garden bench", "the bar stool", "the barbecue", "the", "reading"])
      expect(findLink(place, thing, nameOf), thing).toBeUndefined();
    // Words that say "door" may name its place by a whole word of it; any other words, by its name.
    expect(findLink(place, "the reading door", nameOf)?.to).toBe("shared:reading-room");
    expect(findLink(place, "the bar", nameOf)?.to).toBe("shared:bar");
    expect(findLink(place, "the golden door", nameOf)).toBeUndefined();
  });
});

describe("which doors put in are there", () => {
  const link = (to: string, since?: string): PlaceLink => ({ to, wall: "left", along: 0, ...(since ? { since } : {}) });
  const all = new Set(["home:planner", "shared:lounge", "shared:attic", "room:local:trip"]);
  const exists = (id: string) => all.has(id);

  it("shows a door only while its way back is there, both places are, and once for each pair", () => {
    const links = new Map<string, PlaceLink[]>([
      ["home:planner", [link("shared:lounge"), link("shared:lounge"), link("shared:attic"), link("shared:gone")]],
      ["shared:lounge", [link("home:planner")]],
      // The attic's way back was taken out: the planner's door to it isn't there.
      ["shared:attic", []],
    ]);
    const shown = matchLinks(links, exists);
    expect(shown.get("home:planner")?.map((l) => l.to)).toEqual(["shared:lounge"]);
    expect(shown.get("shared:lounge")?.map((l) => l.to)).toEqual(["home:planner"]);
    expect(shown.has("shared:attic")).toBe(false);
    // A place that is gone takes its doors with it, on both sides.
    expect(matchLinks(links, (id) => exists(id) && id !== "shared:lounge").size).toBe(0);
  });

  it("tidies away a door whose way back is gone, but not one put in a moment ago, whose way back is coming", () => {
    const now = Date.parse("2026-10-20T10:00:00Z");
    const place = {
      ...homePlace("home:planner", "planner's room"),
      links: [
        link("shared:lounge", "2026-10-20T09:00:00Z"),
        link("shared:attic", "2026-10-20T09:00:00Z"),
        link("room:local:trip", new Date(now - LINK_GRACE_MS / 2).toISOString()),
      ],
    };
    const tidied = tidyLinks(place, [link("shared:lounge")], now);
    expect(tidied.links?.map((l) => l.to)).toEqual(["shared:lounge", "room:local:trip"]);
    expect(tidyLinks(tidied, [link("shared:lounge")], now + LINK_GRACE_MS)?.links?.map((l) => l.to)).toEqual([
      "shared:lounge",
    ]);
    // Nothing to tidy: the very same place.
    expect(tidyLinks(tidied, [link("shared:lounge"), link("room:local:trip")], now)).toBe(tidied);
    expect(tidyLinks(place, [], now + 2 * 3600_000).links).toBeUndefined();
  });

  it("puts a door in place of any to the same place, and takes one out", () => {
    const place = withLink(withLink(homePlace("home:planner", "x"), link("shared:lounge")), {
      ...link("shared:lounge"),
      along: 1,
    });
    expect(place.links).toEqual([{ to: "shared:lounge", wall: "left", along: 1 }]);
    expect(withoutLink(place, "shared:lounge").links).toBeUndefined();
  });

  it("takes a door for gone only when its far side was read: no record, or no way back there", async () => {
    const records = new Map<string, Partial<Place>>([
      ["shared:lounge", { links: [link("home:planner")] }],
      ["shared:attic", { links: [link("shared:elsewhere")] }],
    ]);
    // A store that can't say, just now, what the cellar is: its door stays.
    const service = {
      get: async (_caller: StateCaller, ref: { id: string }) => {
        if (ref.id === "shared:cellar") throw new Error("the store is busy");
        const data = records.get(ref.id);
        return data ? { data } : null;
      },
    } as unknown as StateService;
    const old = "2026-10-20T09:00:00Z";
    const place = {
      ...homePlace("home:planner", "x"),
      links: ["shared:lounge", "shared:attic", "shared:gone", "shared:cellar"].map((to) => link(to, old)),
    };
    const tidied = await tidyByReading(service, "home:planner", place, Date.parse("2026-10-20T10:00:00Z"));
    expect(tidied.links?.map((l) => l.to)).toEqual(["shared:lounge", "shared:cellar"]);
  });
});

/** A plain room: 7 m by 6, a window in the middle of the left wall, a bookshelf against the back wall on the left. */
function roomy(): Place {
  const props: PlaceItem[] = [
    { id: "window", name: "the window", kind: "window", at: [-3.49, -0.2], facing: 90, elevation: 1 },
    { id: "bookshelf", name: "the bookshelf", kind: "bookshelf", at: [-1.8, -2.82], facing: 0 },
  ];
  return withSpots({
    name: "the den",
    width: 7,
    depth: 6,
    height: 2.8,
    props,
    spots: [{ id: "middle", name: "the middle of the room", place: "the middle of the room", at: [0, 0.6], facing: 0 }],
    start: "middle",
  });
}

/** The room with every side full: pictures along the walls end to end, and blocks along the open sides. */
function crowded(): Place {
  const room = roomy();
  const props: PlaceItem[] = [];
  const block = (id: string, at: [number, number]): PlaceItem => ({
    id,
    name: `the ${id}`,
    kind: "block",
    at,
    facing: 0,
    size: [0.5, 0.5, 0.5],
  });
  for (let i = 0; i < 7; i++) {
    props.push({
      id: `pb-${i}`,
      name: `the back picture ${i}`,
      kind: "picture",
      at: [-3 + i, -2.99],
      facing: 0,
      elevation: 1.55,
    });
    props.push({
      id: `pl-${i}`,
      name: `the left picture ${i}`,
      kind: "picture",
      at: [-3.49, -3 + i],
      facing: 90,
      elevation: 1.55,
    });
    props.push(block(`front block ${i}`, [-3 + i, 2.7]));
    props.push(block(`right block ${i}`, [3.2, -2.5 + i * 0.9]));
  }
  return withSpots({ ...room, props });
}

describe("where a door goes on a wall", () => {
  it("goes on the wall asked for, by the thing asked for, never over what hangs there or in front of what stands there", () => {
    const room = roomy();
    const slot = findDoorSlot(room, { wall: "left", near: "the window" }, []);
    expect(slot).toMatchObject({ wall: "left" });
    if (typeof slot === "string") throw new Error(slot);
    // Beside the window, not over it.
    expect(Math.abs(slot.along - -0.2)).toBeGreaterThanOrEqual((1.2 + DOORWAY.width) / 2);
    expect(Math.abs(slot.along - -0.2)).toBeLessThan(2);
    expect(doorPlaceWords(room, slot)).toMatch(
      /^on the left wall, (toward the (front|back)|in the middle), by the window$/,
    );
    const back = findDoorSlot(room, { wall: "back" }, []);
    if (typeof back === "string") throw new Error(back);
    expect(back.wall).toBe("back");
    expect(whyNoDoor(room, back, [])).toBeUndefined();
    // Not in front of the bookshelf.
    expect(Math.abs(back.along - -1.8)).toBeGreaterThan((0.9 + DOORWAY.width) / 2 - 0.01);
  });

  it("goes on the side of a thing it was asked for", () => {
    const room = roomy();
    const left = findDoorSlot(room, { near: "the window", side: "left", wall: "left" }, []);
    const right = findDoorSlot(room, { near: "the window", side: "right", wall: "left" }, []);
    if (typeof left === "string" || typeof right === "string") throw new Error(String(left) + String(right));
    // Facing the window on the left wall, your left is toward the front of the room.
    expect(left.wall).toBe("left");
    expect(left.along).toBeGreaterThan(-0.2);
    expect(right.along).toBeLessThan(-0.2);
  });

  it("says why a door can't go where it was asked", () => {
    const room = roomy();
    expect(whyNoDoor(room, { wall: "left", along: -0.2 }, [])).toBe("The window hangs where it would be.");
    expect(whyNoDoor(room, { wall: "back", along: -1.8 }, [])).toBe("The bookshelf stands in front of it.");
    expect(whyNoDoor(room, { wall: "back", along: 2.9 }, [])).toMatch(/run into the corner/);
    expect(
      whyNoDoor(room, { wall: "back", along: 1 }, [
        { slot: { wall: "back", along: 1.5 }, name: "the door out to Maple Lane" },
      ]),
    ).toBe("It would be in the way of the door out to Maple Lane.");
    expect(findDoorSlot(room, { near: "the piano" }, [])).toMatch(/nothing called "the piano"/);
  });

  it("stands a door on its own at an open side, as the town's own door does in a room whose walls are full", () => {
    const room = roomy();
    expect(findDoorSlot(room, { wall: "front" }, [])).toEqual({ wall: "front", along: 0 });
    expect(findDoorSlot(room, { wall: "right" }, [])).toEqual({ wall: "right", along: 0 });
    // With the walls hung end to end, a door with nowhere asked for goes to an open side.
    const walls = withSpots({ ...room, props: crowded().props.filter((p) => p.kind === "picture") });
    const open = findDoorSlot(walls, {}, []);
    expect(open).toMatchObject({ wall: "front" });
  });

  it("refuses a side with no room for a door, saying what a door needs", () => {
    const full = crowded();
    expect(findDoorSlot(full, { wall: "left" }, [])).toMatch(
      /^There's no room for a door on the left wall: a door needs 1.6 m with nothing hanging there and the floor in front of it clear/,
    );
    expect(findDoorSlot(full, { wall: "right" }, [])).toMatch(/on the open right side:/);
    expect(findDoorSlot(full, {}, [])).toMatch(/on any side of the room:/);
  });
});

describe("a room with a door put in, made another size", () => {
  it("moves the door along its side with the room, one near an end keeping its distance from it", () => {
    const room: Place = {
      ...roomy(),
      links: [
        { to: "shared:lounge", wall: "back", along: 0.5 },
        // As far toward the right as a door goes on a side 7 m long.
        { to: "shared:attic", wall: "front", along: 2.4 },
      ],
    };
    const wider = resize(room, { width: 9 });
    if (typeof wider === "string") throw new Error(wider);
    expect(wider.links?.map((l) => [l.wall, l.along])).toEqual([
      ["back", 0.64],
      ["front", 3.4],
    ]);
    const narrower = resize(room, { width: 6 });
    if (typeof narrower === "string") throw new Error(narrower);
    expect(narrower.links?.map((l) => [l.wall, l.along])).toEqual([
      ["back", 0.43],
      ["front", 1.9],
    ]);
    for (const l of narrower.links ?? []) expect(whyNoDoor(narrower, l, [])).toBeUndefined();
  });

  it("refuses a size a door put in would no longer fit in, saying which door and why", () => {
    const slot: DoorSlot = { wall: "left", along: -1.7 };
    const room: Place = { ...roomy(), links: [{ to: "shared:lounge", ...slot }] };
    expect(whyNoDoor(room, slot, [])).toBeUndefined();
    expect(resize(room, { depth: 4.5 })).toMatch(
      /^That size doesn't work for the door put in on the left wall, .*\. It would run into the corner/,
    );
    // Without the door, the same size is fine.
    expect(typeof resize(roomy(), { depth: 4.5 })).toBe("object");
  });
});

describe("the town's own door, with doors put in", () => {
  it("is never where a door put in is, and what is added keeps clear of the doors put in too", () => {
    const room = roomy();
    const street = doorOf(room);
    expect(street).toBeDefined();
    // A door put in right where the town's door was: the town's door goes to the next clear stretch.
    const linked: Place = {
      ...room,
      links: [{ to: "shared:lounge", wall: street?.wall as "back", along: street?.along as number }],
    };
    const moved = doorOf(linked);
    expect(moved).toBeDefined();
    expect(
      doorProblems(linked, [
        moved as never,
        { wall: linked.links?.[0].wall as "back", along: linked.links?.[0].along as number },
      ]),
    ).toEqual([]);
    // Furniture added by the door put in never stands in front of it.
    let next = linked;
    for (const kind of ["armchair", "plant", "lamp", "bookshelf"]) {
      const spot = findPlacement(withDoorwayHeld(next), { kind }, { near: "the door" });
      if (typeof spot === "string") continue;
      next = withSpots({ ...next, props: [...next.props, { id: `${kind}-x`, name: `the ${kind} x`, kind, ...spot }] });
    }
    const link = next.links?.[0] as PlaceLink;
    expect(doorProblems(next, [{ wall: link.wall, along: link.along }])).toEqual([]);
  });
});

describe("what is put in a place with a door put in", () => {
  it("keeps clear of the door, whether an agent adds or moves a thing or a person does", () => {
    const link: PlaceLink = { to: "shared:lounge", wall: "back", along: 0.5 };
    const room: Place = { ...roomy(), links: [link] };
    const slot = { wall: link.wall, along: link.along };
    // An agent adding things along the back wall: each goes beside the door, never in front of it.
    let next = room;
    for (const kind of ["armchair", "plant", "lamp", "bookshelf"]) {
      const out = applyAction(next, { action: "add", kind, wall: "back" });
      if (!out.place) continue;
      next = out.place;
      expect(doorProblems(next, [slot]), kind).toEqual([]);
    }
    expect(next.props.length).toBeGreaterThan(room.props.length);
    // Moved right in front of it: refused, by an agent and by a person.
    expect(applyAction(room, { action: "move", item: "the bookshelf", x: 0.5, z: -2.8 }).place).toSatisfy(
      (p: Place | undefined) => !p || doorProblems(p, [slot]).length === 0,
    );
    expect(applyEdit("home:planner", room, { op: "move", item: "bookshelf", at: [0.5, -2.82], facing: 0 })).toBe(
      "It would block the way through the door.",
    );
  });
});

describe("joining two places", () => {
  const nameOf = (id: string) => ({ "home:planner": "planner's home", "shared:lounge": "the lounge" })[id];
  const end = (id: string, place: Place, name: string): Joining => ({
    id,
    place,
    name,
    out: "the door out to Maple Lane",
  });
  const made = { by: "planner", since: "2026-10-20T10:00:00Z" };

  it("puts the door where the words say and its way back wherever there's room, each to the other, keeping both ways out", () => {
    let joinedAll = 0;
    for (let n = 0; n < 24; n++) {
      const home = homePlace(`home:agent-${n}`, `agent-${n}'s room`);
      const shared = sharedPlace(`shared:place-${n}`, `the place ${n}`);
      // The rooms the world draws keep their walls for furniture and the town's door: a door put in where nothing is
      // asked for finds an open side.
      const joined = joinPlaces(
        end("home:a", home, "a's home"),
        end("shared:b", shared, "the b"),
        n % 2 ? { wall: "front" } : {},
        made,
        nameOf,
      );
      if (typeof joined === "string") throw new Error(`agent-${n}: ${joined}`);
      joinedAll++;
      expect(joined.near.links).toEqual([{ to: "shared:b", ...joined.nearSlot, ...made }]);
      expect(joined.far.links).toEqual([{ to: "home:a", ...joined.farSlot, ...made }]);
      if (n % 2) expect(joined.nearSlot.wall).toBe("front");
      for (const [before, after] of [
        [home, joined.near],
        [shared, joined.far],
      ]) {
        // The town's door is where it was, and nothing is in the way of either door.
        expect(doorOf(after)).toEqual(doorOf(before));
        const slots = [
          ...townDoorsOf("x", after),
          ...(after.links ?? []).map((l) => ({ wall: l.wall, along: l.along })),
        ];
        expect(doorProblems(after, slots)).toEqual([]);
        expect(placeProblems(after)).toEqual([]);
      }
    }
    expect(joinedAll).toBe(24);
  });

  it("keeps clear of a meeting room's whiteboard, ticker and task board, and of café tables, chairs and the cart", () => {
    // The meeting rooms the world draws, every size and look: the way back never hangs over what is on their walls.
    let joinedAll = 0;
    let besideAll = 0;
    for (let n = 2; n <= 13; n++) {
      const meeting = meetingRoom(`#room-${n}`, n, ["", "trip planning", "reading group", "band practice"][n % 4]);
      expect(meeting.props.some((p) => p.kind === "whiteboard")).toBe(true);
      const joined = joinPlaces(
        end("home:a", homePlace(`home:agent-${n}`, `agent-${n}'s room`), "a's home"),
        end(`room:local:room-${n}`, meeting, `#room-${n}'s meeting room`),
        {},
        made,
        nameOf,
      );
      if (typeof joined === "string") throw new Error(`#room-${n}: ${joined}`);
      joinedAll++;
      const slots = [
        ...townDoorsOf("x", joined.far),
        ...(joined.far.links ?? []).map((l) => ({ wall: l.wall, along: l.along })),
      ];
      expect(doorProblems(joined.far, slots)).toEqual([]);
      expect(doorOf(joined.far)).toEqual(doorOf(meeting));
      // Asked for by the whiteboard itself, a door goes beside it, or nowhere: never over it or the board.
      const out = townDoorsOf("x", meeting);
      const by = findDoorSlot(meeting, { near: "the whiteboard" }, [
        ...out.map((slot) => ({ slot, name: "the door out" })),
      ]);
      if (typeof by !== "string") {
        besideAll++;
        expect(doorProblems(meeting, [...out, by])).toEqual([]);
      }
    }
    expect(joinedAll).toBe(12);
    expect(besideAll).toBeGreaterThan(6);
    // A place set out as a café: a cart against the back wall with an activity feed beside it, a table and chair
    // by the left wall and a whiteboard on it. A door asked for on either wall goes beside them, never in front.
    const cafe = withSpots({
      ...roomy(),
      props: [
        { id: "cart", name: "the coffee cart", kind: "coffee_cart", at: [0, -2.5], facing: 0 },
        { id: "feed", name: "the activity feed", kind: "feed", at: [2.6, -2.97], facing: 0, elevation: 0.9 },
        { id: "table", name: "the café table", kind: "cafe_table", at: [-2.9, 2.0], facing: 90 },
        { id: "chair", name: "the café chair", kind: "cafe_chair", at: [-3.0, 1.3], facing: 90 },
        { id: "board", name: "the whiteboard", kind: "whiteboard", at: [-3.47, -1.9], facing: 90, elevation: 1.05 },
      ],
    });
    for (const wall of ["back", "left"] as const) {
      const slot = findDoorSlot(cafe, { wall }, []);
      if (typeof slot === "string") throw new Error(slot);
      expect(slot.wall).toBe(wall);
      expect(doorProblems(cafe, [slot])).toEqual([]);
    }
    expect(whyNoDoor(cafe, { wall: "back", along: 0 }, [])).toBe("The coffee cart stands in front of it.");
    expect(whyNoDoor(cafe, { wall: "back", along: 2.4 }, [])).toBe("The activity feed hangs where it would be.");
    expect(whyNoDoor(cafe, { wall: "left", along: -1.9 }, [])).toBe("The whiteboard hangs where it would be.");
    expect(whyNoDoor(cafe, { wall: "left", along: 1.5 }, [])).toBe("The café table stands in front of it.");
  });

  it("refuses a second door to the same place, a place with all the doors it can have, and no room for the way back", () => {
    const home = homePlace("home:planner", "planner's room");
    const shared = sharedPlace("shared:lounge", "the lounge");
    const once = joinPlaces(
      end("home:planner", home, "planner's home"),
      end("shared:lounge", shared, "the lounge"),
      {},
      made,
      nameOf,
    );
    if (typeof once === "string") throw new Error(once);
    expect(
      joinPlaces(
        end("home:planner", once.near, "planner's home"),
        end("shared:lounge", once.far, "the lounge"),
        {},
        made,
        nameOf,
      ),
    ).toBe("There's already a door to the lounge here.");
    const full: Place = {
      ...home,
      links: Array.from({ length: 6 }, (_, i) => ({ to: `shared:p${i}`, wall: "back" as const, along: -3 + i })),
    };
    expect(
      joinPlaces(
        end("home:planner", full, "planner's home"),
        end("shared:lounge", shared, "the lounge"),
        {},
        made,
        nameOf,
      ),
    ).toMatch(/all the doors put in it can have \(6\)/);
    const walled = crowded();
    expect(
      joinPlaces(
        end("home:planner", home, "planner's home"),
        end("shared:lounge", walled, "the lounge"),
        {},
        made,
        nameOf,
      ),
    ).toMatch(
      /^There's no room in the lounge for the way back: a door needs 1.6 m with nothing hanging there .*every side there is taken/,
    );
  });
});

describe("the doors in a place", () => {
  const places: WorldPlace[] = [
    { id: "home:planner", name: "planner's room", kind: "home", owner: "planner" },
    { id: "shared:lounge", name: "the lounge", kind: "shared" },
  ];

  it("has a door put in, beside the town's, with its plate, while its way back is there", () => {
    const home = {
      ...homePlace("home:planner", "planner's room"),
      links: [{ to: "shared:lounge", wall: "left" as const, along: 0.5, by: "planner" }],
    };
    const lounge = {
      ...sharedPlace("shared:lounge", "the lounge"),
      links: [{ to: "home:planner", wall: "back" as const, along: -1, by: "planner" }],
    };
    const world = layWorld(
      places,
      new Map([
        ["home:planner", home.links],
        ["shared:lounge", lounge.links],
      ]),
    );
    const inHome = doorsIn("home:planner", home, world);
    expect(inHome[0]).toMatchObject({ to: "town", kind: "town" });
    expect(inHome[1]).toEqual({
      wall: "left",
      along: 0.5,
      to: "shared:lounge",
      label: "Lounge",
      kind: "shared",
      by: "planner",
    });
    expect(doorsIn("shared:lounge", lounge, world)[1]).toMatchObject({
      to: "home:planner",
      label: "planner",
      kind: "home",
      occupant: "planner",
    });
    // The way back taken out of the lounge: the planner's door isn't there either, and the town's door still is.
    const alone = layWorld(places, new Map([["home:planner", home.links]]));
    expect(doorsIn("home:planner", home, alone).map((d) => d.to)).toEqual(["town"]);
    // The same town either way: a door put in never lays it out again.
    expect(alone.town).toBe(world.town);
  });
});

describe("people putting doors in and taking them out on the page", () => {
  it("takes out a door put in, but doesn't repaint it, and keeps clear of it while rearranging", () => {
    const room: Place = { ...roomy(), links: [{ to: "shared:lounge", wall: "left", along: 1.8 }] };
    expect(editFrom({ op: "door", to: "shared:lounge" })).toEqual({ op: "door", to: "shared:lounge" });
    expect(editFrom({ op: "door" })).toMatch(/needs `to`/);
    const out = applyEdit("home:planner", room, { op: "remove", item: "door:shared:lounge" });
    expect(typeof out === "string" ? out : out.place.links).toBeUndefined();
    expect(applyEdit("home:planner", room, { op: "color", item: "door:shared:lounge", color: "#ff0000" })).toMatch(
      /keeps the colours/,
    );
    expect(doorsFor("home:planner", room)).toContainEqual({ wall: "left", along: 1.8 });
    // Nothing a person adds lands in front of it.
    const added = applyEdit("home:planner", room, { op: "add", kind: "bookshelf" });
    if (typeof added === "string") throw new Error(added);
    expect(doorProblems(added.place, [{ wall: "left", along: 1.8 }])).toEqual([]);
  });

  it("drags a door put in along the sides to where there's room, never over the window or the town's door", () => {
    const room: Place = { ...roomy(), links: [{ to: "shared:lounge", wall: "left", along: -1.7 }] };
    const street = doorOf(room) as DoorSlot;
    // Taking the door away from where it is doesn't move the town's: it was put in clear of it.
    expect(doorOf(withoutLink(room, "shared:lounge"))).toEqual(street);
    expect(doorSlotAt(room, [1.23, 3.4])).toEqual({ wall: "front", along: 1.25 });
    // Nearest the left wall, but further toward the back than a door can go short of the corner.
    expect(doorSlotAt(room, [-3.4, -2.6])).toEqual({ wall: "left", along: -1.9 });
    const move = (at: [number, number]) =>
      applyEdit(
        "home:planner",
        room,
        { op: "move", item: "door:shared:lounge", at, facing: 0 },
        {
          out: "the door out to Maple Lane",
          nameOf: () => "the lounge",
        },
      );
    const moved = move([1.23, 3.4]);
    expect(typeof moved === "string" ? moved : moved.place.links).toEqual([
      { to: "shared:lounge", wall: "front", along: 1.25 },
    ]);
    expect(move([-3.6, -0.2])).toBe("The window hangs where it would be.");
    const onStreet: [number, number] =
      street.wall === "back"
        ? [street.along, -3.1]
        : street.wall === "left"
          ? [-3.6, street.along]
          : street.wall === "front"
            ? [street.along, 3.1]
            : [3.6, street.along];
    expect(move(onStreet)).toBe("It would be in the way of the door out to Maple Lane.");
  });
});

describe("the place tool's doors", () => {
  const types = [
    { name: PLACE_TYPE, scope: "agent" as const },
    { name: WHEREABOUTS_TYPE, scope: "global" as const },
  ];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const agents = ["planner", "writer"];
  // Agents whose bodies are turned off just now.
  const away = new Set<string>();
  const hasBody = (agent: string | undefined) => agents.includes(agent ?? "default") && !away.has(agent ?? "");
  const rooms = [{ ref: "local:trip", name: "trip", members: ["planner"] }];
  let state: StateService;
  let clock: number;
  const as = (agentName: string) => ({ agentName }) as ToolContext;
  const tool = () =>
    new PlaceTool(
      () => state,
      hasBody,
      undefined,
      () => rooms,
      () => new Date(clock),
      undefined,
      undefined,
      () => agents,
    );
  const read = async (id: string) => (await state.get(owner, { type: PLACE_TYPE, id }))?.data as unknown as Place;
  const doorsOf = async (id: string) => {
    const world = await buildWorld(state, owner, agents, rooms, hasBody);
    return (await scene(state, owner, id, rooms, hasBody, world))?.doors ?? [];
  };
  beforeEach(async () => {
    away.clear();
    clock = Date.parse("2026-10-20T10:00:00Z");
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
      now: () => new Date((clock += 1000)),
    });
    // The planner makes a shared place, and goes home again.
    const t = tool();
    expect((await t.execute({ action: "new", name: "the lounge" }, as("planner"))).success).toBe(true);
    expect((await t.execute({ action: "go", to: "home" }, as("planner"))).success).toBe(true);
  });

  it("puts in a door from home to a shared place, and the lounge has the way back: one door, both ways", async () => {
    const out = await tool().execute({ action: "add", kind: "door", to: "the lounge", wall: "right" }, as("planner"));
    expect(out.success, out.error).toBe(true);
    expect(out.output).toMatch(
      /^Put in a door to the lounge, at the open right side, .*\. Its way back is in the lounge, (on|at the open) /,
    );
    const home = await read(homeId("planner"));
    const lounge = await read("shared:lounge");
    expect(home.links).toMatchObject([{ to: "shared:lounge", wall: "right", by: "planner" }]);
    expect(lounge.links).toMatchObject([{ to: homeId("planner"), by: "planner" }]);
    expect(home.changes?.[0]).toMatchObject({ who: "planner", what: "put in a door to the lounge" });
    // Everyone reads a place's recent changes: the planner's home is the planner's there, not "your home".
    expect(lounge.changes?.[0]).toMatchObject({ who: "planner", what: "put in a door to planner's home" });
    // Each side's door leads to the other, beside its way out to the street.
    expect((await doorsOf(homeId("planner"))).map((d) => [d.to, d.label])).toEqual([
      ["town", expect.any(String)],
      ["shared:lounge", "Lounge"],
    ]);
    expect((await doorsOf("shared:lounge")).map((d) => [d.to, d.label])).toEqual([
      ["town", expect.any(String)],
      [homeId("planner"), "planner"],
    ]);
    // It says where its doors are when it looks round.
    const look = String((await tool().execute({ action: "look" }, as("planner"))).output);
    expect(look).toMatch(/Doors put in: to the lounge, at the open right side, .*\(you put it in\)/);
  });

  it("refuses, saying why, a door to someone else's home, a place that isn't there, a room it doesn't talk in", async () => {
    const t = tool();
    expect((await t.execute({ action: "add", kind: "door", to: "writer" }, as("planner"))).error).toBe(
      "That's writer's home: only writer can put a door into it.",
    );
    expect((await t.execute({ action: "add", kind: "door", to: "the attic" }, as("planner"))).error).toMatch(
      /^There's no place called "the attic"\. A door can lead to: .*the lounge/,
    );
    expect((await t.execute({ action: "add", kind: "door", to: "#trip" }, as("writer"))).error).toMatch(
      /#trip's meeting room is for the members of #trip/,
    );
    expect((await t.execute({ action: "add", kind: "door", to: "the street" }, as("planner"))).error).toMatch(
      /outdoors/,
    );
    expect((await t.execute({ action: "add", kind: "door" }, as("planner"))).error).toMatch(/Say where the door leads/);
    // Nothing was written anywhere.
    expect((await read(homeId("planner"))).links).toBeUndefined();
    expect((await read("shared:lounge")).links).toBeUndefined();
  });

  it("takes a door out from the far side, and it is gone from both", async () => {
    const t = tool();
    await t.execute({ action: "add", kind: "door", to: "the lounge" }, as("planner"));
    // The writer, in the lounge, takes it out: the planner's home can't be changed by the writer, but the door goes.
    await t.execute({ action: "go", to: "the lounge" }, as("writer"));
    const out = await t.execute({ action: "remove", item: "the door to planner's home" }, as("writer"));
    expect(out.success, out.error).toBe(true);
    expect((await read("shared:lounge")).links).toBeUndefined();
    expect((await read("shared:lounge")).changes?.[0]).toMatchObject({
      who: "writer",
      what: "took out the door to planner's home",
    });
    expect((await read(homeId("planner"))).links).toHaveLength(1);
    expect((await doorsOf(homeId("planner"))).map((d) => d.to)).toEqual(["town"]);
    // The planner's side goes from its record the next time its home changes.
    clock += LINK_GRACE_MS;
    await t.execute({ action: "add", kind: "plant", corner: "front right" }, as("planner"));
    expect((await read(homeId("planner"))).links).toBeUndefined();
  });

  it("takes out its own door with the way back, and moves one along its walls", async () => {
    const t = tool();
    await t.execute({ action: "add", kind: "door", to: "the lounge", wall: "right" }, as("planner"));
    const moved = await t.execute({ action: "move", item: "the door to the lounge", wall: "front" }, as("planner"));
    expect(moved.success, moved.error).toBe(true);
    expect(moved.output).toMatch(/^Moved the door to the lounge: it is at the open front side, /);
    expect((await read(homeId("planner"))).links).toMatchObject([{ to: "shared:lounge", wall: "front" }]);
    expect((await t.execute({ action: "move", item: "the door" }, as("planner"))).error).toMatch(
      /Say where to move the door/,
    );
    const out = await t.execute({ action: "remove", item: "the door" }, as("planner"));
    expect(out.success, out.error).toBe(true);
    expect((await read(homeId("planner"))).links).toBeUndefined();
    expect((await read("shared:lounge")).links).toBeUndefined();
    // With none put in, "the door" is the town's, which stays.
    expect((await t.execute({ action: "remove", item: "the door" }, as("planner"))).error).toMatch(
      /is the town's, so it stays/,
    );
  });

  it("says there's no such door, not that the town's stays, for a door put in that isn't here", async () => {
    const t = tool();
    await t.execute({ action: "add", kind: "door", to: "the lounge" }, as("planner"));
    const out = await t.execute({ action: "remove", item: "the door to the attic" }, as("planner"));
    expect(out.error).toBe(
      'There\'s no door put in here called "the door to the attic". The doors put in here lead to: the lounge.',
    );
    expect((await t.execute({ action: "move", item: "the front door", wall: "left" }, as("planner"))).error).toMatch(
      /is the town's, so it stays/,
    );
    // A thing that isn't here, whose name has the lounge's in it, is the usual answer, and the door stays.
    expect((await t.execute({ action: "remove", item: "the lounger" }, as("planner"))).error).toMatch(/lounger/);
    expect((await read(homeId("planner"))).links).toHaveLength(1);
  });

  it("keeps a door to a home whose agent has no body just now, for when it has one again", async () => {
    const t = tool();
    await t.execute({ action: "add", kind: "door", to: "the lounge" }, as("planner"));
    away.add("planner");
    clock += LINK_GRACE_MS;
    await t.execute({ action: "go", to: "the lounge" }, as("writer"));
    const added = await t.execute({ action: "add", kind: "plant" }, as("writer"));
    expect(added.success, added.error).toBe(true);
    expect((await read("shared:lounge")).links).toMatchObject([{ to: homeId("planner") }]);
    away.delete("planner");
    expect((await doorsOf("shared:lounge")).map((d) => d.to)).toContain(homeId("planner"));
  });

  it("undoes a door it put in from both sides, but can't undo taking one out, whose way back went with it", async () => {
    const t = tool();
    await t.execute({ action: "add", kind: "plant" }, as("planner"));
    await t.execute({ action: "add", kind: "door", to: "the lounge" }, as("planner"));
    const undone = await t.execute({ action: "undo" }, as("planner"));
    expect(undone.success, undone.error).toBe(true);
    expect((await read(homeId("planner"))).links).toBeUndefined();
    expect((await read("shared:lounge")).links).toBeUndefined();
    await t.execute({ action: "add", kind: "door", to: "the lounge" }, as("planner"));
    await t.execute({ action: "remove", item: "the door to the lounge" }, as("planner"));
    const back = await t.execute({ action: "undo" }, as("planner"));
    expect(back.error).toBe(
      'That took out the door to the lounge, and its way back went with it, so undo can\'t bring it back. Put it in again with add, kind "door".',
    );
    expect((await read(homeId("planner"))).links).toBeUndefined();
  });

  it("joins a meeting room of a room it talks in, which is kept from then on", async () => {
    const out = await tool().execute({ action: "add", kind: "door", to: "#trip" }, as("planner"));
    expect(out.success, out.error).toBe(true);
    const meeting = await read(roomPlaceId("local:trip"));
    expect(meeting.links).toMatchObject([{ to: homeId("planner") }]);
    expect((await doorsOf(roomPlaceId("local:trip"))).map((d) => d.to)).toContain(homeId("planner"));
  });
});
