/**
 * The world as a town: a house on a lane for every agent, the town hall and
 * the office on the square, themed rooms on main street and beach rooms on
 * the sand, plots of their own at the edge of town for areas, and the
 * office's floors for every other meeting room. Nothing in the town overlaps
 * anything else, every door can be walked to from the square, every door has
 * its match on the other side, adding one agent changes only the lane it
 * joins, and no door is ever in the way of furniture or another door.
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
  type Building,
  doorOfBuilding,
  inBuilding,
  LANE_HOMES,
  laneSlot,
  nearLine,
  overlaps,
  packLanes,
  streamX,
  TOWN,
  type Town,
  townDoors,
  townPlace,
} from "../plugins/places-town.js";
import {
  areaId,
  doorsIn,
  FLOOR_DOORS,
  floorLayout,
  floorPlace,
  layWorld,
  MAIN,
  OFFICE,
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
const room = (name: string, theme?: string): WorldPlace => ({
  id: `room:local:${name}`,
  name,
  kind: "room",
  ...(theme ? { theme } : {}),
});

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
  ...ROOMS.map((r) => room(r)),
  room("campaign", "tavern"),
  room("podcast", "studio"),
  room("deploys", "workshop"),
  room("reading-group", "library"),
  room("trip", "beach"),
  room("vacation", "beach"),
  shared("lounge"),
  shared("studio"),
  shared("garden"),
];

/** Every door in the world, by the place it is in. */
function allDoors(world: World): Map<string, { to: string }[]> {
  const out = new Map<string, { to: string }[]>();
  out.set(
    TOWN,
    townDoors(world.town).map((d) => ({ to: d.building.id })),
  );
  for (const f of world.floors)
    out.set(
      f.id,
      [f.entrance, ...f.rooms, f.up].flatMap((l) => (l ? [l] : [])),
    );
  for (const [id, link] of world.doors) if (!out.has(id)) out.set(id, [link]);
  return out;
}

/** The places you can go to from `from`, door by door. */
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

/** Where you stand having come out of a building's door: a step and a half out in front of it. */
function outside(b: Building): [number, number] {
  const door = doorOfBuilding(b);
  const f = (door.facing * Math.PI) / 180;
  return [door.at[0] + Math.sin(f) * 1.7, door.at[1] + Math.cos(f) * 1.7];
}

/**
 * The ground of the town you can walk on, as a grid of half-metre cells, from
 * the square: everything but the buildings, the water (bar the bridges), the
 * pond and the fountain. Which of `points` it reaches.
 */
function walkable(town: Town, points: [number, number][]): boolean[] {
  const cell = 0.5;
  const cols = Math.ceil(town.width / cell);
  const rows = Math.ceil(town.depth / cell);
  const centre = (i: number, j: number): [number, number] => [
    -town.width / 2 + (i + 0.5) * cell,
    -town.depth / 2 + (j + 0.5) * cell,
  ];
  const onBridge = ([x, z]: [number, number]) =>
    town.stream.bridges.some((b) => Math.abs(x - b.at[0]) <= b.length / 2 && Math.abs(z - b.at[1]) <= 1.6);
  const free = ([x, z]: [number, number]) =>
    z < town.shore.sea - 0.3 &&
    Math.hypot(x, z) > 2 &&
    !town.buildings.some((b) => inBuilding(b, [x, z], 0.25)) &&
    (Math.abs(x - streamX(z)) > town.stream.width / 2 + 0.25 || onBridge([x, z])) &&
    !(
      Math.abs(x - town.park.pond.at[0]) < town.park.pond.size[0] / 2 &&
      Math.abs(z - town.park.pond.at[1]) < town.park.pond.size[1] / 2
    );
  const seen = new Uint8Array(cols * rows);
  const cellOf = ([x, z]: [number, number]) => [
    Math.floor((x + town.width / 2) / cell),
    Math.floor((z + town.depth / 2) / cell),
  ];
  const [si, sj] = cellOf([0, 7]);
  const queue = [si + sj * cols];
  seen[queue[0]] = 1;
  while (queue.length) {
    const k = queue.pop() as number;
    const i = k % cols;
    const j = Math.floor(k / cols);
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nk = ni + nj * cols;
      if (seen[nk] || !free(centre(ni, nj))) continue;
      seen[nk] = 1;
      queue.push(nk);
    }
  }
  return points.map((p) => {
    const [i, j] = cellOf(p);
    return !!seen[i + j * cols];
  });
}

describe("the town", () => {
  const world = layWorld(big());
  const { town } = world;
  const of = (id: string) => town.buildings.find((b) => b.id === id) as Building;

  it("has a building for every home and shared place, the town hall and the office, and the themed rooms", () => {
    for (const n of ["default", ...NAMES]) expect(of(`home:${n}`)?.kind, n).toBe("house");
    expect(of(LOBBY)).toMatchObject({ kind: "hall", label: "Town hall", street: "The square" });
    expect(of(OFFICE)).toMatchObject({ kind: "office", label: "Office" });
    expect(of("room:local:campaign").kind).toBe("tavern");
    expect(of("room:local:podcast").kind).toBe("studio");
    expect(of("room:local:deploys").kind).toBe("workshop");
    expect(of("room:local:reading-group").kind).toBe("library");
    for (const s of ["lounge", "studio", "garden"])
      expect(of(`shared:${s}`)).toMatchObject({ kind: "shop", street: "Main Street" });
    // Beach rooms are huts on the sand, between the promenade and the sea.
    for (const r of ["trip", "vacation"]) {
      const hut = of(`room:local:${r}`);
      expect(hut.kind).toBe("hut");
      expect(hut.at[1]).toBeGreaterThan(town.shore.sand);
      expect(hut.at[1] + hut.size[1] / 2).toBeLessThan(town.shore.sea);
    }
    // A plain meeting room has no building: it is behind a door in the office.
    expect(town.buildings.some((b) => b.id.startsWith("room:local:channel"))).toBe(false);
  });

  it("puts the town hall across the square from where you start, facing you, and the house doors on to their lanes", () => {
    const hall = of(LOBBY);
    expect(hall.facing).toBe(0);
    expect(hall.at[1]).toBeLessThan(-town.square.radius);
    expect(townPlace(town).spots.find((s) => s.id === "square")?.facing).toBe(180);
    for (const b of town.buildings.filter(
      (x) => x.kind === "house" && !x.street.match(/^[A-Z][a-z]+ (Lane|Way|Row|Close|Street|Walk)/),
    ))
      throw new Error(`${b.id} is on ${b.street}`);
    // Each house's door is on its lane, and faces it.
    for (const b of town.buildings.filter((x) => x.kind === "house")) {
      const lane = town.roads.find((r) => r.name === b.street);
      expect(lane, b.id).toBeDefined();
      expect(nearLine(lane?.points ?? [], outside(b), (lane?.width ?? 0) / 2 + 1), b.id).toBe(true);
    }
  });

  it("keeps every building clear of every other, of the roads, the square and the water", () => {
    const { buildings } = town;
    for (let i = 0; i < buildings.length; i++)
      for (let j = i + 1; j < buildings.length; j++)
        expect(overlaps(buildings[i], buildings[j], 1), `${buildings[i].id} / ${buildings[j].id}`).toBe(false);
    for (const b of buildings) {
      for (const r of town.roads)
        for (const p of r.points) expect(inBuilding(b, p, r.width / 2), `${b.id} on ${r.id}`).toBe(false);
      for (const p of town.stream.points)
        expect(inBuilding(b, p, town.stream.width / 2 + 0.5), `${b.id} in the stream`).toBe(false);
      for (const [x, z] of [
        [0, 0],
        ...Array.from({ length: 16 }, (_, k) => [Math.sin(k) * town.square.radius, Math.cos(k) * town.square.radius]),
      ] as [number, number][])
        expect(inBuilding(b, [x, z]), `${b.id} on the square`).toBe(false);
      expect(b.at[1] + b.size[1] / 2, `${b.id} in the sea`).toBeLessThan(town.shore.sea);
    }
    // Trees and lamps stand clear of the buildings too.
    for (const [x, z] of town.trees) expect(buildings.some((b) => inBuilding(b, [x, z], 0.5))).toBe(false);
    for (const p of town.lamps) expect(buildings.some((b) => inBuilding(b, p, 0.2))).toBe(false);
  });

  it("can walk from the square to every door, round the buildings and over the bridges", () => {
    const doors = town.buildings.map(outside);
    const reached = walkable(town, doors);
    expect(town.buildings.filter((_, i) => !reached[i]).map((b) => b.id)).toEqual([]);
    // Every door stands inside the ground you can walk on.
    for (const [x, z] of doors) {
      expect(Math.abs(x)).toBeLessThan(town.width / 2);
      expect(Math.abs(z)).toBeLessThan(town.depth / 2);
    }
  });

  it("fills lanes in name order, a lane's worth each, cut where the first letter changes, each with a name", () => {
    const lanes = town.roads.filter((r) => r.kind === "lane");
    expect(lanes.length).toBe(4);
    expect(lanes.map((l) => l.name)).toEqual(["Maple Lane", "Willow Way", "Birch Row", "Cedar Close"]);
    const on = (lane: string) => town.buildings.filter((b) => b.street === lane).map((b) => b.label);
    for (const l of lanes) expect(on(l.name as string).length).toBeLessThanOrEqual(LANE_HOMES);
    expect(on("Maple Lane").slice(0, 3)).toEqual(["archivist", "assistant", "auditor"]);
    // A lane ends where a letter does: the next one starts on a new letter.
    const lastOf = (lane: string) => on(lane).at(-1)?.charAt(0);
    expect(lastOf("Maple Lane")).not.toBe(on("Willow Way")[0].charAt(0));
    // The first two lanes are west of the square, one either side of the avenue; then east.
    expect([laneSlot(0), laneSlot(1), laneSlot(2), laneSlot(3)].map((s) => [Math.sign(s.x), s.north])).toEqual([
      [-1, true],
      [-1, false],
      [1, true],
      [1, false],
    ]);
  });

  it("makes streets you can walk in good time: no lane longer than a lane's worth of houses needs", () => {
    for (const r of town.roads.filter((x) => x.kind === "lane")) {
      const length = r.points
        .slice(1)
        .reduce((n, p, i) => n + Math.hypot(p[0] - r.points[i][0], p[1] - r.points[i][1]), 0);
      expect(length, r.id).toBeGreaterThan(15);
      expect(length, r.id).toBeLessThan(60);
    }
    // The square to the far end of town and back is a few minutes' walk, not a trek.
    expect(Math.max(town.width, town.depth)).toBeLessThan(220);
  });

  it("changes only the lane a new agent joins, and keeps every other building where it was", () => {
    const before = layWorld(big()).town;
    const after = layWorld([...big(), home("quartermaster")]).town;
    const lane = after.buildings.find((b) => b.id === "home:quartermaster")?.street;
    for (const b of before.buildings) {
      const now = after.buildings.find((x) => x.id === b.id);
      if (b.street === lane) continue;
      expect(now?.at, b.id).toEqual(b.at);
      expect(now?.facing, b.id).toBe(b.facing);
    }
  });

  it("packs whole letters into lanes, splitting only a letter too big for one", () => {
    const letters = ["a", "a", "b", "b", "b", "c", "c", "c", "c", "d"];
    expect(packLanes(letters, (l) => l, 5)).toEqual([
      ["a", "a", "b", "b", "b"],
      ["c", "c", "c", "c", "d"],
    ]);
    expect(packLanes(Array(12).fill("s"), (l) => l, 5).map((h) => h.length)).toEqual([5, 5, 2]);
  });

  it("stays sound with a hundred and more agents: nothing overlaps, and every door can be walked to", () => {
    const many = Array.from({ length: 130 }, (_, i) => home(`agent-${String(i).padStart(3, "0")}`));
    const huge = layWorld([...many, ...ROOMS.map((r) => room(r))]).town;
    for (let i = 0; i < huge.buildings.length; i++)
      for (let j = i + 1; j < huge.buildings.length; j++)
        expect(overlaps(huge.buildings[i], huge.buildings[j], 1), `${huge.buildings[i].id}`).toBe(false);
    const reached = walkable(huge, huge.buildings.map(outside));
    expect(huge.buildings.filter((_, i) => !reached[i]).map((b) => b.id)).toEqual([]);
  });

  it("keeps huts on the sand clear of each other, of the stream and of the beach's things, however many there are", () => {
    for (const homes of [3, 13, 44])
      for (const n of [4, 6, 8]) {
        const beach = Array.from({ length: n }, (_, i) => room(`beach-${i}`, "beach"));
        const t = layWorld([...NAMES.slice(0, homes).map((x) => home(x)), ...beach]).town;
        const label = `${homes} homes, ${n} huts`;
        const huts = t.buildings.filter((b) => b.kind === "hut");
        expect(huts, label).toHaveLength(n);
        for (const b of huts) {
          for (const p of t.stream.points)
            expect(inBuilding(b, p, t.stream.width / 2 + 0.5), `${label}: ${b.id} in the stream`).toBe(false);
          for (const o of t.buildings)
            if (o !== b) expect(overlaps(b, o, 1), `${label}: ${b.id} / ${o.id}`).toBe(false);
          expect(b.at[1] + b.size[1] / 2, `${label}: ${b.id} in the sea`).toBeLessThan(t.shore.sea);
        }
        // The promenade runs past the last of them, and you can walk to every one.
        const promenade = t.roads.find((r) => r.id === "promenade")?.points ?? [];
        const furthest = Math.max(...huts.map((b) => Math.abs(b.at[0]) + b.size[0] / 2));
        expect(Math.max(...promenade.map((q) => Math.abs(q[0]))), label).toBeGreaterThan(furthest);
        expect(walkable(t, huts.map(outside)).every(Boolean), label).toBe(true);
        const doors = huts.map(outside);
        for (const p of townPlace(t).props.filter((x) => x.kind === "palm" || x.kind === "umbrella")) {
          expect(
            huts.some((b) => inBuilding(b, p.at, 0.2)),
            `${label}: ${p.id}`,
          ).toBe(false);
          for (const d of doors) expect(Math.hypot(d[0] - p.at[0], d[1] - p.at[1]), p.id).toBeGreaterThan(1.2);
        }
      }
  });

  it("is the same town from the same places, whatever order they come in", () => {
    const again = layWorld([...big()].reverse());
    expect(JSON.stringify(again.town)).toBe(JSON.stringify(town));
  });
});

describe("going in and out", () => {
  const world = layWorld(big());

  it("can go from the town to every place, and every door has its match on the other side", () => {
    const everywhere = reach(world, TOWN);
    for (const p of big()) expect(everywhere.has(p.id), p.id).toBe(true);
    for (const f of world.floors) expect(everywhere.has(f.id), f.id).toBe(true);
    expect(everywhere.has(LOBBY)).toBe(true);
    const doors = allDoors(world);
    for (const [from, links] of doors)
      for (const l of links)
        expect(
          (doors.get(l.to) ?? []).some((back) => back.to === from),
          `${from} -> ${l.to}`,
        ).toBe(true);
  });

  it("brings you out of a building on to its street, which its door says", () => {
    const house = world.town.buildings.find((b) => b.id === "home:planner") as Building;
    expect(world.doors.get("home:planner")).toEqual({ to: TOWN, label: house.street, kind: "town" });
    expect(world.doors.get(LOBBY)?.label).toBe("The square");
    // The town's door into each building says whose or what it is, and a home's light is its owner's.
    const into = doorsIn(TOWN, townPlace(world.town), world);
    expect(into.find((d) => d.to === "home:planner")).toMatchObject({
      kind: "home",
      label: "planner",
      occupant: "planner",
    });
    expect(into.find((d) => d.to === LOBBY)).toMatchObject({ kind: "lobby", label: "Town hall" });
    expect(into.find((d) => d.to === OFFICE)).toMatchObject({ kind: "office", label: "Office" });
    // Out in the open, each door stands on the front of its building and faces the way out of it.
    const door = into.find((d) => d.to === "home:planner");
    expect(door?.at).toEqual(doorOfBuilding(house).at);
    expect(door?.facing).toBe(house.facing);
  });

  it("puts the plain meeting rooms on the office's floors, a floor's worth at a time, cut by letter", () => {
    expect(world.floors.map((f) => f.id)).toEqual([OFFICE, `${OFFICE}:2`]);
    expect(world.floors.map((f) => f.name)).toEqual(["the office", "the office, 2nd floor"]);
    for (const f of world.floors) expect(f.rooms.length).toBeLessThanOrEqual(FLOOR_DOORS);
    expect(world.floors.flatMap((f) => f.rooms.map((r) => r.to)).sort()).toEqual(
      ROOMS.map((r) => `room:local:${r}`).sort(),
    );
    // The first floor's way in is the street the office is on; the next is up the stairs and back down them.
    expect(world.floors[0].entrance).toMatchObject({ to: TOWN, label: "The Avenue" });
    expect(world.floors[0].up?.to).toBe(`${OFFICE}:2`);
    expect(world.floors[1].entrance.to).toBe(OFFICE);
    expect(world.doors.get(`room:local:${ROOMS[0]}`)?.to).toBe(OFFICE);
  });

  it("leaves the office out when every meeting room has a building of its own", () => {
    const world2 = layWorld([home("planner"), room("trip", "beach")]);
    expect(world2.floors).toEqual([]);
    expect(world2.town.buildings.some((b) => b.id === OFFICE)).toBe(false);
  });

  it("lays each floor out as a sound room, its doors clear of each other and of everything on it", () => {
    for (const f of world.floors) {
      const place = floorPlace(f);
      expect(placeProblems(place), f.id).toEqual([]);
      expect(unreachable(place), f.id).toEqual([]);
      expect(place.width).toBeLessThanOrEqual(LIMITS.width[1]);
      expect(place.depth).toBeLessThanOrEqual(LIMITS.depth[1]);
      const doors = doorsIn(f.id, place, world);
      expect(doors.length).toBe(f.rooms.length + 1 + (f.up ? 1 : 0));
      expect(doorProblems(place, doors), f.id).toEqual([]);
      // By the way in, a directory that opens the map, where every room is listed.
      expect(place.props.find((p) => p.label === "Directory")?.action, f.id).toBe("map");
    }
    // Round the walls first, then along the open right side.
    const full = floorLayout(FLOOR_DOORS);
    expect(full.rooms.map((d) => d.wall)).toEqual([
      ...Array(6).fill("back"),
      ...Array(4).fill("left"),
      ...Array(4).fill("right"),
    ]);
  });
});

describe("areas of their own", () => {
  it("puts an area's places on a plot at the edge of town, at the end of the avenue, a walk from the square", () => {
    const world = layWorld([...big(), home("guest", "the summer house"), shared("shed", "the summer house")]);
    const plot = world.town.plots.find((p) => p.name === "the summer house");
    expect(plot).toBeDefined();
    expect(world.areas.map((a) => [a.id, a.name])).toEqual([
      [MAIN, "the town"],
      ["summer-house", "the summer house"],
    ]);
    const guest = world.town.buildings.find((b) => b.id === "home:guest") as Building;
    const shed = world.town.buildings.find((b) => b.id === "shared:shed") as Building;
    for (const b of [guest, shed]) {
      expect(b.street).toBe("Summer house");
      expect(Math.abs(b.at[0] - (plot?.at[0] ?? 0))).toBeLessThan((plot?.size[0] ?? 0) / 2);
      expect(world.doors.get(b.id)?.to).toBe(TOWN);
    }
    // Out past every lane.
    const lanes = world.town.buildings.filter((b) => b.kind === "house" && b.id !== "home:guest");
    expect(Math.abs(guest.at[0])).toBeGreaterThan(Math.max(...lanes.map((b) => Math.abs(b.at[0]))));
    const reached = walkable(world.town, [outside(guest), outside(shed)]);
    expect(reached).toEqual([true, true]);
    expect(world.areaOf.get("home:guest")).toBe("summer-house");
  });

  it("keeps every place on a plot inside its fence and clear of the others, however many there are", () => {
    for (const n of [1, 5, 6, 11, 12, 17]) {
      const sheds = Array.from({ length: n }, (_, i) => shared(`shed-${String(i).padStart(2, "0")}`, "the allotment"));
      const t = layWorld([...big(), ...sheds]).town;
      const plot = t.plots.find((p) => p.name === "the allotment");
      const on = t.buildings.filter((b) => b.street === "Allotment");
      expect(on, `${n}`).toHaveLength(n);
      for (const b of on) {
        expect(Math.abs(b.at[0] - (plot?.at[0] ?? 0)) + b.size[0] / 2, `${n}: ${b.id}`).toBeLessThan(
          (plot?.size[0] ?? 0) / 2,
        );
        expect(Math.abs(b.at[1] - (plot?.at[1] ?? 0)) + b.size[1] / 2, `${n}: ${b.id}`).toBeLessThan(
          (plot?.size[1] ?? 0) / 2,
        );
        for (const o of t.buildings) if (o !== b) expect(overlaps(b, o, 1), `${n}: ${b.id} / ${o.id}`).toBe(false);
      }
      expect(walkable(t, on.map(outside)).every(Boolean), `${n}`).toBe(true);
    }
  });

  it("keeps each plot at its own end of the avenue when another is added, whatever it is called", () => {
    const names = ["the allotment", "the boathouse", "the cabin", "the dacha", "the estate", "the folly"];
    const ends = (areas: string[]) =>
      new Map(
        layWorld([...big(), ...areas.map((a) => shared(`in-${a.replace(/\s+/g, "-")}`, a))]).town.plots.map((p) => [
          p.name,
          Math.sign(p.at[0]),
        ]),
      );
    const before = ends(names.slice(1));
    // One that comes first by name.
    const after = ends(names);
    for (const [name, end] of before) expect(after.get(name), name).toBe(end);
    // Plots go to both ends, not all to one.
    expect(new Set(after.values()).size).toBe(2);
  });

  it("keeps rooms agents talk in in town, whatever they say", () => {
    const world = layWorld([{ ...room("trip"), area: "the beach" }, room("standup")]);
    expect(world.areaOf.get("room:local:trip")).toBe(MAIN);
  });

  it("reads any way of saying the town, or the main building it used to be, as the town", () => {
    for (const words of [undefined, "", "main", "the main building", "Main Building", "lobby", "the town", "town"])
      expect(areaId(words), String(words)).toBe(MAIN);
    expect(areaId("the summer house")).toBe("summer-house");
  });
});

describe("the town as a place to stand in", () => {
  const world = layWorld(big());
  const place = townPlace(world.town);

  it("has the kiosks, the task board, the big screen and the calendar on the square, as the lobby has", () => {
    const by = (id: string) => place.props.find((p) => p.id === id);
    expect(["kiosk-agent", "kiosk-task", "kiosk-room"].map((id) => by(id)?.action)).toEqual([
      "new-agent",
      "new-task",
      "new-room",
    ]);
    expect(by("board")).toMatchObject({ kind: "board", action: "tasks" });
    expect(by("screen")?.kind).toBe("screen");
    expect(by("calendar")?.kind).toBe("calendar");
    // On the front of the town hall, facing the square.
    const hall = world.town.buildings.find((b) => b.id === LOBBY) as Building;
    for (const id of ["board", "screen", "calendar"])
      expect(Math.abs((by(id)?.at[1] ?? 0) - (hall.at[1] + hall.size[1] / 2))).toBeLessThan(0.1);
  });

  it("is the size of the town, with everything in it inside it, and starts you on the square", () => {
    expect([place.width, place.depth]).toEqual([world.town.width, world.town.depth]);
    for (const p of place.props) {
      expect(Math.abs(p.at[0]), p.id).toBeLessThan(place.width / 2);
      expect(Math.abs(p.at[1]), p.id).toBeLessThan(place.depth / 2);
    }
    const start = place.spots.find((s) => s.id === place.start);
    expect(Math.hypot(...(start?.at ?? [99, 99]))).toBeLessThan(world.town.square.radius);
    expect(place.town).toBe(world.town);
  });

  it("keeps the square's things clear of the buildings and of every door", () => {
    const doors = world.town.buildings.map(outside);
    for (const p of place.props.filter((x) => KINDS[x.kind]?.mount === "floor")) {
      expect(
        world.town.buildings.some((b) => inBuilding(b, p.at, 0.2)),
        p.id,
      ).toBe(false);
      for (const d of doors) expect(Math.hypot(d[0] - p.at[0], d[1] - p.at[1]), p.id).toBeGreaterThan(1.2);
    }
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

  it("gives the lobby its door out to the square at its open front, clear of the kiosks and the board", () => {
    const world = layWorld(big());
    const doors = doorsIn(LOBBY, lobby(), world);
    expect(doors.map((d) => [d.wall, d.along, d.to, d.label])).toEqual([["front", 0, TOWN, "The square"]]);
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

  it("gives a place alone on its plot a door out to it, and a room the town doesn't know none", () => {
    const world = layWorld([home("planner", "the attic")]);
    expect(doorsIn("home:planner", homePlace("home:planner", "planner's room"), world).map((d) => d.to)).toEqual([
      TOWN,
    ]);
    expect(doorsIn("shared:nowhere", sharedPlace("shared:nowhere", "nowhere"), world)).toEqual([]);
  });

  it("keeps a doorway as wide as a door and as deep as a step in", () => {
    expect(DOORWAY.width).toBeGreaterThanOrEqual(1.4);
    expect(DOORWAY.depth).toBeGreaterThanOrEqual(0.8);
  });
});
