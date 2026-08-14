/**
 * The one thing on this page that talks to the server.
 *
 * Every other module is a pure renderer: it is handed a scene and returns
 * pixels. That split is what lets the stage, the HUD, the feed and the
 * scoreboard be written independently and never import each other — and it is
 * why a bug in the map cannot stop the health bars updating.
 *
 * Polling rather than streaming, for the same reason the developer viewer does:
 * the thing being watched writes to a file at human speed — about fifteen
 * seconds an agent turn — so a page that checks twice a second is
 * indistinguishable from live and cannot wedge, desync or need reconnect logic.
 *
 * ## This module never writes anything anywhere
 *
 * It issues three GETs and nothing else. The broadcast has to be incapable of
 * changing what it is watching, or a run made while somebody was watching would
 * not be comparable with one made in private — see `docs/broadcast-viewer.md`.
 */

import type {
  BroadcastState,
  Derived,
  FeedItem,
  History,
  Milestone,
  NarrationLine,
  RunEvent,
  Said,
  Scene,
} from "./types.js";

/** Every event the trace can carry, as the page reads them. */
type TraceEvent =
  | RunEvent
  | { kind: "round"; at: number; round: number; day?: number; announce?: string }
  | { kind: "turn"; at: number; turn: number; round: number; agent: string; room: string }
  | {
      kind: "call";
      at: number;
      turn: number;
      agent?: string;
      tool: string;
      args: Record<string, unknown>;
      result: string;
      refused: boolean;
    }
  | { kind: "post"; at: number; turn: number; agent?: string; room: string; to: string[]; body: string }
  | { kind: "state"; at: number; turn: number; round: number; snapshot: { scene?: Scene } & Record<string, unknown> }
  | { kind: "progress"; at: number; round: number; milestones: Milestone[]; facts?: unknown }
  | { kind: "end"; at: number; reason?: string; turns: number };

interface EventsResponse {
  reset?: boolean;
  events?: TraceEvent[];
  live?: boolean;
  file?: string;
}

interface NarrationResponse {
  events?: Array<{ text?: string; round?: number; at: number }>;
  total?: number;
}

const POLL_MS = 700;
const HISTORY_MS = 20_000;

/** A file nobody has appended to for this long is a finished run, not a live one. */
const STALE_MS = 20_000;

/** How much transcript the feed can ever need. Older lines are dropped. */
const FEED_CAP = 400;

export const state: BroadcastState = {
  /** The `run` event: scenario, model, agents, rooms, milestones. */
  run: null as RunEvent | null,
  /** The newest `scene` from a `state` event — see docs/broadcast-viewer.md. */
  scene: null as Scene | null,
  /** The scene before that, so a renderer can diff and animate the change. */
  previous: null as Scene | null,
  /** Round number, and how many the roster gets. */
  round: 0,
  rounds: 0,
  /** Everything worth putting in a feed, newest last. */
  feed: [] as FeedItem[],
  /** Speech, newest last: `{ agent, room, body, turn, at }`. */
  said: [] as Said[],
  /** Milestones as of the last `progress` event. */
  milestones: [] as Milestone[],
  /** Narration lines from the sidecar, newest last. */
  narration: [] as NarrationLine[],
  /** Past runs from `/history`. */
  history: null as History | null,
  /** Is the trace still being appended to? */
  live: false,
  /** Has the run written its `end` event? */
  ended: false,
  endedBecause: null as string | null,
  /** Which trace is being watched. */
  file: "",
  /** Bumped every time anything changed, so renderers can skip idle frames. */
  version: 0,
  /** Bumped only when a new round arrived — the cue for a scene transition. */
  roundVersion: 0,
};

const listeners = new Set<(state: BroadcastState) => void>();

/** Subscribe to changes. Returns an unsubscribe function. */
export function onChange(fn: (state: BroadcastState) => void): () => boolean {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  state.version += 1;
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      // A renderer that throws must not take the poll loop down with it, or one
      // bad frame ends the broadcast.
      console.error("renderer failed", err);
    }
  }
}

/** Fold one trace event into the store. */
function absorb(event: TraceEvent): void {
  switch (event.kind) {
    case "run":
      state.run = event;
      state.rounds = event.rounds ?? 0;
      break;

    case "round":
      state.round = event.round ?? 0;
      state.roundVersion += 1;
      if (event.announce) {
        state.feed.push({ type: "round", round: state.round, text: event.announce, at: event.at });
      }
      break;

    case "post":
      state.said.push({
        agent: event.agent ?? "?",
        room: event.room,
        body: event.body,
        turn: event.turn,
        at: event.at,
      });
      state.feed.push({ type: "say", agent: event.agent ?? "?", text: event.body, at: event.at });
      break;

    case "call":
      state.feed.push({
        type: "call",
        agent: event.agent ?? "?",
        tool: event.tool,
        args: event.args,
        result: event.result,
        refused: !!event.refused,
        at: event.at,
      });
      break;

    case "state": {
      const scene = event.snapshot?.scene;
      if (scene) {
        state.previous = state.scene;
        state.scene = scene;
      }
      break;
    }

    case "progress":
      state.milestones = event.milestones ?? [];
      break;

    case "end":
      state.ended = true;
      state.endedBecause = event.reason ?? null;
      state.feed.push({ type: "end", text: event.reason ?? "the run ended", at: event.at });
      break;
  }
}

let cursor = 0;
let narrationCursor = 0;

async function pollEvents() {
  const res = await fetch(`/events?since=${cursor}`, { cache: "no-store" });
  const data = (await res.json()) as EventsResponse;

  // A shorter file than we have already read means a different run started
  // under the same name. Start over rather than splicing two runs together.
  if (data.reset) {
    cursor = 0;
    state.feed = [];
    state.said = [];
    state.scene = null;
    state.previous = null;
    state.milestones = [];
    state.narration = [];
    state.ended = false;
    state.endedBecause = null;
    narrationCursor = 0;
  }

  state.live = !!data.live;
  state.file = data.file ?? "";

  const events = data.events ?? [];
  for (const event of events) absorb(event);
  cursor += events.length;

  if (state.feed.length > FEED_CAP) state.feed.splice(0, state.feed.length - FEED_CAP);
  if (state.said.length > FEED_CAP) state.said.splice(0, state.said.length - FEED_CAP);

  if (events.length) announce();
}

async function pollNarration() {
  try {
    const res = await fetch(`/narration?since=${narrationCursor}`, { cache: "no-store" });
    const data = (await res.json()) as NarrationResponse;
    const events = data.events ?? [];
    if (!events.length) return;
    for (const event of events) {
      state.narration.push({ text: event.text ?? "", round: event.round ?? state.round, at: event.at });
    }
    narrationCursor += events.length;
    announce();
  } catch {
    // No narrator running is the normal case, not an error.
  }
}

async function pollHistory() {
  try {
    const scenario = state.run?.scenario ? `?scenario=${encodeURIComponent(state.run.scenario)}` : "";
    const res = await fetch(`/history${scenario}`, { cache: "no-store" });
    state.history = (await res.json()) as History;
    announce();
  } catch {
    // A scoreboard that cannot be read is not a reason to stop the show.
  }
}

/**
 * Derived facts every renderer wants and none should compute twice.
 *
 * Kept here rather than in each module because "is the party in trouble" needs
 * to mean exactly one thing across the stage, the HUD and the director — a
 * broadcast whose panels disagree about whether a fight is going badly reads as
 * broken even when every panel is individually right.
 */
export function derive(scene: Scene | null): Derived | null {
  if (!scene) return null;
  const party = scene.party ?? [];
  const alive = party.filter((p) => !p.dead);
  const enemies = scene.enemies ?? [];
  const health = alive.length ? alive.reduce((sum, p) => sum + p.hp / Math.max(1, p.maxHp), 0) / alive.length : 0;
  return {
    alive,
    fallen: party.filter((p) => p.dead),
    enemies,
    inCombat: scene.phase === "combat" && enemies.length > 0,
    /** 0 when everybody is dying, 1 when nobody is hurt. */
    health,
    /** Somebody is one hit from going down. */
    dire: alive.some((p) => p.hp / Math.max(1, p.maxHp) < 0.25),
    /** A boss is present, which is worth a different treatment everywhere. */
    boss: enemies.find((e) => e.boss) ?? null,
    /** Something is winding up and can still be stopped. */
    telegraph: enemies.find((e) => e.telegraph) ?? null,
    progress: scene.horizon ? Math.min(1, (scene.tick ?? 0) / scene.horizon) : 0,
  };
}

export function start() {
  const tick = async () => {
    try {
      await pollEvents();
      await pollNarration();
    } catch {
      // The server going away mid-run should pause the page, not break it.
    }
    setTimeout(tick, POLL_MS);
  };
  tick();

  pollHistory();
  setInterval(pollHistory, HISTORY_MS);
}

export { STALE_MS };
