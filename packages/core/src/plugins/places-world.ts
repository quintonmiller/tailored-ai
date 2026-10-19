/**
 * The world as a building: which area each place is in, the halls that join
 * an area's places, and the doors between them.
 *
 * Most places are in the main building. The lobby is its hub, and off it run
 * three wings: the residences (a door per agent's home), the meeting rooms (a
 * door per room agents talk in), and the shared places. A wing with one place
 * opens straight off the lobby; more, and they are behind a hall, a door per
 * place, up to `HALL_DOORS` in a hall. A wing with more than a hall's worth
 * has several halls, each covering a run of the alphabet ("Residences A–F"),
 * and a foyer in front of them with a door to each, so every place is three
 * doors from the lobby at most. Halls are cut at a change of first letter
 * where they can be, so adding someone only changes the hall they join.
 *
 * A home or a shared place can say it is somewhere else (`area`, set with the
 * `place` tool): "the summer house". The places of such an area are joined to
 * each other, not to the main building: two by a door from one to the other,
 * more by a hall of their own. Between areas, there is the map.
 *
 * Every door has its match on the other side, and every place can be walked to
 * from its area's way in. Pure: the same places always give the same building.
 */
import {
  type DoorSlot,
  doorOf,
  KINDS,
  type Place,
  type PlaceItem,
  type PlaceSpot,
  withSpots,
} from "./places-layout.js";
import { LOBBY, LOBBY_DOORS } from "./places-rooms.js";

/** The main building's area id. */
export const MAIN = "main";
/** What the main building is called. */
export const MAIN_NAME = "the main building";
/** The most doors a hall has for places, before the next hall takes over. */
export const HALL_DOORS = 14;

/** A place the building has a door for: an agent's home, a shared place, or a room agents talk in. */
export interface WorldPlace {
  id: string;
  name: string;
  kind: "home" | "shared" | "room";
  /** The agent whose home it is. */
  owner?: string;
  /** The area its record says it is in, in the words it was given; the main building when absent. */
  area?: string;
}

/** What is through a door. */
export type DoorKind = "lobby" | "hall" | "home" | "shared" | "room";

/** Where a door leads, and what its name plate says. */
export interface Link {
  to: string;
  label: string;
  kind: DoorKind;
  /** The agent whose home it opens on: its light shows what that agent is doing. */
  occupant?: string;
}

/**
 * A hall: the door you come in by, a door for each place, and in the rare
 * foyer with more halls than doors, the door on to the next foyer. A foyer is
 * a hall whose doors lead to halls.
 */
export interface Hall {
  id: string;
  name: string;
  area: string;
  entrance?: Link;
  onward?: Link;
  rooms: Link[];
}

/** An area: its places, by id, its way in first. */
export interface Area {
  id: string;
  name: string;
  places: string[];
}

export interface World {
  /** The main building first, then the others by name. */
  areas: Area[];
  halls: Hall[];
  /** The lobby's doors, one for each of `LOBBY_DOORS`; undefined where that wing is empty. */
  lobby: (Link | undefined)[];
  /** The one door of each place that isn't a hall or the lobby; none for a place alone in its area. */
  doors: Map<string, Link>;
  /** Which area each place is in, by place id. */
  areaOf: Map<string, string>;
}

/** A door in a room: where it is, and where it goes. */
export interface PlaceDoor extends DoorSlot, Link {}

const slug = (words: string) =>
  words
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** The area id words name: the main building for none, or for any way of saying it. */
export function areaId(words: string | undefined): string {
  const id = words ? slug(words) : "";
  return !id || ["main", "main-building", "building", "lobby", "none", "home"].includes(id) ? MAIN : id;
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

/** The letter a place files under in a hall: its plate's first letter, or `#`. */
const letterOf = (label: string) => {
  const c = label.replace(/^#/, "").charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
};

/**
 * Places, in order, cut into halls of at most `cap`: each hall takes whole runs
 * of a first letter while they fit, so one more name changes only the hall it
 * falls in, unless that hall was full. A letter with more than a hall's worth
 * fills up the hall it starts in and then takes whole halls of its own.
 */
export function packHalls<T>(items: T[], letter: (item: T) => string, cap = HALL_DOORS): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last && letter(last[0]) === letter(item)) last.push(item);
    else runs.push([item]);
  }
  const halls: T[][] = [];
  let current: T[] = [];
  for (const run of runs) {
    if (run.length <= cap) {
      if (current.length + run.length > cap) {
        halls.push(current);
        current = [];
      }
      current.push(...run);
      continue;
    }
    // Topping up what is being filled; a full one goes as it is.
    const top = current.length ? cap - current.length : 0;
    if (current.length) halls.push([...current, ...run.slice(0, top)]);
    current = [];
    for (let i = top; i < run.length; i += cap) {
      const part = run.slice(i, i + cap);
      if (part.length === cap) halls.push(part);
      else current = part;
    }
  }
  if (current.length) halls.push(current);
  return halls;
}

/** "A–F" for a hall of names from A to F; "S" when they all start with S. */
function letters(rooms: Link[]): string {
  const first = letterOf(rooms[0]?.label ?? "");
  const last = letterOf(rooms.at(-1)?.label ?? "");
  return first === last ? first : `${first}–${last}`;
}

/** Order places the way a hall's doors read: by what their plates say. */
const byPlate = (a: Link, b: Link) =>
  a.label.replace(/^#/, "").localeCompare(b.label.replace(/^#/, ""), "en", { sensitivity: "base" }) ||
  a.to.localeCompare(b.to);

/** The whole building, from the places there are. */
export function layWorld(places: WorldPlace[]): World {
  const halls: Hall[] = [];
  const doors = new Map<string, Link>();
  const areaOf = new Map<string, string>([[LOBBY, MAIN]]);
  const byArea = new Map<string, { name: string; places: WorldPlace[] }>();
  // Rooms agents talk in have no record to say otherwise: they are always in the main building.
  for (const p of [...places].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = p.kind === "room" ? MAIN : areaId(p.area);
    const area = byArea.get(id) ?? { name: id === MAIN ? MAIN_NAME : (p.area as string).trim(), places: [] };
    area.places.push(p);
    byArea.set(id, area);
    areaOf.set(p.id, id);
  }
  const hallLink = (h: Hall): Link => ({ to: h.id, label: plate(h.name), kind: "hall" });

  /** Halls in a row, each with a door on to the next and back to the one before; the first comes in from `from`. */
  const chain = (row: Hall[], from: Link | undefined) => {
    for (const [i, h] of row.entries()) {
      const before = row[i - 1];
      const after = row[i + 1];
      if (before) h.entrance = hallLink(before);
      else if (from) h.entrance = from;
      if (after) h.onward = hallLink(after);
    }
  };
  const keep = (h: Hall) => {
    areaOf.set(h.id, h.area);
    halls.push(h);
  };

  /**
   * A run of places behind halls, the way in coming from `from`. A hall's
   * worth is one hall. More, and the places are cut into halls by letter, with
   * a foyer in front that has a door to each hall, so none is further than
   * foyer, hall, door. Each place's door leads back to its hall. Returns the
   * link to the way in.
   */
  const corridor = (area: string, key: string, title: string, links: Link[], from: Link | undefined): Link => {
    const groups = packHalls(links, (l) => letterOf(l.label));
    const made = groups.map(
      (rooms, i): Hall => ({
        id: key ? `hall:${area}:${key}-${i + 1}` : `hall:${area}:${i + 1}`,
        name: groups.length > 1 ? `${title} ${letters(rooms)}` : title,
        area,
        rooms,
      }),
    );
    // Halls covering the same letters (one letter too big for a hall) are told apart by number.
    const names = made.map((h) => h.name);
    for (const [i, h] of made.entries()) {
      const same = names.filter((n) => n === names[i]);
      if (same.length > 1) h.name = `${names[i]} ${names.slice(0, i + 1).filter((n) => n === names[i]).length}`;
    }
    for (const h of made) for (const room of h.rooms) doors.set(room.to, hallLink(h));
    if (made.length === 1) {
      chain(made, from);
      keep(made[0]);
      return hallLink(made[0]);
    }
    // The foyer: a door to each hall. Past a foyer's worth of halls, the next foyer carries on from its far end.
    const foyerId = key ? `hall:${area}:${key}-foyer` : `hall:${area}:foyer`;
    const foyers = packHalls(made.map(hallLink), () => "").map(
      (rooms, i): Hall => ({
        id: i ? `${foyerId}-${i + 1}` : foyerId,
        name: i ? `${title} ${i + 1}` : title,
        area,
        rooms,
      }),
    );
    chain(foyers, from);
    for (const f of foyers) {
      keep(f);
      for (const room of f.rooms) {
        const hall = made.find((h) => h.id === room.to) as Hall;
        hall.entrance = hallLink(f);
      }
    }
    for (const h of made) keep(h);
    return hallLink(foyers[0]);
  };

  // The main building: the lobby, and a wing off it for each kind of place.
  const lobbyLink: Link = { to: LOBBY, label: "Lobby", kind: "lobby" };
  const main = byArea.get(MAIN)?.places ?? [];
  const wings: [string, string, WorldPlace["kind"]][] = [
    ["homes", "Residences", "home"],
    ["rooms", "Meeting rooms", "room"],
    ["shared", "Shared places", "shared"],
  ];
  const lobby = wings.map(([key, title, kind]) => {
    const links = main
      .filter((p) => p.kind === kind)
      .map(linkTo)
      .sort(byPlate);
    if (!links.length) return undefined;
    // One place opens straight off the lobby: a hall with a single door would be a corridor to nowhere.
    if (links.length === 1) {
      doors.set(links[0].to, lobbyLink);
      return links[0];
    }
    return corridor(MAIN, key, title, links, lobbyLink);
  });

  // The other areas: two places door to door, more round a hall of their own.
  const areas: Area[] = [];
  for (const [id, area] of byArea) {
    if (id === MAIN) continue;
    const links = area.places.map(linkTo).sort(byPlate);
    if (links.length === 2) {
      doors.set(links[0].to, links[1]);
      doors.set(links[1].to, links[0]);
    } else if (links.length > 2) {
      corridor(id, "", `${plate(area.name)} hall`, links, undefined);
    }
    const own = halls.filter((h) => h.area === id).map((h) => h.id);
    areas.push({ id, name: area.name, places: [...own, ...links.map((l) => l.to)] });
  }
  areas.sort((a, b) => a.name.localeCompare(b.name));
  const mainHalls = halls.filter((h) => h.area === MAIN).map((h) => h.id);
  areas.unshift({ id: MAIN, name: MAIN_NAME, places: [LOBBY, ...mainHalls, ...main.map((p) => p.id)] });
  return { areas, halls, lobby, doors, areaOf };
}

// --------------------------------------------------------------------------
// Halls
// --------------------------------------------------------------------------

/** How deep a hall is: a doorway's depth at the back and at the front, and benches and plants down the middle. */
const HALL_DEPTH = 5.5;
/** How far apart the doors along a hall are, middle to middle. */
const PITCH = 1.9;
/** Floor kept clear at each end of a hall, for its entrance and the door on to the next. */
const HALL_END = 1.3;

/** Where a hall's doors are: its entrance at the left wall, the door on at the open right end, the rest along the back wall and the front edge, in pairs. */
export function hallLayout(rooms: number): {
  width: number;
  depth: number;
  /** How many pairs of doors face each other across it. */
  pairs: number;
  /** Where its doors start, from the left end: they sit in the middle of a short hall. */
  end: number;
  entrance: DoorSlot;
  onward: DoorSlot;
  rooms: DoorSlot[];
} {
  const pairs = Math.max(2, Math.ceil(rooms / 2));
  const width = Math.min(16, Math.max(8, Math.round((2 * HALL_END + pairs * PITCH) * 10) / 10));
  const end = (width - pairs * PITCH) / 2;
  const x = (k: number) => round(-width / 2 + end + PITCH * (k + 0.5));
  return {
    width,
    depth: HALL_DEPTH,
    pairs,
    end,
    entrance: { wall: "left", along: 0 },
    onward: { wall: "right", along: 0 },
    // Read left to right: the first at the back, the second facing it at the front, and so on.
    rooms: Array.from({ length: rooms }, (_, i) => ({ wall: i % 2 ? "front" : "back", along: x(Math.floor(i / 2)) })),
  };
}

/** What a hall's floor and walls are, by area: the main building's halls alike, another area's its own. */
const HALL_LOOKS = [
  { walls: "#e8e2d6", floorColor: "#8a6a4f", runner: "#7a3f3f" },
  { walls: "#dfe6e2", floorColor: "#9a8a72", runner: "#3f5f7a" },
  { walls: "#ece0cf", floorColor: "#7a5a40", runner: "#4f6d4a" },
  { walls: "#e4dde8", floorColor: "#8d7f72", runner: "#6a4f7a" },
];

/**
 * A hall as a room to walk down: a long runner, benches back to back and
 * plants down the middle between the doors, lamps for the evening, tall plants
 * in the back corners, and a sign with its name by the entrance.
 */
export function hallPlace(hall: Hall): Place {
  const { width, depth, pairs, end } = hallLayout(hall.rooms.length);
  const look = HALL_LOOKS[hall.area === MAIN ? 0 : 1 + ([...hall.area].reduce((n, c) => n + c.charCodeAt(0), 0) % 3)];
  const props: PlaceItem[] = [];
  const add = (item: Omit<PlaceItem, "name"> & { name?: string }) =>
    props.push({ name: `the ${KINDS[item.kind].noun}`, ...item } as PlaceItem);
  // The runner, end to end in pieces, under everything in the middle.
  const runs = Math.max(1, Math.round((width - 2 * end) / 3.6));
  const runLength = (width - 2 * end) / runs;
  for (let i = 0; i < runs; i++)
    add({
      id: `runner-${i + 1}`,
      name: runs > 1 ? `the runner ${i + 1}` : "the runner",
      kind: "rug",
      at: [round(-width / 2 + end + runLength * (i + 0.5)), 0],
      facing: 0,
      scale: round(Math.min(2, runLength / 2)),
      color: look.runner,
    });
  // Down the middle, between the pairs of doors: benches, then a lamp among plants, in turn.
  for (let k = 0; k < pairs - 1; k++) {
    const x = round(-width / 2 + end + PITCH * (k + 1));
    if (k % 2 === 0) {
      add({ id: `bench-${k + 1}a`, name: `the bench ${k + 1}`, kind: "bench", at: [x, -0.3], facing: 180 });
      add({ id: `bench-${k + 1}b`, name: `the facing bench ${k + 1}`, kind: "bench", at: [x, 0.3], facing: 0 });
    } else {
      add({ id: `lamp-${k + 1}`, name: `the lamp ${k + 1}`, kind: "lamp", at: [x, 0], facing: 0 });
      add({ id: `plant-${k + 1}a`, name: `the plant ${k + 1}`, kind: "plant", at: [round(x - 0.5), 0], facing: 0 });
      add({
        id: `plant-${k + 1}b`,
        name: `the other plant ${k + 1}`,
        kind: "plant",
        at: [round(x + 0.5), 0],
        facing: 0,
      });
    }
  }
  // Light at both ends, where the middle has none.
  add({
    id: "lamp-in",
    name: "the lamp by the entrance",
    kind: "lamp",
    at: [round(-width / 2 + 0.4), round(depth / 2 - 0.4)],
    facing: 0,
  });
  add({
    id: "lamp-out",
    name: "the lamp at the far end",
    kind: "lamp",
    at: [round(width / 2 - 0.4), round(-depth / 2 + 0.4)],
    facing: 0,
  });
  add({
    id: "corner-plant",
    name: "the corner plant",
    kind: "plant",
    at: [round(width / 2 - 0.4), round(depth / 2 - 0.4)],
    facing: 0,
  });
  // Along the back wall, clear of the sign on the left one.
  add({ id: "tall-plant", kind: "tall_plant", at: [round(-width / 2 + 0.9), round(-depth / 2 + 0.35)], facing: 0 });
  add({
    id: "sign",
    name: "the sign",
    kind: "sign",
    at: [round(-width / 2 + 0.01), -1.6],
    facing: 90,
    elevation: 1.55,
    label: plate(hall.name).slice(0, 40),
  });
  const start: PlaceSpot = {
    id: "middle",
    name: "inside the entrance",
    place: "the entrance",
    at: [round(-width / 2 + 1.6), 0],
    facing: 90,
  };
  return withSpots({
    name: hall.name,
    width,
    depth,
    height: 3,
    walls: look.walls,
    floor: "wood",
    floorColor: look.floorColor,
    props,
    spots: [start],
    start: start.id,
  });
}

const round = (n: number) => Math.round(n * 100) / 100;

// --------------------------------------------------------------------------
// The doors of a place
// --------------------------------------------------------------------------

/**
 * The doors in a place, where they are and where each goes: the lobby's at its
 * doorways, a hall's along it, and any other place's one door wherever its
 * room keeps a doorway clear (`doorOf`). Empty for a place the building has no
 * door for, or a room so full there is nowhere for one.
 */
export function doorsIn(id: string, place: Place, world: World): PlaceDoor[] {
  if (id === LOBBY)
    return LOBBY_DOORS.flatMap((slot, i) => {
      const link = world.lobby[i];
      return link ? [{ ...slot, ...link }] : [];
    });
  const hall = world.halls.find((h) => h.id === id);
  if (hall) {
    const layout = hallLayout(hall.rooms.length);
    return [
      ...(hall.entrance ? [{ ...layout.entrance, ...hall.entrance }] : []),
      ...hall.rooms.map((link, i) => ({ ...layout.rooms[i], ...link })),
      ...(hall.onward ? [{ ...layout.onward, ...hall.onward }] : []),
    ];
  }
  const link = world.doors.get(id);
  const slot = link ? doorOf(place) : undefined;
  return link && slot ? [{ ...slot, ...link }] : [];
}
