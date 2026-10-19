/**
 * A person rearranging a place on the page: what the room becomes when they
 * move or turn something, add or copy a thing, recolour it or take it away,
 * checked the way the `place` tool checks its own changes. Nothing goes in
 * front of a door, through a wall or into anything else, so a person can't
 * make a room the tool would refuse. Pure: `places.ts` answers the page with
 * it over HTTP, and the page writes what comes back to the place's record
 * through the world-state API, as the person.
 */
import {
  type DoorSlot,
  doorOf,
  findPlacement,
  KINDS,
  LIMITS,
  moveItem,
  newId,
  newName,
  type Place,
  type PlaceItem,
  type Placement,
  type Placing,
  placeProblems,
  removeItem,
  topOf,
  type Where,
  wallPoint,
  whyNotOnFloor,
  whyNotOnTop,
  whyNotOnWall,
  withDoorsHeld,
  withSpots,
} from "./places-layout.js";
import { LOBBY, LOBBY_DOORS } from "./places-rooms.js";

/** One change a person makes on the page. */
export type Edit =
  /** Put a thing here, turned this way: on the floor, along the back or left wall, or on top of `on`. */
  | { op: "move"; item: string; at: [number, number]; facing: number; on?: string }
  /** A new thing of a kind, somewhere free near the middle; `like`, a copy of that thing, beside it. */
  | { op: "add"; kind: string; like?: string }
  | { op: "remove"; item: string }
  | { op: "color"; item: string; color: string };

/** The room after a person's change: what it is now, the thing it added or changed, and what went with a removal. */
export interface Edited {
  place: Place;
  item?: string;
  /** Names of what stood on a thing that was taken away, and went with it. */
  removed?: string[];
}

/** How near the line of a wall a thing hanging on it must be: the page puts it on the line, to the centimetre. */
const ON_WALL = 0.06;

/**
 * The doors to keep clear while a person changes a place: the lobby's own
 * doorways, whether or not a hall uses each yet; anywhere else, the door the
 * place has, or would have, as the tool keeps it (`withDoorwayHeld`).
 */
export function doorsFor(id: string, place: Place): DoorSlot[] {
  if (id === LOBBY) return LOBBY_DOORS;
  const door = doorOf(place);
  return door ? [door] : [];
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
      if (!kind) return "Adding needs `kind`.";
      return { op: "add", kind, ...(text(e.like) ? { like: text(e.like) } : {}) };
    }
    case "remove":
      return item ? { op: "remove", item } : "Removing needs `item`.";
    case "color": {
      const color = text(e.color)?.toLowerCase();
      if (!item || !color || !/^#[0-9a-f]{6}$/.test(color)) return "A colour needs `item` and `color` as #rrggbb.";
      return { op: "color", item, color };
    }
    default:
      return "`op` is one of: move, add, remove, color.";
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
 * keeps all its doorways clear, and a hall can't be changed at all.
 */
export function applyEdit(id: string, place: Place, edit: Edit): Edited | string {
  if (id.startsWith("hall:")) return "A hall is laid out by the building, so it can't be changed.";
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
    const copied = like
      ? {
          ...(like.color ? { color: like.color } : {}),
          ...(like.scale ? { scale: like.scale } : {}),
          ...(like.size ? { size: like.size } : {}),
          ...(like.label ? { label: like.label } : {}),
          ...(like.action ? { action: like.action } : {}),
        }
      : KINDS[edit.kind].shaped
        ? { size: [0.5, 0.5, 0.5] as [number, number, number] }
        : {};
    const placing: Placing = { kind: edit.kind, ...copied };
    // A copy goes beside what it copies; anything new near the middle, or else wherever it fits.
    const where: Where = like ? { near: like.id } : kind.mount === "floor" ? { middle: true } : {};
    let spot = findPlacement(held, placing, where);
    if (typeof spot === "string" && where.middle) spot = findPlacement(held, placing, {});
    if (typeof spot === "string") return spot;
    const added: PlaceItem = {
      id: newId(place, edit.kind),
      name: newName(place, edit.kind, undefined, like?.name),
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

  const item = place.props.find((p) => p.id === edit.item);
  if (!item) return "That isn't in the room any more: someone may have just changed it.";

  if (edit.op === "remove") {
    const { place: next, removed } = removeItem(place, item.id);
    return { place: next, item: item.id, ...(removed.length ? { removed } : {}) };
  }

  if (edit.op === "color") {
    const next = { ...place, props: place.props.map((p) => (p.id === item.id ? { ...p, color: edit.color } : p)) };
    return { place: next, item: item.id };
  }

  const to = placed(place, held, item, edit);
  if (typeof to === "string") return to;
  const next = moveItem(place, item.id, to);
  return sound(next) ?? { place: next, item: item.id };
}
