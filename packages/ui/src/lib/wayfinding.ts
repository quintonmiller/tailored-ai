/**
 * Finding your way round the world: where you are, said from the town down
 * ("Town › Maple Lane › analyst's home"), and the map's index of who and what
 * there is to go to, people and rooms first and the office's floors last,
 * filtered by what you type. Pure, so it is tested without a page; the map and
 * the stage's tools draw what this says.
 */
import type { AgentActivity } from "../avatar/doing";
import { nameOf } from "./conversations";

/** One place on the map, as `builtin:places` lists it. */
export interface MapPlace {
  id: string;
  name: string;
  kind: "town" | "lobby" | "office" | "home" | "shared" | "room";
  agents: string[];
  /** The area it is in, by id: `main` for the town. */
  area?: string;
  owner?: string;
  /** The street its building's door is on: "Maple Lane", "Main Street", "The square". */
  street?: string;
  purpose?: string;
  /** A room of conversation's members, wherever their bodies are; `agents` are those talking in it now. */
  members?: string[];
  /** The place its way in is through: the town for a building, the floor of the office for a room on one. */
  via?: string;
  /** A home's owner, in a word ("coder", "writer"), when what it is for can be read. */
  role?: string;
  /** What a home's owner wears, by name. */
  wear?: string[];
  /** Someone chose that, rather than it being what suits its role. */
  wearChosen?: boolean;
}

/** An area: the town, or a plot of an agent's own at the edge of it. */
export interface MapArea {
  id: string;
  name: string;
  /** Its places, its way in first. */
  places: string[];
}

/** The town's area id, which a place without one is in. */
export const MAIN = "main";
/** The town's place id: the outdoors. */
export const TOWN = "town";

/** A name as a heading: "the summer house" becomes "Summer house". */
export function areaTitle(name: string): string {
  const bare = name.replace(/^(the|a|an)\s+/i, "").trim() || name;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** What a place is called where you are told where you are: "analyst's home", "#budget", "the town hall". */
export function placeTitle(p: Pick<MapPlace, "kind" | "name" | "owner" | "id">): string {
  if (p.kind === "home") {
    const who = p.owner ?? p.id.replace(/^home:/, "");
    return who === "default" ? "the default agent's home" : `${who}'s home`;
  }
  if (p.kind === "room") return `#${p.name}`;
  return p.name;
}

/** Where an area is come into: the town at its square, a plot by the first of its places. */
export function wayInto(area: MapArea): string | undefined {
  return area.id === MAIN ? TOWN : area.places[0];
}

/**
 * One step of where you are: what to call it, the place a click on it goes
 * to, and, out on to the street, the place you come out of (`from`): you
 * stand outside its door, rather than on the square.
 */
export interface Crumb {
  id: string;
  label: string;
  from?: string;
}

/**
 * Where a place is, from the town down: the town (a click goes to the
 * square), the street its building is on (a click takes you out of its door
 * on to it) or the floor of the office it is on, and the place. Empty when
 * the place isn't on the map.
 */
export function trailTo(here: string | undefined, places: MapPlace[], _areas: MapArea[] = []): Crumb[] {
  const place = here ? places.find((p) => p.id === here) : undefined;
  if (!place) return [];
  const trail: Crumb[] = [{ id: TOWN, label: "Town" }];
  if (place.id === TOWN) return trail;
  const via = place.via ? places.find((p) => p.id === place.via) : undefined;
  if (via?.kind === "office") {
    // A floor upstairs is reached from the one below; the street is the office's, whose door is on the ground floor.
    let ground: MapPlace | undefined = via;
    for (let up = 0; ground && !ground.street && up < 50; up++) {
      const below: MapPlace | undefined = places.find((p) => p.id === ground?.via);
      ground = below?.kind === "office" ? below : undefined;
    }
    if (ground?.street) trail.push({ id: TOWN, label: ground.street, from: ground.id });
    trail.push({ id: via.id, label: areaTitle(via.name) });
  } else if (place.street) trail.push({ id: TOWN, label: place.street, from: place.id });
  trail.push({ id: place.id, label: placeTitle(place) });
  return trail;
}

/** An agent on the map: its home, which a click goes to, and where its body is when that is somewhere else. */
export interface MapAgent {
  agent: string;
  home: MapPlace;
  away?: MapPlace;
  activity?: AgentActivity;
}

/** An area other than the main building, the place to go in by, and what is there. */
export interface MapAreaEntry {
  area: MapArea;
  way: string;
  places: MapPlace[];
}

/** The map, by what people look for: agents, meeting rooms, shared places, plots; the town and the office last. */
export interface MapIndex {
  agents: MapAgent[];
  rooms: MapPlace[];
  shared: MapPlace[];
  areas: MapAreaEntry[];
  /** The town outdoors, where you arrive. */
  town?: MapPlace;
  /** The town hall, with the kiosks. */
  lobby?: MapPlace;
  /** The office's floors, the meeting rooms' doors round them: a way through rather than somewhere to be. */
  floors: MapPlace[];
  /** Where Enter goes: the first thing listed. */
  first?: string;
}

const lower = (s: string) => s.toLowerCase();
/** Words as typed, to compare: in lower case, without a leading "#" or "the". */
const plain = (s: string) =>
  lower(s)
    .trim()
    .replace(/^#/, "")
    .replace(/^the\s+/, "");

/**
 * The map's index, filtered by `query` when there is one: agents by name,
 * rooms by name or purpose, shared places, plots and the office's floors by
 * name, a plot by any of its places too. Agents are in name order; rooms and shared places
 * in `rank`'s order (where something is happening first), then as the server
 * sent them. Each agent's body is where the map says it is.
 */
export function mapIndex(
  places: MapPlace[],
  areas: MapArea[],
  activities: Record<string, AgentActivity>,
  query = "",
  rank: (p: MapPlace) => number = () => 0,
): MapIndex {
  const q = plain(query);
  const has = (...words: (string | undefined)[]) => !q || words.some((w) => !!w && lower(w).includes(q));
  const areaOf = (p: MapPlace) => p.area ?? MAIN;
  const bodyAt = new Map<string, MapPlace>();
  for (const p of places) for (const a of p.agents) if (!bodyAt.has(a)) bodyAt.set(a, p);
  const agents = places
    .filter((p) => p.kind === "home")
    .map((home): MapAgent => {
      const agent = home.owner ?? home.id.replace(/^home:/, "");
      const at = bodyAt.get(agent);
      return {
        agent,
        home,
        ...(at && at.id !== home.id ? { away: at } : {}),
        ...(activities[agent] ? { activity: activities[agent] } : {}),
      };
    })
    // By name, or by what it is: "coder" finds every coder.
    .filter((a) => has(a.agent, nameOf(a.agent), a.home.role))
    .sort((a, b) => nameOf(a.agent).localeCompare(nameOf(b.agent), "en", { sensitivity: "base" }));
  const ranked = (list: MapPlace[]) =>
    list
      .map((p, i) => ({ p, i }))
      .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
      .map(({ p }) => p);
  const rooms = ranked(places.filter((p) => p.kind === "room" && has(p.name, p.purpose)));
  const shared = ranked(places.filter((p) => p.kind === "shared" && areaOf(p) === MAIN && has(p.name)));
  const others: MapAreaEntry[] = [];
  for (const area of areas) {
    const way = wayInto(area);
    if (area.id === MAIN || !way) continue;
    const there = places.filter((p) => areaOf(p) === area.id);
    if (has(area.name, ...there.map(placeTitle))) others.push({ area, way, places: there });
  }
  const town = places.find((p) => p.kind === "town" && has(p.name, "square"));
  const lobby = places.find((p) => p.kind === "lobby" && has(p.name, "lobby", "kiosks"));
  const floors = places.filter((p) => p.kind === "office" && has(p.name));
  const first =
    agents[0]?.home.id ?? rooms[0]?.id ?? shared[0]?.id ?? others[0]?.way ?? town?.id ?? lobby?.id ?? floors[0]?.id;
  return {
    agents,
    rooms,
    shared,
    areas: others,
    ...(town ? { town } : {}),
    ...(lobby ? { lobby } : {}),
    floors,
    ...(first ? { first } : {}),
  };
}
