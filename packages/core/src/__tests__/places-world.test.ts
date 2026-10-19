/**
 * The world as a building: the lobby with a wing for homes, meeting rooms and
 * shared places, halls that hold at most `HALL_DOORS` doors each, and areas of
 * their own that an agent's places can be in. Every door has its match on the
 * other side, every place can be walked to from its area's way in, adding one
 * agent changes only the hall it joins, and no door is ever in the way of
 * furniture or another door.
 */
import { describe, expect, it } from "vitest";
import {
  DOOR_APPROACH,
  DOORWAY,
  doorOf,
  doorProblems,
  doorwayFloor,
  findPlacement,
  footprintOf,
  KINDS,
  LIMITS,
  type Place,
  placeProblems,
  unreachable,
  withDoorwayHeld,
} from "../plugins/places-layout.js";
import { homePlace, LOBBY, LOBBY_DOORS, lobby, meetingRoom, sharedPlace } from "../plugins/places-rooms.js";
import {
  areaId,
  doorsIn,
  HALL_DOORS,
  hallLayout,
  hallPlace,
  layWorld,
  MAIN,
  packHalls,
  type World,
  type WorldPlace,
} from "../plugins/places-world.js";

const home = (owner: string, area?: string): WorldPlace => ({
  id: `home:${owner}`,
  name: `${owner}'s room`,
  kind: "home",
  owner,
  ...(area ? { area } : {}),
});
const shared = (slug: string, area?: string): WorldPlace => ({
  id: `shared:${slug}`,
  name: `the ${slug.replace(/-/g, " ")}`,
  kind: "shared",
  ...(area ? { area } : {}),
});
const room = (name: string): WorldPlace => ({ id: `room:local:${name}`, name, kind: "room" });

/** Forty-four names spread over the alphabet the way a real team's are: bunched on some letters, none on others. */
const NAMES = [
  "archivist",
  "assistant",
  "auditor",
  "bookkeeper",
  "briefer",
  "builder",
  "cartographer",
  "coach",
  "critic",
  "curator",
  "designer",
  "digest",
  "editor",
  "finder",
  "gardener",
  "greeter",
  "historian",
  "host",
  "inbox",
  "janitor",
  "keeper",
  "librarian",
  "lister",
  "mail-sorter",
  "mapper",
  "narrator",
  "notary",
  "organiser",
  "planner",
  "porter",
  "producer",
  "quizmaster",
  "researcher",
  "reviewer",
  "room-keeper",
  "scheduler",
  "scout",
  "scribe",
  "steward",
  "tester",
  "trip-planner",
  "tutor",
  "writer",
  "zookeeper",
];
const ROOMS = Array.from({ length: 23 }, (_, i) => `channel-${String.fromCharCode(97 + (i % 26))}${i}`);
const big = (): WorldPlace[] => [
  home("default"),
  ...NAMES.map((n) => home(n)),
  ...ROOMS.map(room),
  shared("lounge"),
  shared("studio"),
  shared("garden"),
];

/** Every door in the world, by the place it is in. */
function allDoors(world: World): Map<string, { to: string }[]> {
  const out = new Map<string, { to: string }[]>();
  out.set(
    LOBBY,
    world.lobby.flatMap((l) => (l ? [l] : [])),
  );
  for (const h of world.halls)
    out.set(
      h.id,
      [h.entrance, ...h.rooms, h.onward].flatMap((l) => (l ? [l] : [])),
    );
  for (const [id, link] of world.doors) out.set(id, [link]);
  return out;
}

/** The places you can walk to from `from`, door by door. */
function reach(world: World, from: string): Set<string> {
  const doors = allDoors(world);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const here = queue.shift() as string;
    for (const d of doors.get(here) ?? [])
      if (!seen.has(d.to)) {
        seen.add(d.to);
        queue.push(d.to);
      }
  }
  return seen;
}

describe("the main building", () => {
  it("opens a wing off the lobby for each kind of place, a hall when there are several, straight in when one", () => {
    const world = layWorld([home("planner"), home("reviewer"), home("writer"), room("standup"), shared("lounge")]);
    expect(world.lobby.map((l) => l && [l.to, l.label, l.kind])).toEqual([
      ["hall:main:homes-1", "Residences", "hall"],
      ["room:local:standup", "#standup", "room"],
      ["shared:lounge", "Lounge", "shared"],
    ]);
    const hall = world.halls[0];
    expect(hall.rooms.map((l) => [l.label, l.occupant])).toEqual([
      ["planner", "planner"],
      ["reviewer", "reviewer"],
      ["writer", "writer"],
    ]);
    expect(hall.entrance?.to).toBe(LOBBY);
    expect(world.doors.get("home:planner")).toMatchObject({ to: "hall:main:homes-1", label: "Residences" });
    expect(world.doors.get("room:local:standup")).toMatchObject({ to: LOBBY, label: "Lobby" });
    expect(world.areas).toEqual([
      {
        id: MAIN,
        name: "the main building",
        places: [
          LOBBY,
          "hall:main:homes-1",
          "home:planner",
          "home:reviewer",
          "home:writer",
          "room:local:standup",
          "shared:lounge",
        ],
      },
    ]);
  });

  it("leaves a wing out when there is nothing in it", () => {
    const world = layWorld([home("planner")]);
    expect(world.lobby).toEqual([
      { to: "home:planner", label: "planner", kind: "home", occupant: "planner" },
      undefined,
      undefined,
    ]);
    expect(world.halls).toEqual([]);
  });

  it("holds at most a hall's worth of doors in each hall, cut where the first letter changes, named by its letters", () => {
    const world = layWorld(big());
    const residences = world.halls.filter((h) => /^hall:main:homes-\d+$/.test(h.id));
    const meetings = world.halls.filter((h) => /^hall:main:rooms-\d+$/.test(h.id));
    expect(residences.length).toBeGreaterThanOrEqual(4);
    expect(meetings.length).toBe(2);
    for (const h of world.halls) {
      expect(h.rooms.length, h.id).toBeLessThanOrEqual(HALL_DOORS);
      expect(h.rooms.length, h.id).toBeGreaterThan(0);
    }
    // No letter is split across two halls when it fits in one.
    const letter = (l: { label: string }) => l.label.charAt(0).toUpperCase();
    for (const [i, h] of residences.entries())
      if (residences[i + 1]) expect(letter(h.rooms.at(-1) as never)).not.toBe(letter(residences[i + 1].rooms[0]));
    expect(residences.map((h) => h.name)).toEqual(
      residences.map((h) => `Residences ${letter(h.rooms[0])}–${letter(h.rooms.at(-1) as never)}`),
    );
    // In front of them, a foyer off the lobby with a door to each, in order; each hall's way back is to it.
    const foyer = world.halls.find((h) => h.id === "hall:main:homes-foyer");
    expect(foyer).toMatchObject({ name: "Residences", entrance: { to: LOBBY } });
    expect(foyer?.rooms.map((r) => [r.to, r.label, r.kind])).toEqual(residences.map((h) => [h.id, h.name, "hall"]));
    expect(world.lobby[0]).toEqual({ to: "hall:main:homes-foyer", label: "Residences", kind: "hall" });
    for (const h of residences) {
      expect(h.entrance?.to).toBe("hall:main:homes-foyer");
      expect(h.onward).toBeUndefined();
    }
  });

  it("puts every place three doors from the lobby at most, with a hundred and more agents", () => {
    const depth = (world: World) => {
      const doors = allDoors(world);
      const seen = new Map([[LOBBY, 0]]);
      const queue = [LOBBY];
      while (queue.length) {
        const here = queue.shift() as string;
        for (const d of doors.get(here) ?? [])
          if (!seen.has(d.to)) {
            seen.set(d.to, (seen.get(here) as number) + 1);
            queue.push(d.to);
          }
      }
      return seen;
    };
    const crowd = [
      ...Array.from({ length: 120 }, (_, i) => home(`${"abcdefghijklmnopqrstuvwxyz"[i % 26]}gent-${i}`)),
      ...Array.from({ length: 60 }, (_, i) => room(`${"abcdefghijklmnopqrstuvwxyz"[i % 26]}-room-${i}`)),
    ];
    for (const places of [big(), crowd]) {
      const world = layWorld(places);
      const steps = depth(world);
      for (const p of places) expect(steps.get(p.id), p.id).toBeLessThanOrEqual(3);
    }
  });

  it("can walk to every place from the lobby, and every door has its match on the other side", () => {
    const world = layWorld(big());
    const reached = reach(world, LOBBY);
    for (const p of big()) expect(reached.has(p.id), p.id).toBe(true);
    for (const h of world.halls) expect(reached.has(h.id), h.id).toBe(true);
    const doors = allDoors(world);
    for (const [here, list] of doors)
      for (const d of list)
        expect(
          doors.get(d.to)?.some((back) => back.to === here),
          `${here} -> ${d.to}`,
        ).toBe(true);
  });

  it("carries a foyer on into the next when there are more halls than a foyer has doors", () => {
    const places = Array.from({ length: 250 }, (_, i) => home(`agent-${String(i).padStart(3, "0")}`));
    const world = layWorld(places);
    const foyers = world.halls.filter((h) => h.id.startsWith("hall:main:homes-foyer"));
    expect(foyers.map((f) => [f.id, f.name])).toEqual([
      ["hall:main:homes-foyer", "Residences"],
      ["hall:main:homes-foyer-2", "Residences 2"],
    ]);
    expect(foyers[0].onward?.to).toBe(foyers[1].id);
    expect(foyers[1].entrance?.to).toBe(foyers[0].id);
    for (const f of foyers) expect(f.rooms.length).toBeLessThanOrEqual(HALL_DOORS);
    const reached = reach(world, LOBBY);
    for (const p of places) expect(reached.has(p.id), p.id).toBe(true);
    const doors = allDoors(world);
    for (const [here, list] of doors)
      for (const d of list)
        expect(
          doors.get(d.to)?.some((back) => back.to === here),
          `${here} -> ${d.to}`,
        ).toBe(true);
  });

  it("changes only the hall a new agent joins, and keeps every other door where it was", () => {
    const before = layWorld(big());
    // An agent whose letter's hall has room.
    const after = layWorld([...big(), home("quartermaster")]);
    const where = (w: World) => new Map(w.halls.flatMap((h) => h.rooms.map((r, i) => [r.to, `${h.id}#${i}`] as const)));
    const was = where(before);
    const now = where(after);
    const joined = after.halls.find((h) => h.rooms.some((r) => r.to === "home:quartermaster"))?.id;
    const moved = [...was].filter(([id, at]) => now.get(id) !== at).map(([id]) => id);
    expect(moved.length).toBeGreaterThan(0);
    for (const id of moved) expect(now.get(id)?.startsWith(`${joined}#`), id).toBe(true);
    expect(after.halls.map((h) => h.id)).toEqual(before.halls.map((h) => h.id));
    // One more in a full hall moves a letter on to the next hall; the halls before it stay as they were.
    const full = layWorld([...big(), home("historian-two")]);
    const fullAt = where(full);
    const into = full.halls.find((h) => h.rooms.some((r) => r.to === "home:historian-two"));
    const homes = before.halls.filter((h) => /^hall:main:homes-\d+$/.test(h.id));
    for (const h of homes.slice(
      0,
      homes.findIndex((o) => o.id === into?.id),
    ))
      for (const r of h.rooms) expect(fullAt.get(r.to), r.to).toBe(was.get(r.to));
  });

  it("packs whole letters into halls, splitting only a letter too big for one", () => {
    const letter = (s: string) => s[0];
    expect(packHalls(["a1", "a2", "b1", "c1", "c2", "c3"], letter, 4)).toEqual([
      ["a1", "a2", "b1"],
      ["c1", "c2", "c3"],
    ]);
    expect(packHalls(["s1", "s2", "s3", "s4", "s5"], letter, 2)).toEqual([["s1", "s2"], ["s3", "s4"], ["s5"]]);
    expect(packHalls([], letter, 4)).toEqual([]);
    // A letter too big for a hall tops up the one before; a full one is left as it is.
    expect(packHalls(["a1", "s1", "s2", "s3", "s4", "s5"], letter, 2)).toEqual([
      ["a1", "s1"],
      ["s2", "s3"],
      ["s4", "s5"],
    ]);
    expect(packHalls(["a1", "a2", "s1", "s2", "s3"], letter, 2)).toEqual([["a1", "a2"], ["s1", "s2"], ["s3"]]);
    // Nothing is ever lost or repeated.
    const names = Array.from({ length: 50 }, (_, i) => `${"aabsssssssssssssssssssttz"[i % 25]}${i}`).sort();
    for (const cap of [2, 5, 14]) expect(packHalls(names, letter, cap).flat()).toEqual(names);
  });

  it("numbers the halls of a letter too big for one hall", () => {
    const many = Array.from({ length: 30 }, (_, i) => home(`scout-${String(i).padStart(2, "0")}`));
    const world = layWorld([home("archivist"), ...many]);
    expect(world.halls.map((h) => [h.name, h.rooms.length])).toEqual([
      ["Residences", 3],
      ["Residences A–S", 14],
      ["Residences S 1", 14],
      ["Residences S 2", 3],
    ]);
    expect(new Set(world.halls.map((h) => h.name)).size).toBe(world.halls.length);
  });

  it("keeps rooms agents talk in in the main building, whatever they are about", () => {
    const world = layWorld([{ ...room("trip"), area: "the beach" }, room("standup")]);
    expect(world.areaOf.get("room:local:trip")).toBe(MAIN);
    expect(world.areas.map((a) => a.id)).toEqual([MAIN]);
  });
});

describe("areas of their own", () => {
  it("joins two places door to door, and more round a hall of their own, apart from the main building", () => {
    const world = layWorld([
      home("planner"),
      home("writer", "the summer house"),
      shared("porch", "The Summer House"),
      shared("kitchen", "the cabin"),
      shared("loft", "the cabin"),
      shared("cellar", "the cabin"),
      shared("hideout", "the den"),
    ]);
    expect(world.areas.map((a) => [a.id, a.name])).toEqual([
      [MAIN, "the main building"],
      ["cabin", "the cabin"],
      ["den", "the den"],
      ["summer-house", "the summer house"],
    ]);
    // Door to door.
    expect(world.doors.get("home:writer")?.to).toBe("shared:porch");
    expect(world.doors.get("shared:porch")?.to).toBe("home:writer");
    // Round a hall, which nothing in the main building leads to.
    const cabin = world.halls.find((h) => h.area === "cabin");
    expect(cabin).toMatchObject({ id: "hall:cabin:1", name: "Cabin hall" });
    expect(cabin?.entrance).toBeUndefined();
    expect(cabin?.rooms.map((r) => r.to)).toEqual(["shared:cellar", "shared:kitchen", "shared:loft"]);
    expect(world.areas.find((a) => a.id === "cabin")?.places[0]).toBe("hall:cabin:1");
    // Alone in its area: no door at all, and the map is the way there.
    expect(world.doors.has("shared:hideout")).toBe(false);
    const fromLobby = reach(world, LOBBY);
    expect(fromLobby.has("home:planner")).toBe(true);
    for (const id of ["home:writer", "shared:porch", "hall:cabin:1", "shared:hideout"])
      expect(fromLobby.has(id)).toBe(false);
    for (const area of world.areas) {
      const reached = reach(world, area.places[0]);
      for (const id of area.places) expect(reached.has(id), `${area.id}: ${id}`).toBe(true);
    }
  });

  it("reads any way of saying the main building as the main building", () => {
    for (const words of [undefined, "", "main", "the main building", "Main Building", "lobby"])
      expect(areaId(words)).toBe(MAIN);
    expect(areaId("The Summer House!")).toBe("summer-house");
  });
});

describe("halls", () => {
  const world = layWorld(big());

  it("are sound rooms to walk down: nothing overlaps, every spot can be reached, within the sizes allowed", () => {
    for (const hall of world.halls) {
      const place = hallPlace(hall);
      expect(placeProblems(place), hall.id).toEqual([]);
      expect(unreachable(place), hall.id).toEqual([]);
      expect(place.width).toBeLessThanOrEqual(LIMITS.width[1]);
      expect(place.name).toBe(hall.name);
      // Benches to sit on, plants, lamps for the evening, and a sign saying which hall it is.
      const kinds = place.props.map((p) => p.kind);
      for (const k of ["bench", "plant", "lamp", "sign"]) expect(kinds, `${hall.id} ${k}`).toContain(k);
      expect(place.props.find((p) => p.kind === "sign")?.label).toBe(hall.name);
    }
  });

  it("have their doors clear of each other and of everything in the hall", () => {
    for (const hall of world.halls) {
      const place = hallPlace(hall);
      const doors = doorsIn(hall.id, place, world);
      expect(doors.length).toBe(hall.rooms.length + (hall.entrance ? 1 : 0) + (hall.onward ? 1 : 0));
      expect(doorProblems(place, doors), hall.id).toEqual([]);
    }
    // A full hall's doors read left to right, at the back and then facing it at the front.
    const layout = hallLayout(HALL_DOORS);
    expect(layout.rooms.slice(0, 4).map((d) => d.wall)).toEqual(["back", "front", "back", "front"]);
    expect(layout.rooms[0].along).toBe(layout.rooms[1].along);
    expect(layout.rooms[2].along).toBeGreaterThan(layout.rooms[0].along);
  });
});

describe("a room's own door", () => {
  const homes = Array.from({ length: 120 }, (_, i) => homePlace(`home:agent-${i}`, `agent ${i}`));
  const meetings = [2, 4, 6, 9, 16].flatMap((n) =>
    ["standup", "vacation", "code review"].map((t) => meetingRoom(t, n)),
  );
  const shares = ["lounge", "attic", "library", "porch"].map((s) => sharedPlace(`shared:${s}`, `the ${s}`));

  it("is on a solid wall in every room the world starts with, where the room keeps its doorway, with nothing in the way", () => {
    for (const place of [...homes, ...meetings, ...shares]) {
      const door = doorOf(place);
      expect(door, place.name).toBeDefined();
      expect(["back", "left"]).toContain(door?.wall);
      expect(doorProblems(place, [door as never]), place.name).toEqual([]);
    }
  });

  it("gives the lobby a door at each of its doorways, clear of the kiosks and the board", () => {
    const world = layWorld(big());
    const doors = doorsIn(LOBBY, lobby(), world);
    expect(doors.map((d) => [d.wall, d.along])).toEqual(LOBBY_DOORS.map((d) => [d.wall, d.along]));
    expect(doorProblems(lobby(), doors)).toEqual([]);
  });

  it("goes to the open front or right when the walls are full, and is missing only when there is no floor for one", () => {
    const base = homePlace("home:agent-1", "agent 1");
    // Windows the whole length of both walls.
    const windows = (wall: "back" | "left", span: number) =>
      Array.from({ length: Math.floor(span / 1.25) }, (_, i) => ({
        id: `w-${wall}-${i}`,
        name: `window ${wall} ${i}`,
        kind: "window",
        at:
          wall === "back"
            ? [-span / 2 + 0.65 + i * 1.25, -base.depth / 2 + 0.01]
            : [-base.width / 2 + 0.01, -span / 2 + 0.65 + i * 1.25],
        facing: wall === "back" ? 0 : 90,
        elevation: 1,
      }));
    const full: Place = {
      ...base,
      props: [
        ...base.props.filter((p) => KINDS[p.kind]?.mount !== "wall"),
        ...windows("back", base.width),
        ...windows("left", base.depth),
      ] as Place["props"],
    };
    const door = doorOf(full);
    expect(["front", "right"]).toContain(door?.wall);
    expect(doorProblems(full, [door as never])).toEqual([]);
  });

  it("keeps whatever an agent adds out of the doorway, so the door stays where it is", () => {
    let place = homePlace("home:agent-3", "agent 3");
    const door = doorOf(place);
    for (const kind of [
      "armchair",
      "plant",
      "bookshelf",
      "lamp",
      "couch",
      "plant",
      "side_table",
      "window",
      "picture",
      "tall_plant",
      "beanbag",
      "plant",
    ]) {
      // Asked for right in front of the door, by name and by place.
      for (const where of [
        { near: "the door" },
        {
          x: door?.wall === "left" ? -place.width / 2 + 0.5 : (door?.along ?? 0),
          z: door?.wall === "left" ? door?.along : -place.depth / 2 + 0.5,
        },
        {},
      ]) {
        const got = findPlacement(withDoorwayHeld(place), { kind }, where as never);
        if (typeof got === "string") continue;
        place = {
          ...place,
          props: [
            ...place.props,
            { id: `${kind}-${place.props.length}`, name: `the ${kind} ${place.props.length}`, kind, ...got },
          ],
        };
      }
    }
    expect(doorOf(place)).toEqual(door);
    expect(doorProblems(place, [door as never])).toEqual([]);
    // Nothing was ever put on the door itself.
    expect(place.props.some((p) => p.on === "doorway-hold")).toBe(false);
  });

  it("puts what is asked for near the door beside it, never on the floor where you come in", () => {
    // The floor a thing covers, as [minX, maxX, minZ, maxZ], turned the way it faces.
    const box = (kind: string, at: [number, number], facing: number) => {
      const [w, d] = footprintOf({ kind });
      const f = (facing * Math.PI) / 180;
      const hx = (Math.abs(Math.cos(f)) * w + Math.abs(Math.sin(f)) * d) / 2;
      const hz = (Math.abs(Math.sin(f)) * w + Math.abs(Math.cos(f)) * d) / 2;
      return [at[0] - hx, at[0] + hx, at[1] - hz, at[1] + hz];
    };
    let beside = 0;
    let placed = 0;
    for (const place of homes.slice(0, 40)) {
      const door = doorOf(place) as NonNullable<ReturnType<typeof doorOf>>;
      const floor = doorwayFloor(place, door, DOOR_APPROACH.wall);
      const way = [
        floor.at[0] - floor.size[0] / 2,
        floor.at[0] + floor.size[0] / 2,
        floor.at[1] - floor.size[1] / 2,
        floor.at[1] + floor.size[1] / 2,
      ];
      for (const kind of ["armchair", "plant", "bookshelf", "lamp", "side_table"]) {
        const got = findPlacement(withDoorwayHeld(place), { kind }, { near: "the door" });
        if (typeof got === "string") continue;
        placed++;
        const [x0, x1, z0, z1] = box(kind, got.at, got.facing);
        const inWay = x0 < way[1] - 0.01 && x1 > way[0] + 0.01 && z0 < way[3] - 0.01 && z1 > way[2] + 0.01;
        expect(inWay, `${place.name}: ${kind} at ${got.at}`).toBe(false);
        // Beside: off to one side of the way in, along the door's wall, rather than out past the end of it.
        const off =
          door.wall === "back"
            ? x1 <= way[0] + 0.01 || x0 >= way[1] - 0.01
            : z1 <= way[2] + 0.01 || z0 >= way[3] - 0.01;
        if (off) beside++;
      }
    }
    expect(placed).toBeGreaterThan(150);
    expect(beside / placed).toBeGreaterThan(0.9);
  });

  it("leaves a room alone in its area without a door, and a room the building doesn't know without one too", () => {
    const world = layWorld([home("planner", "the attic")]);
    expect(doorsIn("home:planner", homePlace("home:planner", "planner's room"), world)).toEqual([]);
    expect(doorsIn("shared:nowhere", sharedPlace("shared:nowhere", "nowhere"), world)).toEqual([]);
  });

  it("keeps a doorway as wide as a door and as deep as a step in", () => {
    expect(DOORWAY.width).toBeGreaterThanOrEqual(1.4);
    expect(DOORWAY.depth).toBeGreaterThanOrEqual(0.8);
  });
});
