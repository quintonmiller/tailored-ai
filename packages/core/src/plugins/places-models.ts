/**
 * Models: things an agent makes for the 3D world out of simple parts.
 *
 * A model is a world-state record of type `model`, in its maker's own scope,
 * named `<agent>:<name>`. It is a few boxes, cylinders, spheres, cones, tori,
 * capsules and plates, each with a size, a place, a turn, a colour and a
 * finish, and it hangs on a wall, stands on the floor, or sits on top of
 * something. Once made, the `place` tool adds it to a room like any kind of
 * thing, and the page draws it from its parts (`avatar/models.ts`).
 *
 * A box or a plate can carry a face: an agent interface (a card bound to a
 * record, a list of records with ticks, a table) laid on its front, which
 * people use in the room. The face is a real interface component, made as
 * the model's agent, so the interfaces' own rules hold: the query runs as
 * that agent, and a tick writes as the person who ticked.
 *
 * Everything here is pure: reading what the agent wrote into a sound model,
 * or a sentence saying what is wrong; the box it fills; how it reads back;
 * and the ready-made models every agent can place or copy. `places-build.ts`
 * wires it to the store and the `build` tool.
 *
 * Units are metres. A model's own origin is the middle of its foot: +X is its
 * right, +Y up, +Z its front. Something for a wall has its back at z = 0.
 */
import { KINDS, parseColor } from "./places-layout.js";

export const MODEL_TYPE = "model";

/**
 * Where a model goes: on the floor, on a wall, or on top of something. Each
 * is drawn as one kind of thing in a room (`MOUNT_KIND`), so the room lays a
 * model out the way it lays out a block. A door is the next mount, once doors
 * between places can be placed (the seam for it is here and in `MOUNT_KIND`).
 */
export type Mount = "floor" | "wall" | "on";
export const MOUNTS: Mount[] = ["floor", "wall", "on"];
/** The kind of thing in a room a model is, by where it goes. */
export const MOUNT_KIND: Record<Mount, string> = { floor: "model", wall: "wall_model", on: "small_model" };
/** Whether a kind of thing in a room is a model. */
export const isModelKind = (kind: string) => Object.values(MOUNT_KIND).includes(kind);

export const SHAPES = ["box", "cylinder", "sphere", "cone", "torus", "capsule", "plane"] as const;
export type Shape = (typeof SHAPES)[number];
/** Other words for a shape, as models write them. */
const SHAPE_WORDS: Record<string, Shape> = {
  cube: "box",
  block: "box",
  cuboid: "box",
  ball: "sphere",
  cylinder: "cylinder",
  tube: "cylinder",
  disc: "cylinder",
  disk: "cylinder",
  ring: "torus",
  donut: "torus",
  doughnut: "torus",
  pill: "capsule",
  panel: "plane",
  plate: "plane",
  sheet: "plane",
  flat: "plane",
};

export const FINISHES = ["matte", "glossy", "metal", "glass", "glowing"] as const;
export type Finish = (typeof FINISHES)[number];

/** What a face can show: interface kinds that can be used by whoever is in the room. */
export const FACE_KINDS = ["card", "list", "table"] as const;
export type FaceKind = (typeof FACE_KINDS)[number];

/** Something to use on a part's front: an agent interface, made live as the model's agent. */
export interface ModelFace {
  kind: FaceKind;
  /** The interface's props: `title`, `body`, `check`, `columns`. */
  props: Record<string, unknown>;
  /** A card: the record it shows, `{type, id}`. A list or a table: the records, `{type, where?, limit?}`. */
  bind?: Record<string, unknown>;
  /** A card's buttons, each writing state (`patch`) or announcing an event. */
  actions?: Record<string, unknown>[];
  /** The interface component that shows it, made as the model's agent. */
  component?: string;
}

export interface ModelPart {
  shape: Shape;
  /** Width, height and depth of the box it fills. A plate is as thin as a plate whatever its depth. */
  size: [number, number, number];
  /** Where its middle is, from the model's origin. */
  at: [number, number, number];
  /** Turned about x, then y, then z, in degrees. */
  turn?: [number, number, number];
  /** "#rrggbb". */
  color: string;
  finish?: Finish;
  /** Only on a box or a plate: something to use, on its front. */
  face?: ModelFace;
}

export interface Model {
  /** What it is called: lower case, digits and underscores. */
  name: string;
  /** The agent that made it. Its faces run as this agent. */
  owner: string;
  mount: Mount;
  parts: ModelPart[];
  /** Width, height and depth of the whole, worked out from its parts. */
  size: [number, number, number];
  /** What it is for, in a line. */
  about?: string;
  /** The ready-made model it was copied from. */
  from?: string;
}

export const MODEL_LIMITS = {
  /** Parts in one model: enough for a bookcase full of books, few enough to draw in a handful of calls. */
  parts: 40,
  faces: 4,
  /** Each side of a part. */
  side: [0.01, 3] as const,
  /** How far a part's middle may be from the model's origin. */
  reach: 3,
  /** The biggest a whole model may be, width, height and depth, by where it goes. */
  whole: { floor: [4, 3.5, 4], wall: [3, 2.4, 0.6], on: [1.2, 1, 1.2] } as Record<Mount, [number, number, number]>,
  /** The smallest front a face can be laid on, so it can be read. */
  face: [0.12, 0.08] as const,
  /** Models one agent keeps. */
  models: 40,
  name: 40,
};

/** The record id of an agent's model: `planner:bookcase`. */
export const modelId = (owner: string, name: string) => `${owner}:${name}`;

/** A model's name from what the agent wrote: "My Bookcase" is `my_bookcase`. */
export function modelName(words: unknown): string | undefined {
  if (typeof words !== "string") return undefined;
  const name = words
    .trim()
    .toLowerCase()
    .replace(/^(the|a|an|my)\s+/, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, MODEL_LIMITS.name);
  return /^[a-z0-9]/.test(name) ? name : undefined;
}

/** Why a model can't have this name, or undefined: a kind of thing a room already has would be ambiguous. */
export function nameProblem(name: string): string | undefined {
  const noun = (k: string) => (KINDS[k]?.noun ?? k).toLowerCase().replace(/\s+/g, "_");
  const taken = Object.keys(KINDS).find((k) => k === name || noun(k) === name || `${k}s` === name);
  return taken
    ? `"${name}" is already a kind of thing a room has (${KINDS[taken].noun}). Call it something else.`
    : undefined;
}

// --------------------------------------------------------------------------
// Reading what the agent wrote
// --------------------------------------------------------------------------

const cm = (n: number) => Math.round(n * 100) / 100;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Degrees in (-180, 180], whole. */
function degrees(n: number): number {
  let a = Math.round(n) % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/**
 * Numbers from what a model wrote: a list, or text like "0.5 1 0.5" or
 * "0.5x1x0.5". A single number fills every place when `fill` is set (a cube
 * from one side). Undefined when it isn't `count` finite numbers.
 */
function numbers(value: unknown, count: number, fill = false): number[] | undefined {
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if (typeof value === "number") list = fill ? Array(count).fill(value) : [value];
  else if (typeof value === "string" && value.trim())
    list = value
      .trim()
      .replace(/^\[|\]$/g, "")
      .split(/[\s,x×*]+/)
      .filter(Boolean);
  else return undefined;
  if (list.length === 1 && fill) list = Array(count).fill(list[0]);
  if (list.length !== count) return undefined;
  const out = list.map((v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN));
  return out.every(Number.isFinite) ? out : undefined;
}

const objectOf = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

const textOf = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A list from what a model wrote: a list, or the JSON text of one. */
export function listOf(v: unknown): unknown[] | undefined {
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(v)) return v;
  return objectOf(v) ? [v] : undefined;
}

export function shapeOf(v: unknown): Shape | undefined {
  const t = textOf(v)?.toLowerCase();
  if (!t) return undefined;
  if ((SHAPES as readonly string[]).includes(t)) return t as Shape;
  return SHAPE_WORDS[t] ?? SHAPE_WORDS[t.replace(/s$/, "")];
}

/** The props each kind of face takes. */
const FACE_PROPS: Record<FaceKind, string[]> = {
  card: ["title", "body", "fields"],
  list: ["title", "check"],
  table: ["title", "columns"],
};
/** What says which records a face shows, when written beside its props instead of in `bind`. */
const BIND_KEYS = ["type", "id", "where", "limit"];

/**
 * A part's face from what the agent wrote, or why it isn't one. Its props may
 * be given flat or under `props`; which records it shows, in `bind` or flat
 * beside them; and its title as `name` or `label`. Lifted rather than refused:
 * what was meant is plain.
 */
export function faceFrom(input: unknown): ModelFace | string {
  const raw = objectOf(input);
  if (!raw) return "`face` is an object: {kind, title, bind, ...}.";
  const { kind: kindWords, props: given, bind: bindIn, actions: actionsIn, component: _component, ...flat } = raw;
  const props: Record<string, unknown> = { ...(objectOf(given) ?? {}), ...flat };
  if (bindIn !== undefined && !objectOf(bindIn))
    return "A face's `bind` is an object: {type, id} for a card, {type, where?} for a list.";
  let bind = objectOf(bindIn);
  if (!bind && typeof props.type === "string") bind = {};
  if (bind && bindIn === undefined)
    for (const key of BIND_KEYS)
      if (props[key] !== undefined) {
        bind[key] = props[key];
        delete props[key];
      }
  for (const alias of ["name", "label", "heading"])
    if (props[alias] !== undefined) {
      if (props.title === undefined) props.title = props[alias];
      delete props[alias];
    }
  let kind = textOf(kindWords)?.toLowerCase();
  // What it must be when the agent didn't say: a record by id is a card, ticks a list, columns a table.
  if (!kind) kind = bind?.id !== undefined ? "card" : props.columns ? "table" : bind?.type ? "list" : "card";
  if (!(FACE_KINDS as readonly string[]).includes(kind))
    return `A face shows a card, a list or a table, not a ${kind}: it is used by whoever is in the room, not answered in a conversation.`;
  const takes = FACE_PROPS[kind as FaceKind];
  const stray = Object.keys(props).find((k) => !takes.includes(k));
  if (stray) return `A ${kind} face takes ${takes.join(", ")}; \`${stray}\` isn't one of them.`;
  const face: ModelFace = { kind: kind as FaceKind, props };
  if (kind === "card") {
    if (bind) {
      if (!textOf(bind.type) || !textOf(bind.id))
        return 'A card shows one record: `bind` is {type, id}, e.g. {"type": "note", "id": "fridge"}.';
      face.bind = { type: textOf(bind.type), id: textOf(bind.id) };
    } else if (!textOf(props.title)) return "A card that shows no record needs a `title`.";
  } else {
    if (!bind || !textOf(bind.type))
      return `A ${kind} shows records: give \`bind\` with their type, e.g. {"type": "todo", "where": {"done": false}}.`;
    const where = bind.where === undefined ? undefined : objectOf(bind.where);
    if (bind.where !== undefined && !where) return "`bind.where` is an object of field conditions.";
    const limit = typeof bind.limit === "number" && Number.isFinite(bind.limit) ? Math.floor(bind.limit) : undefined;
    face.bind = { type: textOf(bind.type), ...(where ? { where } : {}), ...(limit && limit > 0 ? { limit } : {}) };
    if (props.check !== undefined) {
      const check = objectOf(props.check);
      const field = check ? textOf(check.field) : textOf(props.check);
      if (!field) return '`check` names the field a tick flips, e.g. {"field": "done"}.';
      props.check = { ...(check ?? {}), field };
    }
    if (props.columns !== undefined) {
      const columns = listOf(props.columns)?.filter((c): c is string => typeof c === "string" && !!c.trim());
      if (!columns?.length) return "`columns` is a list of the field names to show.";
      props.columns = columns.slice(0, 8);
    }
  }
  if (actionsIn !== undefined) {
    if (kind !== "card") return "Only a card has buttons (`actions`); a list is used by ticking.";
    const list = listOf(actionsIn);
    if (!list) return "`actions` is a list of buttons, each {label, patch?}.";
    const actions: Record<string, unknown>[] = [];
    for (const a of list) {
      const action = objectOf(a);
      const label = textOf(action?.label);
      if (!action || !label) return "Each button needs a `label`.";
      const patch = action.patch === undefined ? undefined : objectOf(action.patch);
      if (action.patch !== undefined && !patch)
        return `The "${label}" button's \`patch\` is an object of fields to write.`;
      const effect = textOf(action.effect)?.toLowerCase() ?? (patch ? "state" : "event");
      if (effect !== "state" && effect !== "event")
        return `The "${label}" button can't reply: a face is used by whoever is in the room, not in a conversation. Give it a \`patch\` to write the record, or effect "event" to announce the press.`;
      if (effect === "state" && !patch) return `The "${label}" button writes the record: give it a \`patch\`.`;
      if (effect === "state" && !face.bind && !objectOf(action.ref))
        return `The "${label}" button writes a record, so the card needs \`bind\` (or the button a \`ref\`).`;
      actions.push({
        label,
        effect,
        ...(patch ? { patch } : {}),
        ...(objectOf(action.ref) ? { ref: objectOf(action.ref) } : {}),
        ...(textOf(action.name) ? { name: textOf(action.name) } : {}),
      });
    }
    if (actions.length) face.actions = actions;
  }
  return face;
}

/** One part from what the agent wrote, or why it isn't one. `n` is its number, for the agent. */
export function partFrom(input: unknown, n: number): ModelPart | string {
  const raw = objectOf(input);
  const no = (why: string) => `Part ${n}: ${why}`;
  if (!raw) return no("each part is an object: {shape, size, at, color}.");
  const shape = shapeOf(raw.shape ?? raw.kind);
  if (!shape) return no(`\`shape\` is one of ${SHAPES.join(", ")}.`);
  const size = numbers(raw.size, 3, true);
  if (!size) return no("`size` is width, height and depth in metres, like [0.5, 1, 0.5].");
  const [lo, hi] = MODEL_LIMITS.side;
  if (size.some((s) => s < lo || s > hi)) return no(`each side is ${lo} to ${hi} m.`);
  // A part with no place given stands on the model's floor, in the middle.
  const at = raw.at === undefined ? [0, size[1] / 2, 0] : numbers(raw.at, 3);
  if (!at) return no("`at` is where its middle is, x y z in metres, like [0, 0.5, 0].");
  if (at.some((v) => Math.abs(v) > MODEL_LIMITS.reach))
    return no(`its middle is within ${MODEL_LIMITS.reach} m of the model's origin.`);
  const turnIn = raw.turn ?? raw.rotation ?? raw.rotate;
  const turn =
    turnIn === undefined
      ? undefined
      : typeof turnIn === "number" || (typeof turnIn === "string" && /^-?[\d.]+$/.test(turnIn.trim()))
        ? [0, Number(turnIn), 0]
        : numbers(turnIn, 3);
  if (turnIn !== undefined && (!turn || !turn.every(Number.isFinite)))
    return no("`turn` is degrees about x, y and z, like [0, 45, 0], or one number to turn it round.");
  const colorWords = textOf(raw.color ?? raw.colour);
  const color = colorWords ? parseColor(colorWords) : "#b8b2a7";
  if (!color) return no(`"${colorWords}" isn't a colour I know. Use a name like "teal" or "light pink", or #rrggbb.`);
  const finishWords = textOf(raw.finish ?? raw.material)?.toLowerCase();
  const finish = finishWords === undefined ? undefined : (FINISH_WORDS[finishWords] ?? finishWords);
  if (finish !== undefined && !(FINISHES as readonly string[]).includes(finish))
    return no(`\`finish\` is one of ${FINISHES.join(", ")}.`);
  const part: ModelPart = {
    shape,
    size: size.map(cm) as [number, number, number],
    at: at.map(cm) as [number, number, number],
    color,
  };
  const turned = turn?.map(degrees) as [number, number, number] | undefined;
  if (turned?.some((d) => d !== 0)) part.turn = turned;
  if (finish && finish !== "matte") part.finish = finish as Finish;
  if (raw.face !== undefined && raw.face !== null) {
    if (shape !== "box" && shape !== "plane") return no("a face goes on the front of a box or a plane.");
    const [fw, fh] = MODEL_LIMITS.face;
    if (part.size[0] < fw || part.size[1] < fh)
      return no(`a face needs a front at least ${fw * 100} cm wide and ${fh * 100} cm high to be read.`);
    const face = faceFrom(raw.face);
    if (typeof face === "string") return no(face);
    part.face = face;
  }
  return part;
}

const FINISH_WORDS: Record<string, Finish> = {
  flat: "matte",
  plain: "matte",
  shiny: "glossy",
  gloss: "glossy",
  metallic: "metal",
  chrome: "metal",
  steel: "metal",
  brass: "metal",
  transparent: "glass",
  clear: "glass",
  glow: "glowing",
  lit: "glowing",
  light: "glowing",
  emissive: "glowing",
};

export function mountOf(v: unknown): Mount | undefined {
  const t = textOf(v)?.toLowerCase();
  if (!t) return undefined;
  if (t === "floor" || t === "ground") return "floor";
  if (t === "wall" || t === "on a wall" || t === "on the wall") return "wall";
  if (
    t === "on" ||
    t === "top" ||
    t === "on top" ||
    t === "surface" ||
    t === "table" ||
    t === "desk" ||
    t === "on something"
  )
    return "on";
  return undefined;
}

// --------------------------------------------------------------------------
// The box a model fills
// --------------------------------------------------------------------------

/** A point turned about x, then y, then z, by degrees: as three.js turns a mesh with rotation order XYZ. */
export function turnPoint(
  [x, y, z]: [number, number, number],
  turn?: [number, number, number],
): [number, number, number] {
  if (!turn) return [x, y, z];
  const [a, b, c] = turn.map(rad);
  // Rz first, then Ry, then Rx: the matrix Rx·Ry·Rz applied to the point.
  const x1 = x * Math.cos(c) - y * Math.sin(c);
  const y1 = x * Math.sin(c) + y * Math.cos(c);
  const x2 = x1 * Math.cos(b) + z * Math.sin(b);
  const z2 = -x1 * Math.sin(b) + z * Math.cos(b);
  const y3 = y1 * Math.cos(a) - z2 * Math.sin(a);
  const z3 = y1 * Math.sin(a) + z2 * Math.cos(a);
  return [x2, y3, z3];
}

/** Where a part's corners reach, turned: the smallest box round them, as [min, max]. */
export function partBounds(part: Pick<ModelPart, "shape" | "size" | "at" | "turn">): [number[], number[]] {
  const [w, h, d] = part.size;
  const depth = part.shape === "plane" ? PLANE_DEPTH : d;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const p = turnPoint([(sx * w) / 2, (sy * h) / 2, (sz * depth) / 2], part.turn);
        for (let i = 0; i < 3; i++) {
          const v = p[i] + part.at[i];
          min[i] = Math.min(min[i], v);
          max[i] = Math.max(max[i], v);
        }
      }
  return [min, max];
}

/** How thick a plate is drawn, whatever depth it was given. */
export const PLANE_DEPTH = 0.01;

/** The box every part of a model fits in, as [min, max]. */
export function bounds(parts: Pick<ModelPart, "shape" | "size" | "at" | "turn">[]): [number[], number[]] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const [lo, hi] = partBounds(part);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], lo[i]);
      max[i] = Math.max(max[i], hi[i]);
    }
  }
  return [min, max];
}

/**
 * The parts moved so the model stands where a room expects it: its foot at
 * y = 0, its middle at x = 0, and its middle at z = 0, or for something on a
 * wall, its back at z = 0, against the wall.
 */
export function settled(parts: ModelPart[], mount: Mount): ModelPart[] {
  const [min, max] = bounds(parts);
  // Moved by whole centimetres, the same for every part, so rounding never pulls two parts apart.
  const shift = [-(min[0] + max[0]) / 2, -min[1], mount === "wall" ? -min[2] : -(min[2] + max[2]) / 2].map(cm);
  if (shift.every((s) => s === 0)) return parts;
  return parts.map((p) => ({ ...p, at: p.at.map((v, i) => cm(v + shift[i])) as [number, number, number] }));
}

/** Width, height and depth of the whole, to the centimetre. */
export function sizeOf(parts: ModelPart[]): [number, number, number] {
  const [min, max] = bounds(parts);
  return [0, 1, 2].map((i) => Math.max(0.01, cm(max[i] - min[i]))) as [number, number, number];
}

// --------------------------------------------------------------------------
// A whole model
// --------------------------------------------------------------------------

/** What the agent asked for: the model's own fields, with its parts as it wrote them. */
export interface ModelRequest {
  name: string;
  owner: string;
  mount?: unknown;
  parts: unknown[];
  about?: unknown;
  from?: string;
}

/**
 * A sound model from what the agent wrote, settled to stand where a room
 * expects it, or the first thing wrong with it, as a sentence the agent can
 * act on.
 */
export function modelFrom(req: ModelRequest): Model | string {
  const mount = req.mount === undefined ? "floor" : mountOf(req.mount);
  if (!mount) return '`mount` is where it goes: "floor", "wall", or "on" (on top of a desk, table or shelf).';
  if (!req.parts.length) return "A model needs at least one part.";
  if (req.parts.length > MODEL_LIMITS.parts)
    return `A model has at most ${MODEL_LIMITS.parts} parts; this one has ${req.parts.length}. Fewer, bigger parts read better from across a room anyway.`;
  const parts: ModelPart[] = [];
  for (const [i, raw] of req.parts.entries()) {
    const part = partFrom(raw, i + 1);
    if (typeof part === "string") return part;
    parts.push(part);
  }
  const faces = parts.filter((p) => p.face).length;
  if (faces > MODEL_LIMITS.faces) return `A model has at most ${MODEL_LIMITS.faces} faces; this one has ${faces}.`;
  const placed = settled(parts, mount);
  const size = sizeOf(placed);
  const most = MODEL_LIMITS.whole[mount];
  const over = size.findIndex((s, i) => s > most[i]);
  if (over >= 0) {
    const what = ["wide", "high", "deep"][over];
    return `As made, it is ${size.join(" × ")} m: too ${what} for something ${mount === "on" ? "on a desk or table" : mount === "wall" ? "on a wall" : "on the floor"}, which is at most ${most.join(" × ")} m.`;
  }
  const about = textOf(req.about)?.replace(/\s+/g, " ").slice(0, 160);
  return {
    name: req.name,
    owner: req.owner,
    mount,
    parts: placed,
    size,
    ...(about ? { about } : {}),
    ...(req.from ? { from: req.from } : {}),
  };
}

/** The faces of a model, in order, with the part each is on (from 1). */
export function facesOf(model: Pick<Model, "parts">): { part: number; face: ModelFace }[] {
  return model.parts.flatMap((p, i) => (p.face ? [{ part: i + 1, face: p.face }] : []));
}

/** Whether two faces ask for the same thing, whatever component shows either. */
export function sameFace(a: ModelFace, b: ModelFace): boolean {
  const ask = ({ component: _c, ...rest }: ModelFace) => JSON.stringify(rest);
  return ask(a) === ask(b);
}

/** What to send the `interface` tool to make a face live, or update one already live. */
export function faceArgs(face: ModelFace): Record<string, unknown> {
  return {
    kind: face.kind,
    props: face.props,
    ...(face.bind ? { bind: face.bind } : {}),
    ...(face.actions ? { actions: face.actions } : {}),
  };
}

/**
 * Parts as they would be written again, faces and all, without the component
 * that shows each face: what `copy` starts from.
 */
export function partsToCopy(model: Pick<Model, "parts">): Record<string, unknown>[] {
  return model.parts.map((p) => {
    if (!p.face) return { ...p };
    const { component: _c, ...face } = p.face;
    return { ...p, face };
  });
}

// --------------------------------------------------------------------------
// In words
// --------------------------------------------------------------------------

const vec = (v: number[]) => `(${v.join(", ")})`;

function faceWords(face: ModelFace): string {
  const bind = face.bind ?? {};
  const where = bind.where ? ` where ${JSON.stringify(bind.where)}` : "";
  const check = face.props.check as { field?: string } | undefined;
  if (face.kind === "list")
    return `a list of ${bind.type} records${where}${check?.field ? `; a tick flips ${check.field}` : ""}`;
  if (face.kind === "table") return `a table of ${bind.type} records${where}`;
  const buttons = face.actions?.length ? `, with ${face.actions.map((a) => `"${a.label}"`).join(", ")}` : "";
  return bind.id ? `a card showing ${bind.type} ${bind.id}${buttons}` : `a card, "${face.props.title}"${buttons}`;
}

/** One line about a model, for a list of them. */
export function modelLine(model: Model): string {
  const faces = facesOf(model);
  return `${model.name} (${model.mount}, ${model.size.join(" × ")} m, ${model.parts.length} part${model.parts.length === 1 ? "" : "s"}${faces.length ? `, ${faces.length === 1 ? "a face" : `${faces.length} faces`}` : ""})${model.about ? `: ${model.about}` : ""}`;
}

/** A model in words, part by part, for the agent to change it by. */
export function describeModel(model: Model): string {
  const lines = [
    `${model.name}: ${model.mount === "on" ? "sits on a desk, table or shelf" : model.mount === "wall" ? "hangs on a wall" : "stands on the floor"}, ${model.size.join(" × ")} m.${model.about ? ` ${model.about}` : ""}`,
    "Parts:",
    ...model.parts.map((p, i) => {
      const extra = [
        p.turn ? `turned ${vec(p.turn)}°` : "",
        p.finish && p.finish !== "matte" ? p.finish : "",
        p.face ? `with a face: ${faceWords(p.face)}` : "",
      ].filter(Boolean);
      return `${i + 1}. ${p.shape} ${p.size.join(" × ")} m at ${vec(p.at)}, ${p.color}${extra.length ? `, ${extra.join(", ")}` : ""}`;
    }),
  ];
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// The record's shape, for world state
// --------------------------------------------------------------------------

const triple = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;

/** The `model` type's schema: enough to keep a hand edit from breaking the drawing. The tool checks the rest. */
export const MODEL_SCHEMA = {
  type: "object",
  required: ["name", "owner", "mount", "parts", "size"],
  properties: {
    name: { type: "string", pattern: "^[a-z0-9][a-z0-9_]*$", maxLength: MODEL_LIMITS.name },
    owner: { type: "string", maxLength: 80 },
    mount: { type: "string", enum: MOUNTS },
    size: triple,
    about: { type: "string", maxLength: 160 },
    from: { type: "string", maxLength: 40 },
    parts: {
      type: "array",
      minItems: 1,
      maxItems: MODEL_LIMITS.parts,
      items: {
        type: "object",
        required: ["shape", "size", "at", "color"],
        properties: {
          shape: { type: "string", enum: [...SHAPES] },
          size: { ...triple, items: { type: "number", minimum: MODEL_LIMITS.side[0], maximum: MODEL_LIMITS.side[1] } },
          at: { ...triple, items: { type: "number", minimum: -MODEL_LIMITS.reach, maximum: MODEL_LIMITS.reach } },
          turn: triple,
          color: { type: "string", pattern: "^#[0-9a-f]{6}$" },
          finish: { type: "string", enum: [...FINISHES] },
          face: {
            type: "object",
            required: ["kind", "props"],
            properties: {
              kind: { type: "string", enum: [...FACE_KINDS] },
              props: { type: "object" },
              bind: { type: "object" },
              actions: { type: "array", items: { type: "object" } },
              component: { type: "string", maxLength: 64 },
            },
          },
        },
      },
    },
  },
};

// --------------------------------------------------------------------------
// Ready-made models
// --------------------------------------------------------------------------

/** A record a ready-made model's face needs, made for the agent when it first has the model, if it has none. */
export interface Seed {
  type: string;
  id: string;
  data: Record<string, unknown>;
}

/** A model every agent can place or copy, made for it as its own the first time. */
export interface ReadyModel {
  name: string;
  about: string;
  mount: Mount;
  /** Its parts, as an agent would write them, for this agent. */
  parts: (agent: string) => Record<string, unknown>[];
  /** Records its face shows, made if the agent has none yet. */
  seeds?: (agent: string) => Seed[];
}

const WALNUT = "#6b4a33";
const OAK = "#b5835a";
const IVORY = "#f6f1e3";

export const READY: ReadyModel[] = [
  {
    name: "todo_board",
    about: "A to-do list on the wall: your todo records, ticked off by anyone in the room.",
    mount: "wall",
    parts: () => [
      { shape: "box", size: [1.1, 0.8, 0.04], at: [0, 0.4, 0.02], color: OAK },
      {
        shape: "box",
        size: [1.02, 0.72, 0.012],
        at: [0, 0.4, 0.046],
        color: IVORY,
        face: { kind: "list", title: "To do", check: { field: "done" }, bind: { type: "todo", limit: 12 } },
      },
      { shape: "box", size: [0.7, 0.025, 0.07], at: [0, 0.0125, 0.075], color: OAK },
      { shape: "cylinder", size: [0.018, 0.12, 0.018], at: [-0.12, 0.034, 0.08], turn: [0, 0, 90], color: "#c0392b" },
      { shape: "cylinder", size: [0.018, 0.12, 0.018], at: [0.04, 0.034, 0.08], turn: [0, 0, 90], color: "#2b3a66" },
      { shape: "sphere", size: [0.035, 0.035, 0.035], at: [-0.53, 0.78, 0.05], color: "#c0392b", finish: "glossy" },
      { shape: "sphere", size: [0.035, 0.035, 0.035], at: [0.53, 0.78, 0.05], color: "#c0392b", finish: "glossy" },
    ],
  },
  {
    name: "habit_tracker",
    about: "Today's habits on the wall: your habit records, each ticked when it is done today.",
    mount: "wall",
    parts: () => [
      { shape: "box", size: [0.8, 1.0, 0.04], at: [0, 0.5, 0.02], color: "#9caf88" },
      { shape: "box", size: [0.84, 0.12, 0.05], at: [0, 1.04, 0.025], color: "#2b3a66", finish: "glossy" },
      ...[-0.27, -0.09, 0.09, 0.27].map((x) => ({
        shape: "torus",
        size: [0.05, 0.012, 0.05],
        at: [x, 1.1, 0.03],
        turn: [90, 0, 0],
        color: "#c0c4ca",
        finish: "metal",
      })),
      {
        shape: "box",
        size: [0.72, 0.86, 0.012],
        at: [0, 0.48, 0.046],
        color: "#f5f3ef",
        face: { kind: "list", title: "Today's habits", check: { field: "today" }, bind: { type: "habit", limit: 10 } },
      },
    ],
  },
  {
    name: "notes_card",
    about: "A card on a desk showing a note you keep for the people who visit, with a button to say they've seen it.",
    mount: "on",
    parts: (agent) => [
      { shape: "box", size: [0.44, 0.025, 0.14], at: [0, 0.0125, 0], color: WALNUT },
      {
        shape: "cylinder",
        size: [0.016, 0.22, 0.016],
        at: [0, 0.12, -0.045],
        turn: [-12, 0, 0],
        color: "#c9a227",
        finish: "metal",
      },
      {
        shape: "box",
        size: [0.42, 0.3, 0.012],
        at: [0, 0.18, 0.0],
        turn: [-12, 0, 0],
        color: "#efe6d2",
        face: {
          kind: "card",
          bind: { type: "note", id: notesId(agent) },
          actions: [{ label: "Got it", patch: { seen: true } }],
        },
      },
    ],
    seeds: (agent) => [
      { type: "note", id: notesId(agent), data: { title: "Notes", note: "Nothing yet.", seen: false } },
    ],
  },
];

/** The note a ready-made notes card shows, one per agent. */
export function notesId(agent: string): string {
  return `${agent.replace(/[^a-zA-Z0-9_.-]/g, "-")}-notes`;
}

export function readyModel(name: string): ReadyModel | undefined {
  return READY.find((r) => r.name === name);
}

/**
 * The world-state types the ready-made models show: to-dos, habits and
 * notes, each in its agent's own scope. A deployment that declares a type of
 * the same name in its config keeps its own.
 */
export const FACE_TYPES = [
  {
    name: "todo",
    description: "Something to do. Shown on to-do boards in the 3D world, where people can tick it done.",
    scope: "agent" as const,
    title: "title",
    schema: {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string", maxLength: 200 }, done: { type: "boolean" }, due: { type: "string" } },
    },
  },
  {
    name: "habit",
    description: "A habit to keep. Shown on habit trackers in the 3D world, where people tick it when it's done today.",
    scope: "agent" as const,
    title: "name",
    schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", maxLength: 120 },
        today: { type: "boolean" },
        streak: { type: "number", minimum: 0 },
      },
    },
  },
  {
    name: "note",
    description: "A note an agent keeps for people. Shown on notes cards in the 3D world, which people mark as seen.",
    scope: "agent" as const,
    title: "title",
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", maxLength: 120 },
        note: { type: "string", maxLength: 2000 },
        seen: { type: "boolean" },
      },
    },
  },
];
