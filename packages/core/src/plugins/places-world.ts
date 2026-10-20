/**
 * The world as a town: which area each place is in, where in the town its
 * building is, the floors of the office the meeting rooms are on, and the
 * doors between them.
 *
 * You walk round the town outdoors (see `places-town.ts`). Every home and
 * shared place is a building in it with its door on the street, and so is
 * the town hall, whose lobby has the kiosks, and the office. The rooms agents
 * talk in are behind doors round the office's floors, `FLOOR_DOORS` to a
 * floor, cut by first letter so a new room changes only the floor it joins;
 * a themed room has a building of its own instead, on main street (a tavern,
 * a studio, a workshop, a library) or a hut on the beach.
 *
 * A home or a shared place can say it is somewhere else (`area`, set with the
 * `place` tool): "the summer house". The places of such an area are on a plot
 * of their own at the edge of town, at the end of the avenue, so they are a
 * walk away rather than a map away.
 *
 * Every door has its match on the other side, and every place can be walked
 * to from the square. Agents and people can put in doors of their own between
 * places (`places-doors.ts`): those whose way back is there too are in each
 * place beside the town's. Pure: the same places always give the same town.
 */
import { matchLinks } from "./places-doors.js";
import { type DoorSlot, doorOf, type Place, type PlaceLink } from "./places-layout.js";
import { LOBBY, LOBBY_DOORS, officeFloor } from "./places-rooms.js";
import { type BuildingKind, layTown, letterOf, packLanes, TOWN, type Town, townDoors } from "./places-town.js";

/** The town's area id: every place is in it, apart from those on a plot of their own. */
export const MAIN = "main";
/** What the town is called. */
export const MAIN_NAME = "the town";
/** The office's first floor, where you come in from the street. */
export const OFFICE = "office";
/** The most meeting rooms on one floor of the office before the next floor takes over. */
export const FLOOR_DOORS = 14;

/** A place the town has a door for: an agent's home, a shared place, or a room agents talk in. */
export interface WorldPlace {
  id: string;
  name: string;
  kind: "home" | "shared" | "room";
  /** The agent whose home it is. */
  owner?: string;
  /** The area its record says it is in, in the words it was given; the town when absent. */
  area?: string;
  /** A meeting room's look (`THEMES` in `places-rooms.ts`): some looks have a building of their own. */
  theme?: string;
}

/** What is through a door. */
export type DoorKind = "town" | "lobby" | "office" | "home" | "shared" | "room";

/** Where a door leads, and what its name plate says. */
export interface Link {
  to: string;
  label: string;
  kind: DoorKind;
  /** The agent whose home it opens on: its light shows what that agent is doing. */
  occupant?: string;
}

/** A floor of the office: the way in, from the street or the floor below, a door for each room, and the stairs on. */
export interface Floor {
  id: string;
  name: string;
  /** 1 for the floor you come in on from the street. */
  level: number;
  entrance: Link;
  up?: Link;
  rooms: Link[];
}

/** An area: its places, by id, its way in first. */
export interface Area {
  id: string;
  name: string;
  places: string[];
}

export interface World {
  /** The town first, then the plots by name. */
  areas: Area[];
  town: Town;
  floors: Floor[];
  /** The one door of each place that isn't the town or a floor of the office: out to the street, or to its floor. */
  doors: Map<string, Link>;
  /** Which area each place is in, by place id. */
  areaOf: Map<string, string>;
  /** What a door into each place says: where it goes, and its plate. Every place a door can be put in to lead to. */
  into: Map<string, Link>;
  /** The doors agents and people put in, by the place each is in: only those whose way back is there too. */
  made: Map<string, PlaceLink[]>;
}

/** A door in a room: where it is, and where it goes. */
export interface PlaceDoor extends DoorSlot, Link {
  /** Who put it in, for a door someone put in rather than one the town has. */
  by?: string;
}

const slug = (words: string) =>
  words
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** The area id words name: the town for none, or for any way of saying it or the main building it used to be. */
export function areaId(words: string | undefined): string {
  const id = words ? slug(words) : "";
  return !id ||
    ["main", "main-building", "building", "lobby", "none", "home", "town", "the-town", "square"].includes(id)
    ? MAIN
    : id;
}

/** Words for a name plate: without "the", starting with a capital. */
function plate(name: string): string {
  const bare = name.replace(/^(the|a|an)\s+/i, "").trim() || name;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function linkTo(p: WorldPlace): Link {
  if (p.kind === "home") {
    const owner = p.owner ?? p.id.replace(/^home:/, "");
    return { to: p.id, label: owner === "default" ? "Default agent" : owner, kind: "home", occupant: owner };
  }
  return { to: p.id, label: p.kind === "room" ? `#${p.name}` : plate(p.name), kind: p.kind };
}

/** The building a themed meeting room has of its own on main street; a beach room is a hut on the sand instead. */
const STREET_THEMES: Record<string, BuildingKind> = {
  tavern: "tavern",
  studio: "studio",
  workshop: "workshop",
  library: "library",
};

/** Order places the way doors and lanes read: by what their plates say. */
const byPlate = (a: Pick<Link, "label" | "to">, b: Pick<Link, "label" | "to">) =>
  a.label.replace(/^#/, "").localeCompare(b.label.replace(/^#/, ""), "en", { sensitivity: "base" }) ||
  a.to.localeCompare(b.to);

/** The office floor's id at a level. */
const floorId = (level: number) => (level === 1 ? OFFICE : `${OFFICE}:${level}`);
/** What a floor is called: "the office", then "the office, 2nd floor". */
function floorName(level: number): string {
  if (level === 1) return "the office";
  const th = level % 10 === 2 && level % 100 !== 12 ? "nd" : level % 10 === 3 && level % 100 !== 13 ? "rd" : "th";
  return `the office, ${level}${th} floor`;
}

/** Towns laid out lately, by what was in them: every map and every scene asks, and laying one out takes a while. */
const laid = new Map<string, World>();

/**
 * The whole town, from the places there are, and the doors agents and people
 * put in (`links`, by the place each is in). The same places give the same
 * town, which is kept and handed out again; the doors put in are matched
 * afresh, so one put in or taken out never lays the town out again.
 */
export function layWorld(places: WorldPlace[], links?: Map<string, PlaceLink[]>): World {
  const key = JSON.stringify([...places].sort((a, b) => a.id.localeCompare(b.id)));
  let world = laid.get(key);
  if (!world) {
    if (laid.size >= 8) laid.clear();
    world = lay(places);
    laid.set(key, world);
  }
  if (!links?.size) return world;
  const into = world.into;
  return { ...world, made: matchLinks(links, (id) => into.has(id)) };
}

function lay(places: WorldPlace[]): World {
  const doors = new Map<string, Link>();
  const areaOf = new Map<string, string>([
    [TOWN, MAIN],
    [LOBBY, MAIN],
  ]);
  const byArea = new Map<string, { name: string; places: WorldPlace[] }>();
  // Rooms agents talk in have no record to say otherwise: they are always in town.
  for (const p of [...places].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = p.kind === "room" ? MAIN : areaId(p.area);
    const area = byArea.get(id) ?? { name: id === MAIN ? MAIN_NAME : (p.area as string).trim(), places: [] };
    area.places.push(p);
    byArea.set(id, area);
    areaOf.set(p.id, id);
  }
  const main = byArea.get(MAIN)?.places ?? [];
  const homes = main
    .filter((p) => p.kind === "home")
    .map(linkTo)
    .sort(byPlate);
  const rooms = main.filter((p) => p.kind === "room");
  const themed = (p: WorldPlace) => (p.theme ? STREET_THEMES[p.theme] : undefined);
  const street = [
    ...rooms.filter(themed).map((p) => ({ ...linkTo(p), kind: themed(p) as BuildingKind })),
    ...main
      .filter((p) => p.kind === "shared")
      .map(linkTo)
      .map((l) => ({ ...l, kind: "shop" as BuildingKind })),
  ].sort(byPlate);
  const huts = rooms
    .filter((p) => p.theme === "beach")
    .map(linkTo)
    .sort(byPlate);
  const inOffice = rooms
    .filter((p) => !themed(p) && p.theme !== "beach")
    .map(linkTo)
    .sort(byPlate);

  // The office's floors: rooms by name, a floor's worth at a time, each floor's stairs on to the next.
  const floors: Floor[] = packLanes(inOffice, (l) => letterOf(l.label), FLOOR_DOORS).map((links, i) => ({
    id: floorId(i + 1),
    name: floorName(i + 1),
    level: i + 1,
    entrance:
      i === 0
        ? { to: TOWN, label: "Out", kind: "town" }
        : { to: floorId(i), label: `Down to floor ${i}`, kind: "office" },
    rooms: links,
  }));
  for (const [i, f] of floors.entries()) {
    const next = floors[i + 1];
    if (next) f.up = { to: next.id, label: `Up to floor ${next.level}`, kind: "office" };
    areaOf.set(f.id, MAIN);
    for (const room of f.rooms) doors.set(room.to, { to: f.id, label: plate(f.name), kind: "office" });
  }

  const plots = [...byArea.entries()]
    .filter(([id]) => id !== MAIN)
    .map(([id, area]) => ({
      id,
      name: area.name,
      places: area.places
        .map(linkTo)
        .sort(byPlate)
        .map((l) => ({ id: l.to, label: l.label, ...(l.occupant ? { owner: l.occupant } : {}) })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const town = layTown(
    {
      homes: homes.map((l) => ({ id: l.to, label: l.label, ...(l.occupant ? { owner: l.occupant } : {}) })),
      street: street.map((l) => ({ id: l.to, label: l.label, kind: l.kind })),
      huts: huts.map((l) => ({ id: l.to, label: l.label })),
      office: floors.length > 0,
      plots,
    },
    { hall: LOBBY, office: OFFICE },
  );
  // Every building's door leads back out to the street in front of it, and says which street that is.
  for (const b of town.buildings) if (b.id !== OFFICE) doors.set(b.id, { to: TOWN, label: b.street, kind: "town" });
  const way = town.buildings.find((b) => b.id === OFFICE)?.street;
  if (floors[0] && way) floors[0].entrance = { ...floors[0].entrance, label: way };

  const areas: Area[] = [
    {
      id: MAIN,
      name: MAIN_NAME,
      places: [TOWN, LOBBY, ...floors.map((f) => f.id), ...main.map((p) => p.id)],
    },
    ...plots.map((p) => ({ id: p.id, name: p.name, places: p.places.map((q) => q.id) })),
  ];
  // Where a door put in can lead: the town hall, and every home, shared place and meeting room.
  const hall = town.buildings.find((b) => b.id === LOBBY);
  const into = new Map<string, Link>([[LOBBY, { to: LOBBY, label: hall?.label ?? "Town hall", kind: "lobby" }]]);
  for (const p of places) into.set(p.id, linkTo(p));
  return { areas, town, floors, doors, areaOf, into, made: new Map() };
}

/** What a building's door is to someone outside it: where it goes, and what its plate says. */
function linkInto(b: Town["buildings"][number]): Link {
  if (b.kind === "hall") return { to: b.id, label: b.label, kind: "lobby" };
  if (b.kind === "office") return { to: b.id, label: b.label, kind: "office" };
  if (b.owner) return { to: b.id, label: b.label, kind: "home", occupant: b.owner };
  if (b.kind === "shop" || b.kind === "cottage") return { to: b.id, label: b.label, kind: "shared" };
  return { to: b.id, label: b.label, kind: "room" };
}

// --------------------------------------------------------------------------
// The office's floors
// --------------------------------------------------------------------------

/** How deep a floor of the office is, and how far apart the doors round it are, middle to middle. */
const FLOOR_DEPTH = 12;
const PITCH = 1.9;
/** Wall kept clear at the back corner, and floor along the front for the way in and the stairs. */
const CORNER = 1.2;
const FRONT_CLEAR = 3;

/** Where a floor's doors are: up to seven along the back wall, then down the left wall, then standing along the right side. */
export function floorLayout(rooms: number): {
  width: number;
  depth: number;
  entrance: DoorSlot;
  up: DoorSlot;
  rooms: DoorSlot[];
} {
  const sides = Math.floor((FLOOR_DEPTH - CORNER - FRONT_CLEAR) / PITCH);
  const back = Math.min(7, Math.max(3, rooms - 2 * sides));
  const width = Math.max(12, Math.round((CORNER + back * PITCH + 1.4) * 10) / 10);
  const slots: DoorSlot[] = [];
  for (let i = 0; i < back; i++) slots.push({ wall: "back", along: round(-width / 2 + CORNER + PITCH * (i + 0.5)) });
  for (let i = 0; i < sides; i++)
    slots.push({ wall: "left", along: round(-FLOOR_DEPTH / 2 + CORNER + PITCH * (i + 0.5)) });
  for (let i = 0; i < sides; i++)
    slots.push({ wall: "right", along: round(-FLOOR_DEPTH / 2 + CORNER + PITCH * (i + 0.5)) });
  return {
    width,
    depth: FLOOR_DEPTH,
    entrance: { wall: "front", along: round(-width / 2 + 2.2) },
    up: { wall: "front", along: round(width / 2 - 2.2) },
    rooms: slots.slice(0, rooms),
  };
}

/** A floor of the office as a room to stand in. */
export function floorPlace(floor: Floor): Place {
  const layout = floorLayout(floor.rooms.length);
  return officeFloor(floor.name, layout.width, layout.depth, layout.rooms);
}

const round = (n: number) => Math.round(n * 100) / 100;

// --------------------------------------------------------------------------
// The doors of a place
// --------------------------------------------------------------------------

/**
 * The doors in a place, where they are and where each goes: the town's on
 * the front of each building, the lobby's at its open front, a floor of the
 * office's round its walls, and any other place's one door wherever its room
 * keeps a doorway clear (`doorOf`); then the doors agents and people put in,
 * where they put them, while their way back is there. Empty for a place the
 * town has no door for, or a room so full there is nowhere for one.
 */
export function doorsIn(id: string, place: Place, world: World): PlaceDoor[] {
  return [...townsDoorsIn(id, place, world), ...madeDoorsIn(id, place, world)];
}

/**
 * The doors put in a place that are there: where its record says each is
 * (it may have moved one since the world was read), for those the world
 * found their way back for.
 */
function madeDoorsIn(id: string, place: Place, world: World): PlaceDoor[] {
  const there = new Set((world.made.get(id) ?? []).map((l) => l.to));
  return (place.links ?? []).flatMap((l) => {
    const link = there.has(l.to) ? world.into.get(l.to) : undefined;
    return link ? [{ wall: l.wall, along: l.along, ...link, ...(l.by ? { by: l.by } : {}) }] : [];
  });
}

function townsDoorsIn(id: string, place: Place, world: World): PlaceDoor[] {
  if (id === TOWN) return townDoors(world.town).map(({ building, ...slot }) => ({ ...slot, ...linkInto(building) }));
  if (id === LOBBY) {
    const out = world.doors.get(LOBBY) ?? { to: TOWN, label: "The square", kind: "town" as const };
    return LOBBY_DOORS.map((slot) => ({ ...slot, ...out }));
  }
  const floor = world.floors.find((f) => f.id === id);
  if (floor) {
    const layout = floorLayout(floor.rooms.length);
    return [
      { ...layout.entrance, ...floor.entrance },
      ...floor.rooms.map((link, i) => ({ ...layout.rooms[i], ...link })),
      ...(floor.up ? [{ ...layout.up, ...floor.up }] : []),
    ];
  }
  const link = world.doors.get(id);
  const slot = link ? doorOf(place) : undefined;
  return link && slot ? [{ ...slot, ...link }] : [];
}
