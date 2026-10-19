/**
 * Places: an agent with a body chooses what its room looks like.
 *
 * Each agent with an avatar has a home: a world-state record of type `place`
 * (`home:<agent>`, in its own scope) that the web UI draws and the avatar
 * walks around in. The `place` tool lets the agent look at it and change it:
 * add furniture where it says ("by the window", "on the desk", "in the back
 * left corner"), move, restyle or remove things, resize and repaint the room,
 * and undo. Because the room is world state, every change has an author and a
 * history, the State page can show and edit it, and the chat page redraws it
 * the moment it changes.
 *
 * The tool also takes photos: the room, or a selfie, rendered by the bundled
 * UI in a headless browser (see `places-camera.ts`). A photo comes back as an
 * image, so it goes out with the agent's reply on any surface that shows one,
 * Discord included.
 *
 * Free when unused: with no avatar configured, it registers nothing. An agent
 * with its own `tools:` list needs `place` named in it, like any tool.
 */
import type { AgentConfig } from "../config.js";
import { mediaPart, textPart } from "../content/types.js";
import type { TaiHttpRequest, TaiHttpResponse } from "../http/registry.js";
import { resolveAvatar } from "../live/avatar.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";
import type { StateCaller, StateService } from "../state/service.js";
import { StateConflictError, StateError } from "../state/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { agentStateCaller } from "../tools/state.js";
import { PlaceCamera, type Shot } from "./places-camera.js";
import {
  colorWord,
  defaultPlace,
  describe,
  FLOORS,
  type Floor,
  findItem,
  findPlacement,
  findSpot,
  footprintOf,
  KINDS,
  LIMITS,
  moveItem,
  newId,
  newName,
  PLACE_SCHEMA,
  type Place,
  type PlaceItem,
  type Placing,
  parseColor,
  placeProblems,
  removeItem,
  resize,
  type Side,
  type Wall,
  type Where,
  whereWords,
  withSpots,
} from "./places-layout.js";

export const PLACE_TYPE = "place";

export const meta: PluginMeta = {
  name: "Places",
  description:
    "Gives each agent with an avatar a room it can change: a `place` world-state record, the `place` tool, and GET /api/ext/builtin:places/:agent for the page that draws it.",
  registers: [
    { kind: "stateType", id: "place" },
    { kind: "tool", id: "place" },
    { kind: "httpRoutes", id: "places" },
  ],
};

/** The record that holds an agent's own room. */
export function homeId(agent: string): string {
  return `home:${agent}`;
}

/** Whether anyone has a body, so there is a room to keep. */
export function anyAvatar(config: AgentConfig): boolean {
  if (resolveAvatar(config.live).model) return true;
  return Object.values(config.agents ?? {}).some((a) => !!resolveAvatar(config.live, a.avatar).model);
}

const PLUGIN_CALLER: StateCaller = { actor: { kind: "plugin", name: "places" }, source: { surface: "http" } };

/** An agent's home, made from the default room the first time anyone asks. */
export async function readHome(
  service: StateService,
  caller: StateCaller,
  agent: string,
): Promise<{ place: Place; version: number }> {
  const ref = { type: PLACE_TYPE, id: homeId(agent) };
  const found = await service.get(caller, ref);
  if (found) return { place: found.data as unknown as Place, version: found.version };
  const place = defaultPlace(agent === "default" ? "your room" : `${agent}'s room`);
  try {
    const made = await service.put(caller, {
      ...ref,
      scope: `agent:${agent}`,
      data: place as unknown as Record<string, unknown>,
    });
    return { place, version: made.version };
  } catch (err) {
    // Someone else made it a moment ago: theirs stands.
    const again = await service.get(caller, ref);
    if (again) return { place: again.data as unknown as Place, version: again.version };
    throw err;
  }
}

/** Where each agent's body has gone: no record means it is at home. */
export const WHEREABOUTS_TYPE = "whereabouts";
/** Shared places are `place` records everyone can see, named `shared:<slug>`. */
const SHARED = "shared:";

/** The place an agent's body is in: home, unless it has gone to a place that still exists. */
export async function whereIs(service: StateService, caller: StateCaller, agent: string): Promise<string> {
  // A store that keeps no whereabouts has everyone at home.
  const found = await service.get(caller, { type: WHEREABOUTS_TYPE, id: agent }).catch(() => null);
  const id = typeof found?.data.place === "string" ? found.data.place : undefined;
  if (!id || id === homeId(agent)) return homeId(agent);
  return (await service.get(caller, { type: PLACE_TYPE, id })) ? id : homeId(agent);
}

/** The place an agent is in now, with what a write needs: its id, version and scope. */
export async function readCurrent(
  service: StateService,
  caller: StateCaller,
  agent: string,
): Promise<{ id: string; place: Place; version: number; scope: string }> {
  const id = await whereIs(service, caller, agent);
  const found = id === homeId(agent) ? undefined : await service.get(caller, { type: PLACE_TYPE, id });
  if (found) return { id, place: found.data as unknown as Place, version: found.version, scope: found.scope };
  return { id: homeId(agent), ...(await readHome(service, caller, agent)), scope: `agent:${agent}` };
}

/** Everyone whose body is in a place now, apart from `except`: those who went there, and the owner of a home. */
export async function whoIsIn(
  service: StateService,
  caller: StateCaller,
  id: string,
  hasBody: (agent: string | undefined) => boolean,
  except?: string,
): Promise<string[]> {
  const went = await service
    .query(caller, { type: WHEREABOUTS_TYPE, where: { place: id }, limit: 50 })
    .catch(() => [] as Awaited<ReturnType<StateService["query"]>>);
  const names = new Set(went.map((r) => r.id));
  if (id.startsWith("home:")) {
    const owner = id.slice("home:".length);
    if ((await whereIs(service, caller, owner)) === id) names.add(owner);
  }
  if (except) names.delete(except);
  return [...names].filter((name) => hasBody(name)).sort();
}

/** The shared places, by id and name. */
async function sharedPlaces(service: StateService, caller: StateCaller): Promise<{ id: string; name: string }[]> {
  const records = await service.query(caller, { type: PLACE_TYPE, scope: "global", limit: 50 });
  return records
    .filter((r) => r.id.startsWith(SHARED))
    .map((r) => ({ id: r.id, name: String((r.data as unknown as Place).name ?? r.id) }));
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

// --------------------------------------------------------------------------
// The tool's arguments
// --------------------------------------------------------------------------

const ACTIONS = ["look", "add", "move", "change", "remove", "room", "undo", "photo", "places", "go", "new"] as const;
type Action = (typeof ACTIONS)[number];

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function number(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** A kind from what the model wrote: "coffee table", "Coffee_Table", "TV". */
function kindFrom(v: unknown): string | undefined {
  const t = text(v)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!t) return undefined;
  if (KINDS[t]) return t;
  const byNoun = Object.entries(KINDS).find(([, k]) => k.noun.toLowerCase().replace(/\s+/g, "_") === t);
  if (byNoun) return byNoun[0];
  const singular = t.replace(/s$/, "");
  return KINDS[singular] ? singular : undefined;
}

function sizeFrom(v: unknown): [number, number, number] | string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const parts = Array.isArray(v)
    ? v.map(Number)
    : String(v)
        .split(/[\sx×,*]+/)
        .filter(Boolean)
        .map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n)))
    return 'Give `size` as width, height and depth in metres, like "0.5 1 0.5".';
  const [lo, hi] = LIMITS.side;
  if (parts.some((n) => n < lo || n > hi)) return `Each side of a shape must be ${lo} to ${hi} m.`;
  return parts.map((n) => Math.round(n * 100) / 100) as [number, number, number];
}

function whereFrom(args: Record<string, unknown>): Where | string {
  const where: Where = {};
  const near = text(args.near);
  const on = text(args.on);
  const corner = text(args.corner);
  const side = text(args.side)?.toLowerCase();
  const wall = text(args.wall)
    ?.toLowerCase()
    .replace(/\s*wall$/, "");
  if (near) where.near = near;
  if (on) where.on = on;
  if (corner) where.corner = corner;
  if (side) {
    const s = side === "back" || side === "behind" ? "behind" : side;
    if (!["left", "right", "front", "behind"].includes(s)) return "`side` is left, right, front or behind.";
    where.side = s as Side;
  }
  if (wall) {
    if (!["back", "left", "right", "front"].includes(wall)) return "`wall` is back, left, right or front.";
    where.wall = wall as Wall;
  }
  const x = number(args.x);
  const z = number(args.z);
  if (x !== undefined) where.x = x;
  if (z !== undefined) where.z = z;
  const facing = args.facing;
  if (facing !== undefined && facing !== null && facing !== "") where.facing = facing as string | number;
  return where;
}

const hasPlacement = (w: Where) =>
  w.near !== undefined ||
  w.on !== undefined ||
  w.corner !== undefined ||
  w.wall !== undefined ||
  w.x !== undefined ||
  w.z !== undefined;

const say = (item: PlaceItem, place: Place) => `${item.name}, ${whereWords(place, item)}`;

export interface Outcome {
  ok: boolean;
  text: string;
  /** The room after the change; absent when nothing changed. */
  place?: Place;
}

const no = (text: string): Outcome => ({ ok: false, text });

/** One tool call against a room, without the store: what it becomes, and what to tell the agent. */
export function applyAction(place: Place, args: Record<string, unknown>): Outcome {
  const action = text(args.action)?.toLowerCase() as Action | undefined;
  if (!action || !ACTIONS.includes(action)) return no(`\`action\` is one of: ${ACTIONS.join(", ")}.`);
  if (action === "look") return { ok: true, text: describe(place) };

  if (action === "room") {
    let next: Place | string = place;
    const width = number(args.width);
    const depth = number(args.depth);
    const height = number(args.height);
    for (const [key, value] of [
      ["width", width],
      ["depth", depth],
      ["height", height],
    ] as const) {
      if (value === undefined) continue;
      const [lo, hi] = LIMITS[key];
      if (value < lo || value > hi) return no(`The room's ${key} must be ${lo} to ${hi} m.`);
    }
    const changes: string[] = [];
    if (width !== undefined || depth !== undefined || height !== undefined) {
      next = resize(place, {
        ...(width !== undefined ? { width: Math.round(width * 100) / 100 } : {}),
        ...(depth !== undefined ? { depth: Math.round(depth * 100) / 100 } : {}),
        ...(height !== undefined ? { height: Math.round(height * 100) / 100 } : {}),
      });
      if (typeof next === "string") return no(next);
      changes.push(`it is now ${next.width} × ${next.depth} m and ${next.height} m high`);
    }
    const walls = text(args.walls);
    if (walls) {
      const color = parseColor(walls);
      if (!color) return no(`"${walls}" isn't a colour I know. Use a name like "sage" or "dark blue", or #rrggbb.`);
      next = { ...next, walls: color };
      changes.push(`the walls are ${walls}`);
    }
    const floor = text(args.floor)?.toLowerCase();
    if (floor) {
      if (FLOORS.includes(floor as Floor)) {
        next = { ...next, floor: floor as Floor };
        changes.push(`the floor is ${floor}`);
      } else {
        const color = parseColor(floor);
        if (!color) return no(`\`floor\` is ${FLOORS.join(", ")}, or a colour.`);
        next = { ...next, floorColor: color };
        changes.push(`the floor is ${floor}`);
      }
    }
    const floorColor = text(args.color);
    if (floorColor && !floor) {
      const color = parseColor(floorColor);
      if (!color) return no(`"${floorColor}" isn't a colour I know.`);
      next = { ...next, floorColor: color };
      changes.push(`the floor is ${floorColor}`);
    }
    const name = text(args.name);
    if (name) {
      next = { ...next, name: name.slice(0, 80) };
      changes.push(`it is called ${name}`);
    }
    if (!changes.length) return no("Say what to change about the room: width, depth, height, walls, floor or name.");
    return { ok: true, text: `Changed the room: ${changes.join("; ")}.`, place: next };
  }

  const where = whereFrom(args);
  if (typeof where === "string") return no(where);

  if (action === "add") {
    const kind = kindFrom(args.kind);
    if (!kind) return no(`Say what to add with \`kind\`: ${Object.keys(KINDS).join(", ")}.`);
    if (place.props.length >= LIMITS.items)
      return no(`The room holds at most ${LIMITS.items} things. Remove one first.`);
    const item: Omit<PlaceItem, "at" | "facing"> = { id: newId(place, kind), name: "", kind };
    const colorText = text(args.color);
    if (colorText) {
      const color = parseColor(colorText);
      if (!color)
        return no(`"${colorText}" isn't a colour I know. Use a name like "teal" or "light pink", or #rrggbb.`);
      item.color = color;
    }
    const scale = number(args.scale);
    if (scale !== undefined) {
      if (scale < LIMITS.scale[0] || scale > LIMITS.scale[1])
        return no(`\`scale\` is ${LIMITS.scale[0]} to ${LIMITS.scale[1]}.`);
      if (scale !== 1) item.scale = scale;
    }
    if (KINDS[kind].shaped) {
      const size = sizeFrom(args.size);
      if (typeof size === "string") return no(size);
      item.size = size ?? [0.5, 0.5, 0.5];
    }
    const placing: Placing = {
      kind,
      ...(item.scale ? { scale: item.scale } : {}),
      ...(item.size ? { size: item.size } : {}),
    };
    const spot = findPlacement(place, placing, where);
    if (typeof spot === "string") return no(spot);
    item.name = newName(place, kind, colorWord(colorText), text(args.name));
    const added: PlaceItem = { ...item, at: spot.at, facing: spot.facing };
    if (spot.elevation !== undefined) added.elevation = spot.elevation;
    if (spot.on) {
      added.on = spot.on;
      const base = place.props.find((p) => p.id === spot.on);
      if (base?.spot) added.spot = base.spot;
    }
    const next = withSpots({ ...place, props: [...place.props, added] });
    const problems = placeProblems(next);
    if (problems.length) return no(`That wouldn't fit: ${problems[0]}`);
    const own = next.spots.find((s) => s.item === added.id);
    return {
      ok: true,
      text: `Added ${say(added, next)}.${own ? ` You can go to it: "${added.name}".` : ""}`,
      place: next,
    };
  }

  const itemWords = text(args.item);
  if (!itemWords) return no("Say which thing with `item`, by its name or id. `look` lists them.");
  const item = findItem(place, itemWords);
  if (!item) return no(`There's nothing called "${itemWords}" in the room. \`look\` lists what's there.`);

  if (action === "remove") {
    const { place: next, removed } = removeItem(place, item.id);
    return {
      ok: true,
      text: `Removed ${item.name}${removed.length ? `, and ${removed.join(", ")} on it` : ""}.`,
      place: next,
    };
  }

  if (action === "move") {
    const placing: Placing = {
      kind: item.kind,
      id: item.id,
      ...(item.scale ? { scale: item.scale } : {}),
      ...(item.size ? { size: item.size } : {}),
    };
    let spot: ReturnType<typeof findPlacement>;
    if (hasPlacement(where)) {
      spot = findPlacement(place, placing, where);
    } else if (where.facing !== undefined) {
      // Turning it where it stands.
      spot = findPlacement(place, placing, { x: item.at[0], z: item.at[1], facing: where.facing });
      if (typeof spot !== "string" && item.on) spot = { ...spot, at: item.at, on: item.on, elevation: item.elevation };
    } else {
      return no("Say where to move it: near, side, wall, corner, on, or x and z.");
    }
    if (typeof spot === "string") return no(spot);
    const next = moveItem(place, item.id, spot);
    const moved = next.props.find((p) => p.id === item.id) as PlaceItem;
    return { ok: true, text: `Moved ${say(moved, next)}.`, place: next };
  }

  // change
  const changes: string[] = [];
  let changed: PlaceItem = { ...item };
  const name = text(args.name);
  if (name) {
    changed.name = newName(
      { ...place, props: place.props.filter((p) => p.id !== item.id) },
      item.kind,
      undefined,
      name,
    );
    changes.push(`it is now called ${changed.name}`);
  }
  const colorText = text(args.color);
  if (colorText) {
    const color = parseColor(colorText);
    if (!color) return no(`"${colorText}" isn't a colour I know. Use a name like "navy" or "pale green", or #rrggbb.`);
    changed.color = color;
    changes.push(`it is ${colorText}`);
  }
  const scale = number(args.scale);
  if (scale !== undefined) {
    if (scale < LIMITS.scale[0] || scale > LIMITS.scale[1])
      return no(`\`scale\` is ${LIMITS.scale[0]} to ${LIMITS.scale[1]}.`);
    changed.scale = scale;
    if (scale === 1) delete changed.scale;
    changes.push(`it is ${scale}× its normal size`);
  }
  const size = KINDS[item.kind]?.shaped ? sizeFrom(args.size) : undefined;
  if (typeof size === "string") return no(size);
  if (size) {
    changed.size = size;
    changes.push(`it is ${size.join(" × ")} m`);
  }
  if (!changes.length) return no("Say what to change: name, color, scale, or size for a shape.");
  let next = withSpots({ ...place, props: place.props.map((p) => (p.id === item.id ? changed : p)) });
  const [ow, od] = footprintOf(item);
  const [nw, nd] = footprintOf(changed);
  if (nw !== ow || nd !== od || scale !== undefined || size) {
    // A different size has to fit again: where it is if it can, otherwise nearby.
    const placing: Placing = {
      kind: changed.kind,
      id: changed.id,
      ...(changed.scale ? { scale: changed.scale } : {}),
      ...(changed.size ? { size: changed.size } : {}),
    };
    const spot = item.on
      ? findPlacement(next, placing, { on: item.on, facing: item.facing })
      : KINDS[item.kind]?.mount === "wall"
        ? findPlacement(next, placing, { near: item.name })
        : findPlacement(next, placing, { x: item.at[0], z: item.at[1], facing: item.facing });
    if (typeof spot === "string") return no(`At that size it doesn't fit: ${spot}`);
    next = moveItem(next, item.id, spot);
    changed = next.props.find((p) => p.id === item.id) as PlaceItem;
    // What stands on it now stands at its new height.
    const top = (changed.elevation ?? 0) + (KINDS[changed.kind]?.surface ?? 0) * (changed.scale ?? 1);
    next = {
      ...next,
      props: next.props.map((p) => (p.on === changed.id ? { ...p, elevation: Math.round(top * 100) / 100 } : p)),
    };
  }
  const problems = placeProblems(next);
  if (problems.length) return no(`That doesn't work: ${problems[0]}`);
  return { ok: true, text: `Changed ${changed.name}: ${changes.join(", ")}.`, place: next };
}

// --------------------------------------------------------------------------
// The tool
// --------------------------------------------------------------------------

const fail = (error: string): ToolResult => ({ success: false, output: "", error });

export class PlaceTool implements Tool {
  name = "place";
  description =
    "Look at or change the 3D room your body is in: add, move, restyle or remove things, resize and repaint the room, take a photo or selfie to send, or go to a shared place others can be in. Start with look.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description:
          "look: the room, its things, who is here, what you can add. add / move / change / remove a thing. room: size, walls, floor. undo: the last change. photo: a picture to send. places: where you can go. go: to a place. new: make a shared place, and go there.",
      },
      item: { type: "string", description: "move, change, remove: the thing, by name or id." },
      kind: { type: "string", description: "add: what to add, e.g. armchair, rug, bookshelf, lamp, vase, block." },
      name: { type: "string", description: 'What to call it, e.g. "the reading chair"; for room, the room\'s name.' },
      near: { type: "string", description: "Put it by this thing or spot." },
      side: {
        type: "string",
        enum: ["left", "right", "front", "behind"],
        description: "Which side of `near`, as you face it.",
      },
      wall: { type: "string", enum: ["back", "left", "right", "front"], description: "Put it against this wall." },
      corner: { type: "string", enum: ["back left", "back right", "front left", "front right"] },
      on: { type: "string", description: "Put it on top of this, e.g. the desk." },
      x: { type: "number", description: "Exact spot, metres from the middle: + is right." },
      z: { type: "number", description: "Exact spot, metres from the middle: + is toward the viewer." },
      facing: {
        type: "string",
        description: 'Which way it faces: "the room", a thing\'s name, or degrees (0 faces the viewer).',
      },
      color: {
        type: "string",
        description: 'A colour name ("sage", "dark blue") or #rrggbb. For room, the floor\'s colour.',
      },
      scale: { type: "number", description: "Size relative to normal, 0.5 to 2." },
      size: { type: "string", description: 'Shapes only: width height depth in metres, e.g. "0.4 1.2 0.4".' },
      width: { type: "number", description: "room: width in metres." },
      depth: { type: "number", description: "room: depth in metres." },
      height: { type: "number", description: "room: ceiling height in metres." },
      walls: { type: "string", description: "room: the walls' colour." },
      floor: { type: "string", description: "room: wood, carpet, tile or concrete." },
      view: { type: "string", enum: ["room", "selfie"], description: "photo: the whole room, or a selfie." },
      at: { type: "string", description: "photo: where you are in it, a spot like the couch." },
      gesture: { type: "string", description: 'photo: a gesture to make, e.g. "wave".' },
      to: { type: "string", description: 'go: "home", or a shared place by name.' },
    },
    required: ["action"],
  };

  constructor(
    private readonly getService: () => StateService,
    private readonly hasBody: (agent: string | undefined) => boolean,
    /** Takes a photo; without one, `photo` says photos aren't available. */
    private readonly camera?: (shot: Shot) => Promise<Buffer>,
  ) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!this.hasBody(context.agentName)) return fail("You have no body, so there is no room of yours to change.");
    const agent = context.agentName ?? "default";
    const service = this.getService();
    const caller = agentStateCaller(context, "place");
    const action = text(args.action)?.toLowerCase();
    try {
      if (action === "photo") return await this.photo(args, context, agent);
      if (action === "places") return { success: true, output: await this.places(service, caller, agent) };
      if (action === "go") return await this.go(service, caller, agent, text(args.to) ?? text(args.name));
      if (action === "new") return await this.open(service, caller, agent, text(args.name));
      if (action === "look") {
        const { id, place } = await readCurrent(service, caller, agent);
        const others = await whoIsIn(service, caller, id, this.hasBody, agent);
        const where = id === homeId(agent) ? "You are at home." : `You are in ${place.name}, a shared place.`;
        const company = others.length ? ` Also here: ${others.join(", ")}.` : "";
        return { success: true, output: `${where}${company}\n\n${describe(place)}` };
      }
      if (action === "undo") {
        const { id } = await readCurrent(service, caller, agent);
        const ref = { type: PLACE_TYPE, id };
        const [last] = await service.history(caller, ref, { limit: 1 });
        if (!last?.before || last.op !== "update") return fail("There's nothing to undo.");
        await service.put(caller, { ...ref, data: last.before }, last.version);
        return {
          success: true,
          output: `Undone: the room is back as it was before the last change by ${last.actor.name}.`,
        };
      }
      for (let attempt = 0; ; attempt++) {
        const { id, place, version, scope } = await readCurrent(service, caller, agent);
        const outcome = applyAction(place, args);
        if (!outcome.place) return outcome.ok ? { success: true, output: outcome.text } : fail(outcome.text);
        try {
          await service.put(
            caller,
            { type: PLACE_TYPE, id, scope, data: outcome.place as unknown as Record<string, unknown> },
            version,
          );
          return { success: true, output: outcome.text };
        } catch (err) {
          // The room changed under us (the person, another turn, another agent): read it again, once.
          if (err instanceof StateConflictError && attempt === 0) continue;
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof StateError || err instanceof StateConflictError) return fail(err.message);
      throw err;
    }
  }

  /** Where it can go, and who is in each place. */
  private async places(service: StateService, caller: StateCaller, agent: string): Promise<string> {
    const here = await whereIs(service, caller, agent);
    const shared = await sharedPlaces(service, caller);
    const hereName = shared.find((p) => p.id === here)?.name;
    const lines = [hereName ? `You are in ${hereName}.` : "You are at home.", "Places you can go:"];
    const describeOne = async (id: string, label: string) => {
      const there = await whoIsIn(service, caller, id, this.hasBody, agent);
      const mark = id === here ? " (you are here)" : "";
      lines.push(
        `- ${label}${mark}${there.length ? `: ${there.join(", ")} ${there.length > 1 ? "are" : "is"} there` : ""}`,
      );
    };
    await describeOne(homeId(agent), "home, your own room");
    for (const place of shared) await describeOne(place.id, place.name);
    lines.push('Make a new shared place with action "new" and a name.');
    return lines.join("\n");
  }

  /** Go home, or to a shared place. */
  private async go(
    service: StateService,
    caller: StateCaller,
    agent: string,
    to: string | undefined,
  ): Promise<ToolResult> {
    if (!to) return fail('Say where with `to`: "home", or a shared place by name. `places` lists them.');
    const ref = { type: WHEREABOUTS_TYPE, id: agent };
    if (/^(home|my room|your room|back home)$/i.test(to) || to === homeId(agent)) {
      if (await service.get(caller, ref)) await service.delete(caller, ref);
      return { success: true, output: "You're home." };
    }
    const shared = await sharedPlaces(service, caller);
    const wanted = slug(to);
    const place = shared.find((p) => p.id === to || p.id === `${SHARED}${wanted}` || slug(p.name) === wanted);
    if (!place) {
      const known = shared.map((p) => p.name).join(", ");
      return fail(`There's no shared place called "${to}".${known ? ` There is: ${known}.` : ""} Make one with "new".`);
    }
    await service.put(caller, { ...ref, scope: "global", data: { place: place.id } });
    const there = await whoIsIn(service, caller, place.id, this.hasBody, agent);
    return {
      success: true,
      output: `You're in ${place.name} now.${there.length ? ` Also here: ${there.join(", ")}.` : " Nobody else is here yet."}`,
    };
  }

  /** Make a shared place, furnished like a new room, and go there. */
  private async open(
    service: StateService,
    caller: StateCaller,
    agent: string,
    name: string | undefined,
  ): Promise<ToolResult> {
    if (!name || !slug(name)) return fail('Give the new place a name, like "the lounge".');
    const id = `${SHARED}${slug(name)}`;
    if (await service.get(caller, { type: PLACE_TYPE, id }))
      return fail(`There's already a place called ${name}. Go there with action "go".`);
    const named = /^(the|a|an)\s/i.test(name) ? name : `the ${name}`;
    await service.put(caller, {
      type: PLACE_TYPE,
      id,
      scope: "global",
      data: defaultPlace(named.slice(0, 80)) as unknown as Record<string, unknown>,
    });
    await service.put(caller, { type: WHEREABOUTS_TYPE, id: agent, scope: "global", data: { place: id } });
    return {
      success: true,
      output: `Made ${named}, a shared place furnished like a new room, and you're in it. Others can join with go. Change it like your own room.`,
    };
  }

  /** A picture of the room, or a selfie, kept in the media store so it can go out with the reply. */
  private async photo(args: Record<string, unknown>, context: ToolContext, agent: string): Promise<ToolResult> {
    if (!this.camera) return fail("Photos aren't available here.");
    const store = context.mediaStore;
    if (!store) return fail("There's nowhere to keep a photo (no media store), so none can be sent.");
    const { place } = await readCurrent(this.getService(), agentStateCaller(context, "place"), agent);
    const view = text(args.view)?.toLowerCase() === "selfie" ? "selfie" : "room";
    const at = text(args.at);
    const spot = at ? findSpot(place, at) : undefined;
    if (at && !spot)
      return fail(`There's no spot called "${at}". You can be at: ${place.spots.map((s) => s.place).join(", ")}.`);
    const gesture = text(args.gesture)?.toLowerCase();
    let png: Buffer;
    try {
      png = await this.camera({ agent, view, ...(spot ? { spot: spot.id } : {}), ...(gesture ? { gesture } : {}) });
    } catch (err) {
      return fail((err as Error).message);
    }
    const ref = await store.put(png, { mimeType: "image/png", name: `${view}.png`, sessionId: context.sessionId });
    const what = view === "selfie" ? "A selfie" : `A photo of ${place.name}`;
    return {
      success: true,
      output: {
        parts: [textPart(`${what}${spot ? `, ${spot.name}` : ""}. It goes out with your reply.`), mediaPart(ref)],
      },
    };
  }
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------

function hasBodyIn(runtime: AgentRuntime) {
  return (agent: string | undefined) =>
    !!resolveAvatar(runtime.getConfig().live, runtime.avatarFor(agent === "default" ? undefined : agent)).model;
}

const plugin: Plugin = (ctx) => {
  const runtime = ctx.runtime;
  if (!runtime || !anyAvatar(runtime.getConfig())) return;
  const hasBody = hasBodyIn(runtime);
  const camera = new PlaceCamera(() => runtime.getSelfAccess());

  ctx.stateTypes.register({
    name: PLACE_TYPE,
    description: "A 3D room an agent's body lives in: its size, colours, furniture and the spots to stand at.",
    scope: "agent",
    title: "name",
    schema: PLACE_SCHEMA as never,
  });

  ctx.stateTypes.register({
    name: WHEREABOUTS_TYPE,
    description: "Where an agent's body has gone: the place it is in. No record means it is at home.",
    scope: "global",
    title: "place",
    schema: { type: "object", required: ["place"], properties: { place: { type: "string", maxLength: 128 } } } as never,
  });

  ctx.tools.register("place", (config, tctx) => {
    if (!anyAvatar(config) || !tctx.getStateService) return [];
    return [new PlaceTool(tctx.getStateService, hasBody, (shot) => camera.take(shot))];
  });

  // Plugin routes are namespaced by module, so this is GET /api/ext/builtin:places/:agent.
  ctx.http.register({
    method: "GET",
    path: ":agent",
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const agent = req.params.agent || "default";
      if (!hasBody(agent)) return { status: 404, json: { error: `${agent} has no avatar, so no room.` } };
      const service = runtime.getStateService();
      const { id, place, version } = await readCurrent(service, PLUGIN_CALLER, agent);
      // Everyone else whose body is here, with what the page needs to draw them.
      const company = (await whoIsIn(service, PLUGIN_CALLER, id, hasBody, agent)).map((name) => {
        const own = runtime.avatarFor(name === "default" ? undefined : name);
        const files = resolveAvatar(runtime.getConfig().live, own);
        const q = name === "default" ? "" : `?agent=${encodeURIComponent(name)}`;
        return {
          agent: name,
          name,
          avatar: `/api/live/avatar${q}`,
          animations: files.animations.map((_, i) => `/api/live/animations/${i}${q}`),
        };
      });
      return { json: { type: PLACE_TYPE, id, version, place, company } };
    },
  });
};

export default plugin;
