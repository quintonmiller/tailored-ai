/**
 * Finding your way round the world: where you are, said from the town down
 * ("Town › Maple Lane › analyst's home"), and the map's index of who and what
 * there is to go to, people and rooms first and the office's floors last,
 * filtered by what you type. Pure, so it is tested without a page; the map and
 * the stage's tools draw what this says.
 */
import type { BodyLooks } from "../avatar/body";
import type { AgentActivity } from "../avatar/doing";
import { nameOf } from "./conversations";

/** One place on the map, as `builtin:places` lists it: a home with how its owner chose to look and carry itself. */
export interface MapPlace extends BodyLooks {
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
  /** When a room of conversation last talked, as far as the server knows. */
  talked?: string;
  /** How many are in a room of conversation, people and agents, as the room lists them, when it keeps a list. */
  everyone?: number;
  /** How many agents a room of conversation wakes, with a body or not, when it keeps no list of who is in it. */
  subscribed?: number;
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

/**
 * Whether a place is everyone's: the town square and the lobby inside its town hall. Their boards, calendars and
 * widgets show every agent's, since nobody lives there and agents only pass through.
 */
export function isCommon(place: string | undefined): boolean {
  return place === "lobby" || place === TOWN;
}

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

/**
 * The words on a place's plaque by its door: what the breadcrumb calls it,
 * "planner's home" or "#budget", so the wall and the trail agree. A home
 * keeps a name its agent gave it with the place tool; the name it was built
 * with ("your room", "planner's room") would read, on a wall, as yours.
 */
export function plaqueWords(id: string, name: string): string {
  if (id.startsWith("home:")) {
    const owner = id.slice("home:".length);
    // As the places plugin names a home it builds, in the home itself and on the map.
    const built = owner === "default" ? ["your room", "the default agent's room"] : [`${owner}'s room`];
    return name && !built.includes(name) ? name : placeTitle({ kind: "home", name, owner, id });
  }
  if (id.startsWith("room:")) return placeTitle({ kind: "room", name, id });
  return name;
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

/** How many places you came through by doors put in the trail remembers: where you came from, not your whole walk. */
export const HOPS_KEPT = 3;

/**
 * The places you came through by doors agents and people put in, oldest
 * first, after going through one more, from `from` to `to`: back through a
 * door to where you were, the way shortens to before it; on through another,
 * it grows by the place you left.
 */
export function hopsAfter(hops: string[], from: string, to: string): string[] {
  const back = hops.indexOf(to);
  if (back >= 0) return hops.slice(0, back);
  return [...hops.filter((h) => h !== from), from].slice(-HOPS_KEPT);
}

/**
 * Where you are, said the way you came: the trail to the first place you came
 * through by a door put in, each place since, and here. The last of them, a
 * door away, is gone back to by that door (`from`). The plain trail when you
 * came no such way, or a place on the way is off the map.
 */
export function trailThrough(
  here: string | undefined,
  hops: string[],
  places: MapPlace[],
  areas: MapArea[] = [],
): Crumb[] {
  const plain = trailTo(here, places, areas);
  if (!here || !hops.length || !plain.length) return plain;
  const first = trailTo(hops[0], places, areas);
  const since = [...hops.slice(1), here].map((id) => places.find((p) => p.id === id));
  if (!first.length || since.some((p) => !p)) return plain;
  const steps = (since as MapPlace[]).map((p): Crumb => ({ id: p.id, label: placeTitle(p) }));
  const trail = [...first, ...steps];
  // A door away: back through it, rather than to where the place's map entry starts you.
  const back = trail.length - 2;
  trail[back] = { ...trail[back], from: here };
  return trail;
}

/**
 * Where a body went, from a change to a record of where it is: its
 * whereabouts, where no record kept means it is at home, or a visit. A visit
 * says only where the body is visiting, and its end only where it was: the
 * other end is where the body lives (`lives`, its whereabouts or else its
 * home), when the page knows, and unknown when it doesn't. Undefined for any
 * other change, or none at all.
 */
export function moveOf(
  change: {
    type: string;
    id: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  },
  lives?: string,
): { from?: string; to?: string } | undefined {
  const at = (data?: Record<string, unknown>) => (typeof data?.place === "string" ? data.place : undefined);
  const home = `home:${change.id}`;
  const from = change.type === "whereabouts" ? (at(change.before) ?? home) : (at(change.before) ?? lives);
  const to = change.type === "whereabouts" ? (at(change.after) ?? home) : (at(change.after) ?? lives);
  if ((change.type !== "whereabouts" && change.type !== "visit") || from === to) return undefined;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
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
