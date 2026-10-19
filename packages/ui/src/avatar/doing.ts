/**
 * What an agent's body does about what the agent is doing: the server's
 * `activity` record (from `builtin:activity`) turned into a thing to hold,
 * a sign over its head, a place to go and a line to show. Pure, so the stage
 * only has to draw it.
 */

/** The server's record: what an agent is doing right now. */
export interface AgentActivity {
  agent: string;
  doing: "thinking" | "working" | "talking" | "waiting" | "stuck" | "idle" | "asleep";
  what: string;
  detail?: string;
  tool?: string;
  look?: string;
  with?: string;
  /** Waiting for your OK: the approval request's id, as `/api/approvals` lists it. */
  request?: string;
  /** Waiting on you about a task: its id. */
  task?: string;
  /** Waiting on an answer from you: the question in full, which `detail` cuts short. */
  question?: string;
  /** Waiting on an answer to a question it asked in a conversation: that conversation's session id. */
  session?: string;
  since?: string;
  /** Idle or asleep: the last thing it did, in its status line's words, and when. */
  last?: { what: string; look?: string; at: string };
  /** Asleep: when the pause runs out. */
  until?: string;
  /** Idle or asleep: when it next wakes on its own. */
  next?: string;
}

/**
 * The colour of each doing, wherever it is shown: the light by a home's door,
 * the sign over a head, the dots on the map, an agent's card and menu; the
 * page's styles have them as `--doing-*` (see `DOING_VARS`). Waiting on you is
 * orange and stuck is red: an amber would be taken for a door's brass plate,
 * or the gold of the door under the pointer.
 */
export const DOING_COLORS: Record<AgentActivity["doing"], number> = {
  working: 0x3ddc78,
  thinking: 0x5aa2ff,
  talking: 0x5aa2ff,
  waiting: 0xff9a1f,
  stuck: 0xff4d4d,
  asleep: 0x9d8cff,
  idle: 0x6b7286,
};

/** A doing's colour as a page writes it: `#ff9a1f`. */
export function doingCss(doing: AgentActivity["doing"]): string {
  return `#${DOING_COLORS[doing].toString(16).padStart(6, "0")}`;
}

/** The colours as custom properties, `--doing-waiting` and the rest, set on the stage for everything over it to use. */
export const DOING_VARS: Record<string, string> = Object.fromEntries(
  (Object.keys(DOING_COLORS) as AgentActivity["doing"][]).map((d) => [`--doing-${d}`, doingCss(d)]),
);

/** How a thing is held: up to the eyes, at the ear, in front of the chest, or out ahead. */
export type Hold = "up" | "ear" | "chest" | "out";

/** A sign over the head: thinking dots, a speech bubble, an exclamation, a question, sleep. */
export type Sign = "think" | "talk" | "wait" | "stuck" | "sleep";

/** Where it goes to do something, by what the spot is for: a seat, its desk, or the task board. */
export type Station = "seat" | "desk" | "board";

export interface Behavior {
  /** Something in its hand, by the kind the stage can build. */
  prop?: string;
  hold?: Hold;
  sign?: Sign;
  /** The thinking look: up and away. */
  thinking?: boolean;
  /** Eyes shut, head down. */
  asleep?: boolean;
  /** Somewhere it would rather be while it does this, when it is free to go. */
  station?: Station;
  /** Another agent it turns to, when they are in the room. */
  face?: string;
  /** Stays where it is instead of wandering. */
  stays: boolean;
  /** A status line, and what it is about; nothing while idle. */
  label?: string;
  detail?: string;
  /** A one-off gesture when it starts doing this. */
  gesture?: string;
}

/** The things the stage can put in a hand, and how each is held. */
export const HELD: Record<string, Hold> = {
  camera: "up",
  microphone: "up",
  phone: "chest",
  magnifier: "out",
  laptop: "chest",
  tablet: "chest",
  book: "chest",
  notebook: "chest",
  clipboard: "chest",
  folder: "chest",
  letter: "chest",
  clock: "chest",
};

/**
 * Where work with each thing is done, when there is one free: reading and
 * notes sitting down, tasks at the task board, the rest at the desk. A photo,
 * a recording or a call is made wherever it is; work with nothing in hand is
 * done at the desk.
 */
const STATIONS: Record<string, Station> = {
  book: "seat",
  notebook: "seat",
  laptop: "desk",
  tablet: "desk",
  magnifier: "desk",
  folder: "desk",
  letter: "desk",
  clipboard: "board",
};

const IDLE: Behavior = { stays: false };

export function behaviorFor(a: AgentActivity | undefined): Behavior {
  if (!a) return IDLE;
  const label = { label: a.what, ...(a.detail ? { detail: a.detail } : {}) };
  switch (a.doing) {
    case "thinking":
      // Work is done at the desk: a turn starting sends it there, when it is free to go.
      return { ...label, sign: "think", thinking: true, stays: true, station: "desk" };
    case "working": {
      const look = a.look && HELD[a.look] ? a.look : undefined;
      return {
        ...label,
        stays: true,
        ...(look ? { prop: look, hold: HELD[look] } : {}),
        ...(look ? (STATIONS[look] ? { station: STATIONS[look] } : {}) : { station: "desk" as const }),
      };
    }
    case "talking":
      // Face to face when the other one is here; on the phone when they are not.
      return { ...label, sign: "talk", stays: true, prop: "phone", hold: "ear", ...(a.with ? { face: a.with } : {}) };
    case "waiting":
      return { ...label, sign: "wait", stays: true, gesture: "wave" };
    case "stuck":
      return { ...label, sign: "stuck", stays: true, gesture: "shrug" };
    case "asleep":
      return { ...label, sign: "sleep", asleep: true, station: "seat", stays: true };
    default:
      return IDLE;
  }
}

/**
 * What is actually in its hand, where it is: no laptop at a desk — it types
 * there — and no phone to someone standing in the same room.
 */
export function heldFor(
  b: Behavior | undefined,
  at: { spotActivity?: string; partnerHere: boolean },
): { prop?: string; hold?: Hold } {
  if (!b?.prop || !b.hold) return {};
  if (b.prop === "laptop" && at.spotActivity === "type") return {};
  if (b.hold === "ear" && at.partnerHere) return {};
  return { prop: b.prop, hold: b.hold };
}

/**
 * The nearest free spot for a station, or none when it is already at one or
 * all are taken. A seat is a spot to sit at, a desk one to type at, and the
 * board the spot the page adds in front of a task board (`for: "board"`). In
 * a room with no board free, tasks are seen to at the desk.
 */
export function stationSpot<S extends { id: string; at: [number, number]; activity?: string; for?: string }>(
  station: Station,
  spots: S[],
  here: { x: number; z: number; spotActivity?: string; spot?: string },
  taken: Set<string>,
): S | undefined {
  const fitsFor = (st: Station) => (s: { activity?: string; for?: string }) =>
    st === "board" ? s.for === "board" : s.activity === (st === "seat" ? "sit" : "type");
  const boardFree = spots.some((s) => fitsFor("board")(s) && !taken.has(s.id));
  const use: Station = station === "board" && !boardFree ? "desk" : station;
  const fits = fitsFor(use);
  const at = here.spot ? spots.find((s) => s.id === here.spot) : undefined;
  if (at ? fits(at) : use !== "board" && here.spotActivity === (use === "seat" ? "sit" : "type")) return undefined;
  const distance = (s: S) => Math.hypot(s.at[0] - here.x, s.at[1] - here.z);
  return spots.filter((s) => fits(s) && !taken.has(s.id)).sort((a, b) => distance(a) - distance(b))[0];
}

/** Two behaviours that look the same: nothing to redo. */
export function sameBehavior(a: Behavior, b: Behavior): boolean {
  const keys: (keyof Behavior)[] = [
    "prop",
    "hold",
    "sign",
    "thinking",
    "asleep",
    "station",
    "face",
    "stays",
    "label",
    "detail",
  ];
  return keys.every((k) => a[k] === b[k]);
}

/**
 * A colour of its own for an agent's body, from its name, so several agents
 * sharing one model can be told apart at a glance. The default agent keeps the
 * model's own colours. Hue in degrees.
 */
export function hueFor(agent: string): number | undefined {
  if (!agent || agent === "default") return undefined;
  let h = 2166136261;
  for (let i = 0; i < agent.length; i++) {
    h ^= agent.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}
