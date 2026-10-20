/**
 * Doors agents and people put in between places: which two places someone
 * may join, the place words name, which of the doors put in are there, and a
 * place's record with a door put in or taken out. Pure: `places.ts` reads and
 * writes the records, `places-layout.ts` finds where on a wall a door goes,
 * and `places-world.ts` hands the doors that are there to the page, beside
 * the town's own.
 *
 * A door is kept on both places' records, each saying where it is on its own
 * wall and where it goes. Both are written when it is put in. It is there
 * only while both are, so taking out either side takes the door out, and a
 * place that is gone takes its doors with it; the side left behind is tidied
 * away the next time its own place changes. Nothing here can take away a
 * place's way out to the street: a door put in keeps clear of it, as
 * furniture does.
 */
import {
  DOOR_NEEDS,
  type DoorSlot,
  doorOf,
  findDoorSlot,
  LIMITS,
  type NamedDoor,
  type Place,
  type PlaceLink,
  type Where,
  whyNoDoor,
} from "./places-layout.js";
import { LOBBY, LOBBY_DOORS } from "./places-rooms.js";

/** One end of a door: a place, what it is, and what it is called in a sentence. */
export interface LinkEnd {
  id: string;
  kind: "home" | "shared" | "room" | "lobby" | "town" | "office";
  /** What it is called in a sentence: "planner's home", "the lounge", "#budget's meeting room". */
  name: string;
  /** The agent whose home it is. */
  owner?: string;
  /** A meeting room's members: who may change it. */
  members?: string[];
}

/** Who is putting a door in or taking one out: an agent by its name, or the person on the page. */
export type Joiner = { agent: string } | { person: string };

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Why `who` can't put a door in `from` that leads to `to`, in a sentence;
 * undefined when they can. An agent joins places it may change, since the
 * way back is put in on the other side: its own home, any shared place, and
 * the meeting rooms of rooms it talks in. A person may join any two. Nobody
 * puts one in the town, whose doors are the buildings' own, or the office,
 * which is laid out from its meeting rooms.
 */
export function whyNoLink(who: Joiner, from: LinkEnd, to: LinkEnd): string | undefined {
  if (from.id === to.id) return "That's the place the door would be in: a door has to lead somewhere else.";
  for (const end of [from, to]) {
    if (end.kind === "town") return "The town is outdoors: its doors are the buildings' own, each on its street.";
    if (end.kind === "office")
      return `${capital(end.name)} is laid out from the meeting rooms on it, so no door can be put in there.`;
  }
  if ("person" in who) return undefined;
  for (const end of [from, to]) {
    const why = whyNotTheirs(who.agent, end);
    if (why) return why;
  }
  return undefined;
}

/** Why an agent may not change a place for a door, in a sentence; undefined when it may. */
function whyNotTheirs(agent: string, end: LinkEnd): string | undefined {
  if (end.kind === "lobby")
    return "The town hall is the town's, not an agent's to change: only a person can put a door in there.";
  if (end.kind === "home" && end.owner !== agent)
    return `That's ${end.owner}'s home: only ${end.owner} can put a door into it.`;
  if (end.kind === "room" && !end.members?.includes(agent)) {
    const room = end.name.replace(/'s meeting room$/, "");
    return `${capital(end.name)} is for the members of ${room}: join the room first, or ask one of them.`;
  }
  return undefined;
}

/** Words as compared: lower case, without "the", a "#", or what kind of place it is. */
const plain = (words: string) =>
  words
    .toLowerCase()
    .trim()
    .replace(/^#/, "")
    .replace(/^(the|a|an)\s+/, "")
    // A meeting room's own name, "#budget's meeting room", is the room's: "budget", as "#budget" and "the budget meeting room" are.
    .replace(/^#/, "")
    .replace(/([’']s)?\s+meeting room$/, "")
    .replace(/[’']s\s+(home|room|house|place)$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const TOWN_WORDS = new Set(["town", "street", "square", "outside", "outdoors"]);
const LOBBY_WORDS = new Set(["town-hall", "lobby", "hall"]);
const OWN_HOME = /^(home|my (home|room|house)|your (home|room|house)|back home)$/i;

/**
 * The place words name, among `ends`: "home" for the agent's own; a place's
 * id or name, "the lounge", "#budget"; an agent's name for its home, or
 * "planner's home"; "the town hall"; "the town" or "the street". A home,
 * shared place or meeting room called that comes first, so a shared place
 * someone named "the hall" is that place, not the town hall. Undefined when
 * none is called that.
 */
export function placeNamed(words: string, ends: LinkEnd[], agent?: string): LinkEnd | undefined {
  const said = words.trim();
  if (agent && OWN_HOME.test(said)) return ends.find((e) => e.kind === "home" && e.owner === agent);
  const exact = ends.find((e) => e.id === said);
  if (exact) return exact;
  const t = plain(said);
  if (!t) return undefined;
  const of = (kind: LinkEnd["kind"]) => ends.filter((e) => e.kind === kind);
  const named =
    of("home").find((e) => plain(e.owner ?? "") === t || plain(e.name) === t) ??
    ends.find((e) => (e.kind === "shared" || e.kind === "room") && plain(e.name) === t);
  if (named) return named;
  if (TOWN_WORDS.has(t)) return of("town")[0];
  if (LOBBY_WORDS.has(t)) return of("lobby")[0];
  return (
    ends.find((e) => e.kind !== "home" && plain(e.name) === t) ??
    ends.find((e) => e.kind !== "home" && e.id.endsWith(`:${t}`))
  );
}

/** How long a door may wait for its way back before it is taken for one whose way back was taken out. */
export const LINK_GRACE_MS = 60_000;

/**
 * The doors put in that are there, by the place they are in: each place's
 * own doors whose way back is in the place they lead to, both places being
 * there (`exists`). One door from a place to any one other.
 */
export function matchLinks(links: Map<string, PlaceLink[]>, exists: (id: string) => boolean): Map<string, PlaceLink[]> {
  const shown = new Map<string, PlaceLink[]>();
  for (const [from, own] of links) {
    if (!exists(from)) continue;
    const seen = new Set<string>();
    const there = own.filter((l) => {
      if (seen.has(l.to) || l.to === from || !exists(l.to)) return false;
      seen.add(l.to);
      return (links.get(l.to) ?? []).some((back) => back.to === from);
    });
    if (there.length) shown.set(from, there);
  }
  return shown;
}

/**
 * A place's doors as they should be kept: those that are there (`shown`,
 * this place's from {@link matchLinks}), and any put in so lately that its
 * way back may still be being put in. The rest go from the record, and the
 * wall and floor they kept clear are free again. The same place, untouched,
 * when nothing goes.
 */
export function tidyLinks(place: Place, shown: PlaceLink[] | undefined, now: number): Place {
  if (!place.links?.length) return place;
  const there = new Set((shown ?? []).map((l) => l.to));
  const young = (l: PlaceLink) => {
    const since = l.since ? Date.parse(l.since) : Number.NaN;
    return Number.isFinite(since) && now - since < LINK_GRACE_MS;
  };
  const kept = place.links.filter((l) => there.has(l.to) || young(l));
  if (kept.length === place.links.length) return place;
  const { links: _gone, ...rest } = place;
  return kept.length ? { ...rest, links: kept } : rest;
}

/** The place with a door put in: in place of any it had to the same place. */
export function withLink(place: Place, link: PlaceLink): Place {
  return { ...place, links: [...(place.links ?? []).filter((l) => l.to !== link.to), link] };
}

/** The place with its door to `to` taken out. */
export function withoutLink(place: Place, to: string): Place {
  const kept = (place.links ?? []).filter((l) => l.to !== to);
  const { links: _gone, ...rest } = place;
  return kept.length ? { ...rest, links: kept } : rest;
}

/** The id the page picks a door put in by, as it picks a thing by its id. */
export const linkItem = (to: string) => `door:${to}`;

/** Whether words say "door": "the door to the lounge", "the lounge door". */
export const saysDoor = (words: string) => /\bdoors?\b/i.test(words);

/**
 * The place words for a door are about, without the door: "the door to the
 * lounge" and "the lounge door" are "lounge", "the door out to Maple Lane"
 * is "maple-lane", and "the door" alone is "".
 */
export function doorMeans(words: string): string {
  return plain(
    words
      .toLowerCase()
      .trim()
      .replace(/^(the|a|an|my|your)\s+/, "")
      .replace(/\bdoors?\b/g, " ")
      .replace(/^\s*(out to|out|to|into|through|for|that goes to|that leads to|leading to)(\s+|$)/, "")
      .trim(),
  );
}

/**
 * The door put in that words mean, among a place's own: "the door to the
 * lounge", "the lounge door", "door:shared:lounge", or just "the door" when
 * it has only one. Words that say "door" may name its place by a whole word
 * of it ("the reading door"); any other words must be its place's name or id,
 * so a thing misnamed, or taken out already, is never taken for a door.
 * `nameOf` says what the place each leads to is called.
 */
export function findLink(
  place: Pick<Place, "links">,
  words: string,
  nameOf: (id: string) => string | undefined,
): PlaceLink | undefined {
  const links = place.links ?? [];
  const said = words.trim();
  const byId = links.find((l) => linkItem(l.to) === said || l.to === said);
  if (byId) return byId;
  const door = saysDoor(said);
  const t = doorMeans(said);
  if (!t) return door && links.length === 1 ? links[0] : undefined;
  const exact = links.find((l) => plain(nameOf(l.to) ?? "") === t) ?? links.find((l) => l.to.endsWith(`:${t}`));
  if (exact || !door) return exact;
  const whole = (s: string) => `-${s}-`;
  return links.find((l) => {
    const name = plain(nameOf(l.to) ?? "");
    return !!name && (whole(name).includes(whole(t)) || whole(t).includes(whole(name)));
  });
}

/** One of the two places a door joins, as {@link joinPlaces} needs it. */
export interface Joining {
  id: string;
  place: Place;
  /** What it is called in a sentence: "the lounge". */
  name: string;
  /** What its way out is called in a sentence: "the door out to Maple Lane". */
  out: string;
}

/** The town's own doors in a place, which nothing put in may stand in the way of: the town hall's, or its one door. */
export function townDoorsOf(id: string, place: Place): DoorSlot[] {
  if (id === LOBBY) return LOBBY_DOORS;
  const door = doorOf(place);
  return door ? [door] : [];
}

const sameSlot = (a: DoorSlot | undefined, b: DoorSlot | undefined) =>
  a?.wall === b?.wall && Math.abs((a?.along ?? 0) - (b?.along ?? 0)) < 1e-6;

/**
 * The doors in a place that a door put in or moved there keeps clear of: the
 * town's own, where it is now, and every other door put in but the one to
 * `except`. `nameOf` names the places they lead to.
 */
export function doorsToKeep(end: Joining, except: string, nameOf: (id: string) => string | undefined): NamedDoor[] {
  return [
    ...townDoorsOf(end.id, end.place).map((slot) => ({ slot, name: end.out })),
    ...(end.place.links ?? [])
      .filter((l) => l.to !== except)
      .map((l) => ({ slot: { wall: l.wall, along: l.along }, name: `the door to ${nameOf(l.to) ?? "another place"}` })),
  ];
}

/**
 * A place with its door to `to` moved: where the words say (`where`, as
 * {@link findDoorSlot} reads them), or to just this slot, where a person
 * dragged it. Clear of the town's door and the other doors put in, and never
 * moving the town's door. Its way back stays where it is. A sentence saying
 * why not when it can't go there.
 */
export function moveDoor(
  end: Joining,
  to: string,
  where: Where | DoorSlot,
  nameOf: (id: string) => string | undefined,
): { place: Place; slot: DoorSlot } | string {
  const link = end.place.links?.find((l) => l.to === to);
  if (!link) return "That door isn't there any more: someone may have just taken it out.";
  const base = withoutLink(end.place, to);
  const keep = doorsToKeep(end, to, nameOf);
  const slot = "along" in where ? (whyNoDoor(base, where, keep) ?? where) : findDoorSlot(base, where, keep);
  if (typeof slot === "string") return slot;
  const place = withLink(base, { ...link, wall: slot.wall, along: slot.along });
  if (!sameSlot(townDoorsOf(end.id, place)[0], townDoorsOf(end.id, end.place)[0]))
    return `It would be in the way of ${end.out}. Try another wall.`;
  return { place, slot };
}

/**
 * Two places joined by a door: `near`, the place it is put in, has it where
 * the words say (`where`, as furniture is put: a wall, a thing it is by); and
 * `far`, where it leads, has its way back wherever there is room. Neither
 * stands in the way of the town's own door, or any other door put in, nor
 * moves the town's door, so both places keep their way out to the street.
 * Each new door says who put it in and when. A sentence saying why not when
 * it can't be done: no room on one side or the other, or one place has all
 * the doors it can have. `nameOf` names the places other doors lead to.
 */
export function joinPlaces(
  near: Joining,
  far: Joining,
  where: Where,
  made: { by: string; since: string },
  nameOf: (id: string) => string | undefined,
): { near: Place; far: Place; nearSlot: DoorSlot; farSlot: DoorSlot } | string {
  if (near.place.links?.some((l) => l.to === far.id)) return `There's already a door to ${far.name} here.`;
  for (const [end, other] of [
    [near, far],
    [far, near],
  ] as const)
    if ((end.place.links ?? []).filter((l) => l.to !== other.id).length >= LIMITS.links)
      return `${end === near ? "This place" : capital(far.name)} has all the doors put in it can have (${LIMITS.links}). Take one out first.`;
  const keep = (end: Joining, other: Joining) => doorsToKeep(end, other.id, nameOf);
  // What there is either side without any door between the two already: a way back left from before is put again.
  const nearBase = withoutLink(near.place, far.id);
  const farBase = withoutLink(far.place, near.id);
  const nearSlot = findDoorSlot(nearBase, where, keep(near, far));
  if (typeof nearSlot === "string") return nearSlot;
  const farSlot = findDoorSlot(farBase, {}, keep(far, near));
  if (typeof farSlot === "string")
    return `There's no room in ${far.name} for the way back: ${DOOR_NEEDS}, and every side there is taken. Make room there first.`;
  const link = (to: string, slot: DoorSlot): PlaceLink => ({
    to,
    wall: slot.wall,
    along: slot.along,
    by: made.by,
    since: made.since,
  });
  const nextNear = withLink(nearBase, link(far.id, nearSlot));
  const nextFar = withLink(farBase, link(near.id, farSlot));
  // A door the town's own one moves for would leave the town's plan out of step with the room: never.
  if (!sameSlot(townDoorsOf(near.id, nextNear)[0], townDoorsOf(near.id, nearBase)[0]))
    return `It would be in the way of ${near.out}. Try another wall.`;
  if (!sameSlot(townDoorsOf(far.id, nextFar)[0], townDoorsOf(far.id, farBase)[0]))
    return `There's no room in ${far.name} for the way back without moving ${far.out}.`;
  return { near: nextNear, far: nextFar, nearSlot, farSlot };
}
