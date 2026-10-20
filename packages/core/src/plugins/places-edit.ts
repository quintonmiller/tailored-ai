/**
 * A person rearranging a place on the page: what the room becomes when they
 * move or turn something, add or copy a thing, recolour it or take it away,
 * checked the way the `place` tool checks its own changes. Nothing goes in
 * front of a door, through a wall or into anything else, so a person can't
 * make a room the tool would refuse. A person can put in a door to any other
 * place, and take out any door put in (`places-doors.ts`). Pure: `places.ts`
 * answers the page with it over HTTP, and the page writes what comes back to
 * the place's record through the world-state API, as the person.
 */
import { linkItem, townDoorsOf, withoutLink } from "./places-doors.js";
import {
  type DoorSlot,
  findPlacement,
  KINDS,
  LIMITS,
  linkSlots,
  moveItem,
  newId,
  newName,
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
  /** Put a thing here, turned this way: on the floor, along the back or left wall, or on top of `on`. */
  | { op: "move"; item: string; at: [number, number]; facing: number; on?: string }
  /**
   * A new thing of a kind, somewhere free near the middle; `like`, a copy of that thing, beside it. A model an agent
   * made is added by its record's id, `model`; the server fills in its kind, the box it fills and its name.
   */
  | { op: "add"; kind: string; like?: string; model?: string; size?: [number, number, number]; name?: string }
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
/** A thing's name at the start of a sentence: "The picture". */
const named = (item: PlaceItem) => item.name.charAt(0).toUpperCase() + item.name.slice(1);

/** An edit as the page sent it, or why it isn't one. */
export function editFrom(body: unknown): Edit | string {
  const e = (body ?? {}) as Record<string, unknown>;
  const item = text(e.item);
  switch (e.op) {
    case "move":
      if (!item || !isPoint(e.at) || typeof e.facing !== "number" || !Number.isFinite(e.facing))
        return "A move needs `item`, `at` ([x, z]) and `facing`.";
      return { op: "move", item, at: e.at, facing: e.facing, ...(text(e.on) ? { on: text(e.on) } : {}) };
    case "add": {
      const kind = text(e.kind);
      const model = text(e.model);
      if (!kind && !model) return "Adding needs `kind`, or a `model`.";
      return {
        op: "add",
        kind: kind ?? "model",
        ...(text(e.like) ? { like: text(e.like) } : {}),
        ...(model ? { model } : {}),
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

/**
 * What a place becomes with a person's change, or why it can't have it, in
 * a sentence for the page to show. `id` says which place it is: the lobby
 * keeps its way out clear, and the town and the office's floors, which are
 * laid out from what there is, can't be changed at all.
 */
export function applyEdit(id: string, place: Place, edit: Edit): Edited | string {
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
    // A copy goes beside what it copies; anything new near the middle, or else wherever it fits.
    const where: Where = like ? { near: like.id } : kind.mount === "floor" ? { middle: true } : {};
    let spot = findPlacement(held, placing, where);
    if (typeof spot === "string" && where.middle) spot = findPlacement(held, placing, {});
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

  // A door put in: it can be taken out, which takes its way back with it, but it isn't a thing to move or repaint.
  const link = place.links?.find((l) => linkItem(l.to) === edit.item);
  if (link) {
    if (edit.op === "remove") return { place: withoutLink(place, link.to), item: edit.item };
    return edit.op === "color"
      ? "A door keeps the colours of the place it leads to."
      : "A door stays where it was put in. Take it out and put it in again to have it somewhere else.";
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

  const to = placed(place, held, item, edit);
  if (typeof to === "string") return to;
  const next = moveItem(place, item.id, to);
  return sound(next) ?? { place: next, item: item.id };
}
