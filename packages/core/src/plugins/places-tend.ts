/**
 * Tending: now and then, an agent looks at its room in the light of what it
 * has been doing, and changes it if something should show that. Rooms come
 * to reflect what agents do because the agents decide it, not because the
 * building is drawn from their names.
 *
 * Off unless asked for, in the places plugin's config:
 *
 * ```yaml
 * plugins:
 *   - module: builtin:places
 *     config:
 *       tend: { every: 24h, agents: [planner, writer] }   # or agents: all
 * ```
 *
 * Each agent's turn comes round once every `every`, at a time of its own: its
 * name sets where in the interval it falls, so forty agents on a day are
 * spread across the day rather than woken together, and a restart moves
 * nobody's time. A turn is one short message: what the agent has done in the
 * last interval, counted from what the runtime already keeps (the tool calls
 * in its sessions, the tasks it finished, the rooms it talked in, the photos
 * it took), its room as `look` describes it, and an invitation to change the
 * room with the `place` tool, or leave it as it is. An agent that has done
 * nothing since isn't woken: there is nothing new for its room to show.
 *
 * One tend runs at a time, so never two for one agent, and none while agents
 * are paused or the agent's own switch has it asleep: a turn that comes round
 * then is skipped, not saved up, so lifting a pause doesn't wake everyone at
 * once. This file is the timing and the words; `places.ts` wires them to the
 * runtime. The directory's upkeep turn (`directory-upkeep.ts`) runs on the
 * same timing, as a tender of its own kind.
 */
import type Database from "better-sqlite3";
import type { ExploratoryState } from "../db/exploratory-queries.js";
import { makeRoomSessionKey } from "../rooms/watcher.js";
import { parseWindow } from "../subscriptions/keys.js";
import type { TaskBackend } from "../tasks/interface.js";
import { seeded } from "./places-rooms.js";

/** The tend pass as configured: how often, and for whom. */
export interface TendSettings {
  everyMs: number;
  /** Agents by name, or every agent with a body. */
  agents: string[] | "all";
}

/** The shortest `every`: often enough to try it out, and no oftener. */
export const TEND_FLOOR_MS = 60_000;

/**
 * The plugin config's `tend`, read: undefined when there is none (it is off),
 * or why it can't be used, in words for the log. `name` is the key it was
 * given under, for those words: other turns on an interval (the directory's
 * upkeep) read their settings the same way.
 */
export function parseTend(raw: unknown, name = "tend"): TendSettings | string | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return `${name} is { every: "24h", agents: [names] | "all" }.`;
  const { every, agents } = raw as { every?: unknown; agents?: unknown };
  const everyMs = typeof every === "string" || typeof every === "number" ? parseWindow(String(every)) : undefined;
  if (!everyMs) return `${name}.every is a length of time like "24h" or "30 minutes", not ${JSON.stringify(every)}.`;
  if (everyMs < TEND_FLOOR_MS) return `${name}.every is at least a minute.`;
  if (agents === "all") return { everyMs, agents };
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => typeof a !== "string" || !a.trim()))
    return `${name}.agents is a list of agent names, or "all".`;
  return { everyMs, agents: [...new Set(agents.map((a) => (a as string).trim()))] };
}

/**
 * Where in each interval an agent's turn falls, in ms from the interval's
 * start: the same for a name, always. Each kind of turn has times of its own,
 * so an agent's tend and its upkeep on the same interval don't fall together.
 */
export function offsetOf(agent: string, everyMs: number, kind = "tend"): number {
  return Math.floor(seeded(`${kind}\n${agent}`)() * everyMs);
}

/** When an agent's next turn is: the first of its times strictly after `after`. Its times are `every` apart, offset by its name. */
export function nextTend(agent: string, everyMs: number, after: number, kind = "tend"): number {
  const phase = offsetOf(agent, everyMs, kind);
  return (Math.floor((after - phase) / everyMs) + 1) * everyMs + phase;
}

/** An interval in words, as "in the last …" reads it: "day", "12 hours", "30 minutes", "2 days". */
export function everyWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const count = (n: number, unit: string) => (n === 1 ? unit : `${n} ${unit}s`);
  if (minutes % 1440 === 0) return count(minutes / 1440, "day");
  if (minutes % 60 === 0) return count(minutes / 60, "hour");
  return count(minutes, "minute");
}

// --------------------------------------------------------------------------
// What an agent has done
// --------------------------------------------------------------------------

/** What an agent has done lately, as the runtime can tell cheaply. */
export interface Done {
  /** Tool calls by tool, most used first. */
  tools: [string, number][];
  /** Tasks assigned to it that it finished: how many, and the titles of a few. */
  tasks: { count: number; titles: string[] };
  /** The rooms it talked in, by name. */
  rooms: string[];
  /** Photos it took with the `place` tool. */
  photos: number;
}

/** Whether there is anything at all for a room to show. */
export const quiet = (done: Done) => !done.tools.length && !done.tasks.count && !done.rooms.length;

/** Tools named one by one in a summary; the rest are a count. */
const TOOLS_NAMED = 6;
/** Task titles quoted; the rest are a count. */
const TITLES_NAMED = 3;
const TITLE_CHARS = 60;

const list = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s: string) => (s.length > TITLE_CHARS ? `${s.slice(0, TITLE_CHARS - 1)}…` : s);

/** What an agent did, a line a kind, for its tend message. Nothing for what it didn't do. */
export function doneLines(done: Done): string[] {
  const lines: string[] = [];
  const calls = done.tools.reduce((n, [, c]) => n + c, 0);
  if (calls) {
    const named = done.tools.slice(0, TOOLS_NAMED).map(([tool, n]) => `${tool} ${n}`);
    const rest = done.tools.slice(TOOLS_NAMED).reduce((n, [, c]) => n + c, 0);
    lines.push(
      `- called tools ${plural(calls, "time")}: ${named.join(", ")}${rest ? `, and ${rest} other calls` : ""}`,
    );
  }
  if (done.tasks.count) {
    const quoted = done.tasks.titles.slice(0, TITLES_NAMED).map((t) => `"${clip(t)}"`);
    const more = done.tasks.count - quoted.length;
    lines.push(
      `- finished ${plural(done.tasks.count, "task")}${quoted.length ? `: ${quoted.join(", ")}${more > 0 ? `, and ${more} more` : ""}` : ""}`,
    );
  }
  if (done.rooms.length) lines.push(`- talked in ${list(done.rooms.map((r) => `#${r}`))}`);
  if (done.photos) lines.push(`- took ${plural(done.photos, "photo")}`);
  return lines;
}

/**
 * The one message a tend sends: what the agent did, its room as `look` says
 * it, and an invitation to change the room or leave it. No word to answer
 * with: an agent with nothing to change simply stops.
 */
export function tendMessage(at: {
  every: string;
  done: Done;
  /** Its home, as the `place` tool's look describes it. */
  room: string;
  /** The place its body is in, when that isn't home. */
  away?: string;
  /** The rooms it talks in, whose meeting rooms it can change too. */
  meetings: string[];
}): string {
  return [
    "Time to look at your room in the light of what you've been doing. People see it in the 3D world.",
    "",
    `In the last ${at.every}, you:`,
    ...doneLines(at.done),
    "",
    "Your room, as the place tool's look shows it:",
    at.room,
    "",
    "If something you've been doing should show in the room, change it with the place tool: add, move, restyle or remove things, or give the room a theme or a purpose. If it already fits, leave it as it is.",
    ...(at.away
      ? [`You're in ${at.away} at the moment: go home with the place tool before you change your room.`]
      : []),
    ...(at.meetings.length
      ? [
          `The meeting rooms of ${list(at.meetings.map((r) => `#${r}`))} are yours to change too, with the other members: go there with the place tool first.`,
        ]
      : []),
    "Nobody reads a reply here; what you change in the room is what people see.",
  ].join("\n");
}

/** A time as SQLite writes `datetime('now')`: what `created_at` columns compare against. */
export const dbTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** A time from a column or an ISO string; SQLite's own form is UTC without saying so. */
export const parseTime = (at: string) =>
  Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(" ", "T")}Z` : at);

/**
 * What an agent has done since `since`, from what the runtime keeps anyway:
 * the model calls it made say which sessions it ran in; the assistant turns
 * in those sessions say which tools it called; a room's session says it
 * talked there; and the task backend says which of its tasks are done. One
 * session, its own tend's, is left out: changing its room isn't news for it.
 */
export async function gatherDone(at: {
  db: Database.Database;
  agent: string;
  since: number;
  /** The rooms it is a member of, by ref and name. */
  rooms: { ref: string; name: string }[];
  tasks?: TaskBackend;
  /** Its tend session's key, left out. */
  skip?: string;
}): Promise<Done> {
  const since = dbTime(at.since);
  // The default agent's model calls carry no name, or "default" when the config has an `agents.default`.
  const who = at.agent === "default" ? "(t.agent IS NULL OR t.agent = ?)" : "t.agent = ?";
  const sessions = at.db
    .prepare(
      `SELECT DISTINCT s.id AS id, s.key AS key FROM token_usage t JOIN sessions s ON s.id = t.session_id
       WHERE ${who} AND t.created_at >= ?`,
    )
    .all(at.agent, since) as { id: string; key: string | null }[];
  const ran = sessions.filter((s) => !at.skip || s.key !== at.skip);

  const counts = new Map<string, number>();
  let photos = 0;
  if (ran.length) {
    const rows = at.db
      .prepare(
        `SELECT tool_calls FROM messages WHERE session_id IN (${ran.map(() => "?").join(", ")})
         AND role = 'assistant' AND tool_calls IS NOT NULL AND created_at >= ?`,
      )
      .all(...ran.map((s) => s.id), since) as { tool_calls: string }[];
    for (const row of rows) {
      let calls: unknown;
      try {
        calls = JSON.parse(row.tool_calls);
      } catch {
        continue;
      }
      if (!Array.isArray(calls)) continue;
      for (const call of calls as { name?: unknown; arguments?: unknown }[]) {
        if (typeof call?.name !== "string") continue;
        counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
        const args = call.arguments as { action?: unknown } | undefined;
        if (call.name === "place" && args?.action === "photo") photos++;
      }
    }
  }
  const keys = new Set(ran.map((s) => s.key));
  const rooms = at.rooms.filter((r) => keys.has(makeRoomSessionKey(r.ref, at.agent))).map((r) => r.name);

  let tasks = { count: 0, titles: [] as string[] };
  if (at.tasks) {
    try {
      const { tasks: found } = await at.tasks.query({
        assignee: at.agent,
        status: at.tasks.statuses.done,
        orderBy: "updated_at",
        limit: 20,
      });
      // Filtered here, not by the backend: each writes its times its own way.
      const finished = found.filter((t) => parseTime(t.updated_at) >= at.since);
      tasks = { count: finished.length, titles: finished.map((t) => t.title) };
    } catch {
      // A backend that can't be asked right now leaves the tasks out; the rest still stands.
    }
  }
  return {
    tools: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    tasks,
    rooms,
    photos,
  };
}

// --------------------------------------------------------------------------
// When
// --------------------------------------------------------------------------

/**
 * Why an agent with nothing to do is asleep, or null when it is awake: the
 * global pause, or an online agent's own switch from the Agents page. A turn
 * on an interval is skipped while it is.
 */
export function whyAsleep(at: {
  paused: boolean;
  own: Pick<ExploratoryState, "enabled" | "paused_until"> | null;
  now: Date;
}): string | null {
  if (at.paused) return "agents are paused";
  if (!at.own) return null;
  if (!at.own.enabled) return "switched off";
  if (at.own.paused_until && new Date(at.own.paused_until) > at.now) return "paused";
  return null;
}

export interface TenderOptions {
  settings: TendSettings;
  /** Every agent the tend could be for: those with bodies. */
  agents: () => string[];
  /** Why an agent can't be tended now (paused, asleep, no place tool), or null when it can. */
  unready: (agent: string) => string | null;
  /** Tend one agent, given the start of what its message covers. "quiet" when there was nothing to show. */
  tend: (agent: string, since: number) => Promise<"woken" | "quiet">;
  now?: () => number;
  log?: (line: string) => void;
  /** Where a failed turn is said. */
  warn?: (line: string) => void;
  /**
   * What kind of turn this tender runs, "tend" unless said: it sets each
   * agent's times, and keys the turn in flight. Another plugin's turn on an
   * interval (the directory's upkeep) is a tender of its own kind.
   */
  kind?: string;
  /** The log's words for how a turn went, a tend's unless given. */
  said?: { woken: (agent: string) => string; quiet: (agent: string) => string; failed: (agent: string) => string };
}

/** How often due tends are looked for. */
export const TEND_TICK_MS = 30_000;

/**
 * Turns running right now, by any tender of any kind or by hand, keyed by
 * kind and agent. A reload stops the old tender and starts a new one while a
 * turn the old one began may still be going: this is what keeps the new one
 * from starting another beside it. Every kind shares it, so a tend and an
 * upkeep never run at once either.
 */
const inFlight = new Set<string>();

const flightKey = (kind: string, agent: string) => `${kind}\n${agent}`;

/** Whether a turn of `kind` is running for `agent` now, from a tender or by hand. */
export function busy(kind: string, agent: string): boolean {
  return inFlight.has(flightKey(kind, agent));
}

/**
 * Run one turn now, outside any tender's times: a person asked for it. It
 * counts as in flight while it runs, so no tender starts a turn beside it.
 * Undefined, without running, when that agent's turn of that kind is already
 * going.
 */
export function runNow<T>(kind: string, agent: string, run: () => Promise<T>): Promise<T> | undefined {
  const key = flightKey(kind, agent);
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  return run().finally(() => inFlight.delete(key));
}

const TEND_SAID = {
  woken: (agent: string) => `${agent} tended its room`,
  quiet: (agent: string) => `${agent} had nothing new, so wasn't woken to tend its room`,
  failed: (agent: string) => `${agent}'s tend failed`,
};

/** Keeps each agent's next tend, and runs them one at a time as they come due. */
export class Tender {
  private readonly due = new Map<string, number>();
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;
  private readonly kind: string;

  constructor(private readonly opts: TenderOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line) => console.log(`[places] ${line}`));
    this.warn = opts.warn ?? ((line) => console.warn(`[places] ${line}`));
    this.kind = opts.kind ?? "tend";
  }

  /** The agents tended, of those there are. */
  private wanted(): string[] {
    const all = this.opts.agents();
    const { agents } = this.opts.settings;
    return agents === "all" ? all : agents.filter((a) => all.includes(a));
  }

  /** When an agent's next tend is, once it has one. */
  dueAt(agent: string): number | undefined {
    return this.due.get(agent);
  }

  /** The tend running now, if one is: what a test waits for. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * One look at who is due. Nothing starts while a tend is still going, this
   * tender's or one a reload replaced: one at a time. Otherwise each due agent
   * is moved on to its next time as it is looked at, so a slow turn is never
   * started twice; one that can't be tended now is skipped, and the first that
   * can is tended, while the rest wait for the next look.
   */
  tick(): void {
    const now = this.now();
    const { everyMs } = this.opts.settings;
    const { kind } = this;
    const said = this.opts.said ?? TEND_SAID;
    const wanted = this.wanted();
    for (const agent of wanted) if (!this.due.has(agent)) this.due.set(agent, nextTend(agent, everyMs, now, kind));
    for (const agent of [...this.due.keys()]) if (!wanted.includes(agent)) this.due.delete(agent);
    if (this.running || inFlight.size) return;
    const ready = [...this.due.entries()].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]);
    for (const [agent, at] of ready) {
      this.due.set(agent, nextTend(agent, everyMs, now, kind));
      const why = this.opts.unready(agent);
      if (why) {
        this.log(`${agent}'s ${kind} skipped: ${why}`);
        continue;
      }
      // What it covers is the interval that just ended, wherever in it the look came.
      const since = at - everyMs;
      const key = flightKey(kind, agent);
      inFlight.add(key);
      this.running = this.opts
        .tend(agent, since)
        .then(
          (how) => this.log(how === "quiet" ? said.quiet(agent) : said.woken(agent)),
          (err: unknown) => this.warn(`${said.failed(agent)}: ${(err as Error).message}`),
        )
        .finally(() => {
          inFlight.delete(key);
          this.running = undefined;
        });
      return;
    }
  }

  start(): void {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), TEND_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
