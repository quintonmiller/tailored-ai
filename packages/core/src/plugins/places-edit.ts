/**
 * A person rearranging a place on the page: what the room becomes when they
 * move or turn something, add or copy a thing, recolour it or take it away,
 * checked the way the `place` tool checks its own changes. Nothing goes in
 * front of a door, through a wall or into anything else, so a person can't
 * make a room the tool would refuse. A person can put in a door to any other
 * place, and drag or take out any door put in (`places-doors.ts`). Pure: `places.ts`
 * answers the page with it over HTTP, and the page writes what comes back to
 * the place's record through the world-state API, as the person.
 */
import { linkItem, moveDoor, townDoorsOf, withoutLink } from "./places-doors.js";
import {
  type DoorSlot,
  doorSlotAt,
  findPlacement,
  KINDS,
  LIMITS,
  linkSlots,
  moveItem,
  newId,
  newName,
  normalizeFacing,
  type Place,
  type PlaceAction,
  type PlaceItem,
  type Placement,
  type Placing,
  placeProblems,
  removeItem,
  SHOWS_KINDS,
  SHOWS_LENGTH,
  topOf,
  type Where,
  wallPoint,
  whyNotOnFloor,
  whyNotOnTop,
  whyNotOnWall,
  withDoorsHeld,
  withSpots,
} from "./places-layout.js";
import { LOBBY } from "./places-rooms.js";
import { TOWN } from "./places-town.js";
import { OFFICE } from "./places-world.js";

/** One change a person makes on the page. */
export type Edit =
  /**
   * Put a thing here, turned this way: on the floor, along the back or left wall, or on top of `on`. `with` names
   * floor things that go with it, like the chairs at a table: each keeps its place round it, moved as far and turned
   * as much about it, and the lot is checked where it ends up, together.
   */
  | { op: "move"; item: string; at: [number, number]; facing: number; on?: string; with?: string[] }
  /**
   * A new thing of a kind, somewhere on open floor, where it has the most room round it; `like`, a copy of that
   * thing, beside it. A model an agent made is added by its record's id, `model`; the server fills in its kind, the
   * box it fills and its name. `avoid` is where people and agents stand on the page, [x, z] each: nothing new lands
   * on anyone, or within a metre of them where the room has the floor for it, and nothing tall stands between them
   * and the view in.
   */
  | {
      op: "add";
      kind: string;
      like?: string;
      model?: string;
      size?: [number, number, number];
      name?: string;
      avoid?: [number, number][];
    }
  | { op: "remove"; item: string }
  | { op: "color"; item: string; color: string }
  /** What a widget shows (`PlaceItem.shows`); null, back to what its kind shows by itself. */
  | { op: "shows"; item: string; shows: string | null }
  /** A door to another place, by its id, with the way back on the other side (`places.ts` answers this one). */
  | { op: "door"; to: string };

/** The room after a person's change: what it is now, the thing it added or changed, and what went with a removal. */
export interface Edited {
  place: Place;
  item?: string;
  /** Names of what stood on a thing that was taken away, and went with it. */
  removed?: string[];
}

/** How near the line of a wall a thing hanging on it must be: the page puts it on the line, to the centimetre. */
const ON_WALL = 0.06;
/** The most things a person moves along with another at once, and the most places where someone stands to keep clear. */
const MOST_WITH = 24;
/**
 * How much floor someone standing takes, across, kept clear of anything new:
 * a metre either side of them, so a new thing is put down well clear rather
 * than wrapped round them; in a room without the floor for that, less, down
 * to what they stand on.
 */
const STANDING = [2, 1.4, 0.6];

/** What each of the lobby's working pieces lets you do from it, for saying why it stays. */
const DOES: Record<PlaceAction, string> = {
  "new-agent": "make an agent",
  "new-task": "make a task",
  "new-room": "make a room",
  tasks: "see the open tasks",
  map: "find a place on the map",
};

/**
 * The doors to keep clear while a person changes a place: the lobby's way out
 * on to the square; anywhere else, the door the place has, or would have, as
 * the tool keeps it (`withDoorwayHeld`); and the doors put in.
 */
export function doorsFor(id: string, place: Place): DoorSlot[] {
  return [...townDoorsOf(id, place), ...linkSlots(place)];
}

const isPoint = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** A list of ids as the page sent it: the ones that are ids, each once. */
const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(text).filter((id): id is string => !!id))] : []);
/** A thing's name at the start of a sentence: "The picture". */
const named = (item: PlaceItem) => item.name.charAt(0).toUpperCase() + item.name.slice(1);

/** An edit as the page sent it, or why it isn't one. */
export function editFrom(body: unknown): Edit | string {
  const e = (body ?? {}) as Record<string, unknown>;
  const item = text(e.item);
  switch (e.op) {
    case "move": {
      if (!item || !isPoint(e.at) || typeof e.facing !== "number" || !Number.isFinite(e.facing))
        return "A move needs `item`, `at` ([x, z]) and `facing`.";
      const along = ids(e.with);
      // Said, rather than some of them moved and the rest left behind with no word.
      if (along.length > MOST_WITH)
        return `That's more than ${MOST_WITH} things to move at once. Move it on its own (Alt-drag), then the rest.`;
      return {
        op: "move",
        item,
        at: e.at,
        facing: e.facing,
        ...(text(e.on) ? { on: text(e.on) } : {}),
        ...(along.length ? { with: along } : {}),
      };
    }
    case "add": {
      const kind = text(e.kind);
      const model = text(e.model);
      if (!kind && !model) return "Adding needs `kind`, or a `model`.";
      const avoid = Array.isArray(e.avoid) ? e.avoid.filter(isPoint).slice(0, MOST_WITH) : [];
      return {
        op: "add",
        kind: kind ?? "model",
        ...(text(e.like) ? { like: text(e.like) } : {}),
        ...(model ? { model } : {}),
        ...(avoid.length ? { avoid } : {}),
      };
    }
    case "remove":
      return item ? { op: "remove", item } : "Removing needs `item`.";
    case "color": {
      const color = text(e.color)?.toLowerCase();
      if (!item || !color || !/^#[0-9a-f]{6}$/.test(color)) return "A colour needs `item` and `color` as #rrggbb.";
      return { op: "color", item, color };
    }
    case "shows": {
      if (!item) return "Choosing what it shows needs `item`.";
      if (e.shows === null || e.shows === "") return { op: "shows", item, shows: null };
      const shows = text(e.shows);
      if (!shows || shows.length > SHOWS_LENGTH) return `\`shows\` is up to ${SHOWS_LENGTH} characters, or null.`;
      return { op: "shows", item, shows };
    }
    case "door": {
      const to = text(e.to);
      return to ? { op: "door", to } : "A door needs `to`, the place it leads to.";
    }
    default:
      return "`op` is one of: move, add, remove, color, shows, door.";
  }
}

/** What a thing is, for checking where it goes: its kind and size, and its id, so it doesn't get in its own way. */
const placingOf = (item: PlaceItem): Placing => ({
  kind: item.kind,
  id: item.id,
  ...(item.scale ? { scale: item.scale } : {}),
  ...(item.size ? { size: item.size } : {}),
});

/** A thing that stands on others rather than the floor: one made to, or one an agent put on something. */
const rides = (item: PlaceItem) => KINDS[item.kind]?.mount === "on" || !!item.on;

/** The id of a block held where someone stands while something new is put down: never kept in the room. */
const STANDING_HOLD = "someone-standing";

/**
 * The room with where people and agents stand held, for finding where
 * something new goes: a block as tall as the room at each, so nothing is put
 * down on anyone. What is found is put in the room as it is, without them.
 */
function withStandingHeld(place: Place, at: [number, number][], across: number): Place {
  const holds = at.map(
    (point, i): PlaceItem => ({
      id: `${STANDING_HOLD}-${i + 1}`,
      name: "someone standing there",
      kind: "ball",
      at: point,
      facing: 0,
      size: [across, 9, across],
    }),
  );
  return holds.length ? { ...place, props: [...place.props, ...holds] } : place;
}

/** Where a thing that goes with another ends up once that is put `to`, turned `turn` degrees: its place round it kept. */
function carriedAlong(thing: PlaceItem, lead: PlaceItem, to: [number, number], turn: number): [number, number] {
  const r = (lead.facing * Math.PI) / 180;
  const dx = thing.at[0] - lead.at[0];
  const dz = thing.at[1] - lead.at[1];
  // In the lead's own frame, then back out of it turned as it is turned.
  const lx = dx * Math.cos(r) - dz * Math.sin(r);
  const lz = dx * Math.sin(r) + dz * Math.cos(r);
  const f = ((lead.facing + turn) * Math.PI) / 180;
  const cm = (n: number) => Math.round(n * 100) / 100;
  return [cm(to[0] + lx * Math.cos(f) + lz * Math.sin(f)), cm(to[1] - lx * Math.sin(f) + lz * Math.cos(f))];
}

/**
 * A thing moved with others that go with it (`with`): all of them moved and
 * turned together, each keeping its place round the first, then each checked
 * where it now stands against the room as it now is, so they never get in
 * each other's way on the way there. Only floor things go along: what stands
 * on top of one goes with it anyway. Why not, in a sentence naming the piece
 * that doesn't fit, when one doesn't.
 */
function movedTogether(
  id: string,
  place: Place,
  item: PlaceItem,
  edit: Extract<Edit, { op: "move" }>,
  group: PlaceItem[],
): Place | string {
  if (KINDS[item.kind]?.mount !== "floor" || item.on || edit.on)
    return `${named(item)} doesn't take anything with it: move it by itself.`;
  const turn = edit.facing - item.facing;
  let next = moveItem(place, item.id, { at: edit.at, facing: edit.facing });
  for (const other of group)
    next = moveItem(next, other.id, {
      at: carriedAlong(other, item, edit.at, turn),
      facing: normalizeFacing(other.facing + turn),
    });
  const held = withDoorsHeld(next, doorsFor(id, next));
  const moved = [item, ...group];
  for (const piece of moved) {
    const now = next.props.find((p) => p.id === piece.id) as PlaceItem;
    // Against everything but the rest of the group, which stands round it as it did before.
    const rest = new Set(moved.map((m) => m.id).filter((m) => m !== piece.id));
    const others: Place = {
      ...held,
      props: held.props.filter((p) => !rest.has(p.id)),
      spots: held.spots.filter((sp) => !sp.item || !rest.has(sp.item)),
    };
    const why = whyNotOnFloor(others, placingOf(now), now.at, now.facing);
    if (why) return why.replace(/^It /, `${named(now)} `);
  }
  return next;
}

/** Where a person put a thing, checked: where it goes, or why it can't go there. */
function placed(place: Place, held: Place, item: PlaceItem, edit: Extract<Edit, { op: "move" }>): Placement | string {
  const kind = KINDS[item.kind];
  if (!kind) return `${named(item)} is a kind of thing the room can't draw.`;
  const placing = placingOf(item);
  if (kind.mount === "wall") {
    const [x, z] = edit.at;
    const wall =
      Math.abs(z + place.depth / 2) <= ON_WALL ? "back" : Math.abs(x + place.width / 2) <= ON_WALL ? "left" : undefined;
    if (!wall) return `${named(item)} hangs on the back or left wall.`;
    const along = wall === "back" ? x : z;
    const elevation = item.elevation ?? kind.elevation ?? 1.2;
    const why = whyNotOnWall(held, placing, wall, along, elevation);
    return why ?? { at: wallPoint(place, wall, along), facing: wall === "back" ? 0 : 90, elevation };
  }
  if (rides(item)) {
    const base = edit.on ?? item.on;
    if (!base) return `${named(item)} needs something to stand on, like a desk, a table or a shelf.`;
    const why = whyNotOnTop(held, placing, base, edit.at);
    return why ?? { at: edit.at, facing: edit.facing, elevation: topOf(place, base) ?? 0, on: base };
  }
  return whyNotOnFloor(held, placing, edit.at, edit.facing) ?? { at: edit.at, facing: edit.facing };
}

/** What the doors in a place are called, for saying which one is in the way: its way out, and where each door put in goes. */
export interface DoorNames {
  out: string;
  nameOf: (id: string) => string | undefined;
}

/**
 * What a place becomes with a person's change, or why it can't have it, in
 * a sentence for the page to show. `id` says which place it is: the lobby
 * keeps its way out clear, and the town and the office's floors, which are
 * laid out from what there is, can't be changed at all. `names` names the
 * doors, for saying which is in the way of a door dragged somewhere.
 */
export function applyEdit(id: string, place: Place, edit: Edit, names?: DoorNames): Edited | string {
  if (id === TOWN) return "The town is laid out from who and what is in it, so it can't be changed.";
  if (id === OFFICE || id.startsWith(`${OFFICE}:`))
    return "The office is laid out from the meeting rooms in it, so it can't be changed.";
  if (edit.op === "door") return "A door to another place is put in by the server, which can see both places.";
  const held = withDoorsHeld(place, doorsFor(id, place));
  const sound = (next: Place) => {
    const problems = placeProblems(next);
    return problems.length ? `That wouldn't work: ${problems[0]}` : undefined;
  };

  if (edit.op === "add") {
    const kind = KINDS[edit.kind];
    if (!kind) return `There's no kind of thing called "${edit.kind}".`;
    if (place.props.length >= LIMITS.items) return `A room holds at most ${LIMITS.items} things. Take one away first.`;
    const like = edit.like ? place.props.find((p) => p.id === edit.like) : undefined;
    if (edit.like && !like) return "The thing to copy isn't in the room any more.";
    if (kind.model && !like && !(edit.model && edit.size)) return "Say which model to add.";
    const copied = like
      ? {
          ...(like.color ? { color: like.color } : {}),
          ...(like.scale ? { scale: like.scale } : {}),
          ...(like.size ? { size: like.size } : {}),
          ...(like.label ? { label: like.label } : {}),
          ...(like.action ? { action: like.action } : {}),
          ...(like.model ? { model: like.model } : {}),
          ...(like.shows ? { shows: like.shows } : {}),
        }
      : edit.model && edit.size
        ? { model: edit.model, size: edit.size }
        : KINDS[edit.kind].shaped
          ? { size: [0.5, 0.5, 0.5] as [number, number, number] }
          : // A task board shows the open tasks and opens them, as the ones rooms are drawn with do.
            edit.kind === "board"
            ? { label: "Tasks", action: "tasks" as const }
            : {};
    const placing: Placing = { kind: edit.kind, ...copied };
    // A copy goes beside what it copies; anything new on open floor, out of the furnished middle, or else wherever
    // it fits; never on anyone, and a metre clear of them where the room has the floor for it. Something tall keeps
    // out of the view in where it can: by the back or left wall, not across the open front or in front of anyone.
    const standing = kind.mount === "floor" ? (edit.avoid ?? []) : [];
    const where: Where = like ? { near: like.id } : kind.mount === "floor" ? { open: true, seen: standing } : {};
    let spot: ReturnType<typeof findPlacement> = "";
    for (const across of standing.length ? STANDING : [0]) {
      spot = findPlacement(withStandingHeld(held, standing, across), placing, where);
      if (typeof spot !== "string") break;
    }
    if (typeof spot === "string") return spot;
    const added: PlaceItem = {
      id: newId(place, edit.kind),
      name: newName(place, edit.kind, undefined, like?.name ?? edit.name),
      kind: edit.kind,
      ...copied,
      at: spot.at,
      facing: spot.facing,
    };
    if (spot.elevation !== undefined) added.elevation = spot.elevation;
    if (spot.on) {
      added.on = spot.on;
      const base = place.props.find((p) => p.id === spot.on);
      if (base?.spot) added.spot = base.spot;
    }
    const next = withSpots({ ...place, props: [...place.props, added] });
    return sound(next) ?? { place: next, item: added.id };
  }

  // A door put in: it can be taken out, which takes its way back with it, or dragged along the sides of the room to
  // where there is room for it, its way back staying where it is; but it keeps the colours of the place it leads to.
  const link = place.links?.find((l) => linkItem(l.to) === edit.item);
  if (link) {
    if (edit.op === "remove") return { place: withoutLink(place, link.to), item: edit.item };
    if (edit.op === "color") return "A door keeps the colours of the place it leads to.";
    if (edit.op === "shows") return "A door shows where it leads: there's nothing to choose.";
    const moved = moveDoor(
      { id, place, name: place.name, out: names?.out ?? "the way out" },
      link.to,
      doorSlotAt(place, edit.at),
      names?.nameOf ?? (() => undefined),
    );
    return typeof moved === "string" ? moved : { place: moved.place, item: edit.item };
  }
  const item = place.props.find((p) => p.id === edit.item);
  if (!item) return "That isn't in the room any more: someone may have just changed it.";

  if (edit.op === "remove") {
    // The lobby's kiosks and task board are where you make agents, tasks and rooms and see the tasks, inside the
    // world, and nothing in the catalogue can stand in for one: so they stay, wherever you move them.
    if (id === LOBBY && item.action)
      return `${named(item)} is how you ${DOES[item.action]} from the lobby, so it stays. Move it instead.`;
    const { place: next, removed } = removeItem(place, item.id);
    return { place: next, item: item.id, ...(removed.length ? { removed } : {}) };
  }

  if (edit.op === "shows") {
    if (!SHOWS_KINDS.includes(item.kind)) return `${named(item)} shows what it is: there's nothing to choose.`;
    const { shows: _, ...rest } = item;
    const changed: PlaceItem = edit.shows ? { ...rest, shows: edit.shows } : rest;
    return { place: { ...place, props: place.props.map((p) => (p.id === item.id ? changed : p)) }, item: item.id };
  }

  if (edit.op === "color") {
    if (item.model) return `${named(item)} keeps its parts' own colours, which its agent chose.`;
    const next = { ...place, props: place.props.map((p) => (p.id === item.id ? { ...p, color: edit.color } : p)) };
    return { place: next, item: item.id };
  }

  // With what goes with it: moved and checked together.
  const group = (edit.with ?? [])
    .map((w) => place.props.find((p) => p.id === w))
    .filter((p): p is PlaceItem => !!p && p.id !== item.id && KINDS[p.kind]?.mount === "floor" && !p.on);
  if (group.length) {
    const together = movedTogether(id, place, item, edit, group);
    if (typeof together === "string") return together;
    return sound(together) ?? { place: together, item: item.id };
  }
  const to = placed(place, held, item, edit);
  if (typeof to === "string") return to;
  const next = moveItem(place, item.id, to);
  return sound(next) ?? { place: next, item: item.id };
}
