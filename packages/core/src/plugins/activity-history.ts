/**
 * What agents did lately, for the widgets on the walls of the 3D world: a
 * feed of turns, tool uses, posts and finished tasks, newest first, and
 * numbers by the hour for its charts (tokens and model calls, turns, tasks
 * done, time by activity).
 *
 * All of it is read from what the server already keeps (`token_usage`,
 * `messages`, `project_tasks`), except time by activity: activity records are
 * only true while they last and keep no history, so that is tallied here as
 * they change, since the process started, and says so (`since`).
 *
 * Hours are sent as UTC ISO hours, so the page sums them into days on its own
 * clock. Pure apart from the database it is handed; `activity.ts` wires it to
 * HTTP.
 */
import type Database from "better-sqlite3";

/** One thing an agent did, as the feed lists it. */
export interface FeedItem {
  /** The same for the same thing on every read, so the page can keep it steady. */
  id: string;
  /** A turn it answered, a tool it used, something it posted in a room, a task it finished. */
  kind: "turn" | "tool" | "post" | "done";
  agent: string;
  /** In a few words: what it said, what the tool was for, what it posted, the task. */
  text: string;
  /** More, when there is: what a search was for, which room. */
  detail?: string;
  at: string;
  /** The room a post went to, as the agent named it in the call. */
  room?: string;
  /** The task it finished. */
  task?: string;
}

/** How a tool call looks from outside, as the activity plugin words it. */
export type Describe = (tool: string, args: Record<string, unknown>) => { what: string; detail?: string };

/** Hours the feed looks back over. */
export const FEED_HOURS = 48;
/** Things the feed sends at most. */
export const FEED_KEPT = 80;
/** Messages read for the feed: the newest, enough for a busy day. */
const MESSAGES_READ = 600;
/** Characters of what an agent said that the feed keeps: a glimpse, not the transcript. */
const TEXT_CHARS = 140;

/** SQLite's `datetime('now')` text, as an ISO time. */
export function isoOf(db: string): string {
  return `${db.replace(" ", "T")}Z`;
}

/** A line of text as the feed shows it: the first line with words in it, cut short. */
export function glimpse(text: unknown, chars = TEXT_CHARS): string {
  if (typeof text !== "string") return "";
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  return line.length > chars ? `${line.slice(0, chars - 1)}…` : line;
}

/** A tool call as the messages table keeps it. */
interface StoredCall {
  name?: unknown;
  arguments?: unknown;
}

function callsOf(json: string | null): { name: string; args: Record<string, unknown> }[] {
  if (!json) return [];
  try {
    const calls = JSON.parse(json) as StoredCall[];
    if (!Array.isArray(calls)) return [];
    return calls.flatMap((c) => {
      if (typeof c?.name !== "string") return [];
      let args = c.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      return [{ name: c.name, args: args && typeof args === "object" ? (args as Record<string, unknown>) : {} }];
    });
  } catch {
    return [];
  }
}

/** Which agent each session that spent tokens lately belongs to: the loop records it with every call. */
function sessionAgents(db: Database.Database, hours: number): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT session_id AS session, MAX(COALESCE(agent, '')) AS agent
         FROM token_usage
        WHERE created_at >= datetime('now', ?) AND session_id IS NOT NULL
        GROUP BY session_id`,
    )
    .all(`-${hours} hours`) as { session: string; agent: string }[];
  return new Map(rows.map((r) => [r.session, r.agent || "default"]));
}

/**
 * The feed: the newest things agents did, newest first. A turn is a reply an
 * agent finished; a tool use, each call it made (a `room` post or direct
 * message is a post, with what it said); a finished task, one marked done.
 */
export function recentFeed(
  db: Database.Database,
  describe: Describe,
  opts: { hours?: number; limit?: number } = {},
): FeedItem[] {
  const hours = opts.hours ?? FEED_HOURS;
  const agents = sessionAgents(db, hours);
  const out: FeedItem[] = [];
  const messages = db
    .prepare(
      `SELECT id, session_id AS session, content, tool_calls AS calls, created_at AS at
         FROM messages
        WHERE role = 'assistant' AND compaction_summary_for IS NULL AND created_at >= datetime('now', ?)
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(`-${hours} hours`, MESSAGES_READ) as {
    id: number;
    session: string;
    content: string | null;
    calls: string | null;
    at: string;
  }[];
  for (const m of messages) {
    const agent = agents.get(m.session);
    if (!agent) continue;
    const at = isoOf(m.at);
    const calls = callsOf(m.calls);
    for (const [i, call] of calls.entries()) {
      const id = `m${m.id}:${i}`;
      const action = typeof call.args.action === "string" ? call.args.action : "";
      if (call.name === "room" && (action === "post" || action === "dm")) {
        const said = glimpse(call.args.body ?? call.args.message ?? call.args.text);
        const room = typeof call.args.room === "string" ? call.args.room : undefined;
        // Who a message went to, under any of the names the room tool takes it by.
        const to = [call.args.agent, call.args.to, call.args.member].find((v): v is string => typeof v === "string");
        out.push({
          id,
          kind: "post",
          agent,
          text: said || (action === "dm" ? "sent a message" : "posted"),
          ...(action === "dm" && to ? { detail: `to ${to}` } : {}),
          at,
          ...(room ? { room } : {}),
        });
        continue;
      }
      const look = describe(call.name, call.args);
      out.push({ id, kind: "tool", agent, text: look.what, ...(look.detail ? { detail: look.detail } : {}), at });
    }
    const said = glimpse(m.content);
    if (!calls.length && said) out.push({ id: `m${m.id}`, kind: "turn", agent, text: said, at });
  }
  const done = db
    .prepare(
      `SELECT id, title, assignee, updated_at AS at
         FROM project_tasks
        WHERE status = 'done' AND updated_at >= datetime('now', ?)
        ORDER BY updated_at DESC
        LIMIT 40`,
    )
    .all(`-${hours} hours`) as { id: string; title: string; assignee: string | null; at: string }[];
  for (const t of done)
    out.push({
      id: `t${t.id}`,
      kind: "done",
      agent: t.assignee || "default",
      text: glimpse(t.title),
      at: isoOf(t.at),
      task: t.id,
    });
  return out
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id, undefined, { numeric: true }))
    .slice(0, opts.limit ?? FEED_KEPT);
}

// --------------------------------------------------------------------------
// Numbers by the hour
// --------------------------------------------------------------------------

/** One agent's numbers in one hour. */
export interface HourRow {
  /** The hour's start, as a UTC ISO time: "2026-10-19T14:00:00Z". */
  hour: string;
  agent: string;
}

export interface Stats {
  /** Days looked back over. */
  days: number;
  tokens: (HourRow & { prompt: number; completion: number; calls: number })[];
  /** Turns: messages that started one (a person's, a room's, a wake's). */
  turns: (HourRow & { n: number })[];
  /** Tasks marked done, by the hour they last changed. */
  done: (HourRow & { n: number })[];
  /** Time spent at each activity, in milliseconds, by what it was. */
  time: (HourRow & { what: string; ms: number })[];
  /** Since when time by activity has been tallied: before this, nothing was counted. */
  since: string;
}

/** Days the charts look back over at most. */
export const STATS_DAYS = 14;
const HOUR = "strftime('%Y-%m-%dT%H:00:00Z', created_at)";

/** Tokens, turns and tasks done by the hour, for the last `days` days, from the database. */
export function hourlyStats(db: Database.Database, days: number): Omit<Stats, "time" | "since"> {
  const window = `-${days} days`;
  const tokens = db
    .prepare(
      `SELECT ${HOUR} AS hour, COALESCE(agent, 'default') AS agent,
              COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion,
              COUNT(*) AS calls
         FROM token_usage
        WHERE created_at >= datetime('now', ?)
        GROUP BY 1, 2`,
    )
    .all(window) as Stats["tokens"];
  // Turns are counted in the sessions that spent tokens in the window, which the index on a message's session
  // finds without reading every message there is.
  const agents = sessionAgents(db, days * 24);
  const turns = new Map<string, HourRow & { n: number }>();
  const asked = db
    .prepare(
      `SELECT session_id AS session, ${HOUR} AS hour, COUNT(*) AS n
         FROM messages
        WHERE role = 'user' AND created_at >= datetime('now', ?)
          AND session_id IN (SELECT DISTINCT session_id FROM token_usage WHERE created_at >= datetime('now', ?))
        GROUP BY 1, 2`,
    )
    .all(window, window) as { session: string; hour: string; n: number }[];
  for (const r of asked) {
    const agent = agents.get(r.session) ?? "default";
    const key = `${r.hour}\n${agent}`;
    const was = turns.get(key);
    if (was) was.n += r.n;
    else turns.set(key, { hour: r.hour, agent, n: r.n });
  }
  const done = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:00:00Z', updated_at) AS hour, COALESCE(assignee, 'default') AS agent, COUNT(*) AS n
         FROM project_tasks
        WHERE status = 'done' AND updated_at >= datetime('now', ?)
        GROUP BY 1, 2`,
    )
    .all(window) as Stats["done"];
  return { days, tokens, turns: [...turns.values()], done };
}

// --------------------------------------------------------------------------
// Time by activity
// --------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** The start of the UTC hour `ms` falls in, as an ISO time. */
export function hourOf(ms: number): string {
  return `${new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13)}:00:00Z`;
}

/** A stretch of time an agent spent at something: what, and from when. */
export interface Ongoing {
  agent: string;
  what: string;
  since: number;
}

/**
 * Time spent at each activity, by agent and hour, as activity records end.
 * A stretch that runs over the hour is split at it, so an hour never holds
 * more than an hour. Kept in memory for `days` days.
 */
export class TimeTally {
  private readonly hours = new Map<string, Map<string, number>>();
  readonly since: number;

  constructor(
    now = Date.now(),
    private readonly days = STATS_DAYS,
  ) {
    this.since = now;
  }

  /** Count `from` to `to` toward `what` for `agent`. */
  add(agent: string, what: string, from: number, to: number): void {
    const start = Math.max(from, this.since);
    if (!(to > start)) return;
    for (let t = start; t < to; ) {
      const edge = Math.min(to, (Math.floor(t / HOUR_MS) + 1) * HOUR_MS);
      const hour = hourOf(t);
      let row = this.hours.get(hour);
      if (!row) {
        row = new Map();
        this.hours.set(hour, row);
      }
      const key = `${agent}\n${what}`;
      row.set(key, (row.get(key) ?? 0) + (edge - t));
      t = edge;
    }
    this.prune(to);
  }

  /** Every hour's tally, with what is going on now counted up to `now`, without keeping that. */
  rows(ongoing: Ongoing[], now = Date.now()): Stats["time"] {
    const copy = new TimeTally(this.since, this.days);
    for (const [hour, row] of this.hours) copy.hours.set(hour, new Map(row));
    for (const o of ongoing) copy.add(o.agent, o.what, o.since, now);
    const out: Stats["time"] = [];
    for (const [hour, row] of [...copy.hours].sort(([a], [b]) => a.localeCompare(b)))
      for (const [key, ms] of row) {
        const [agent = "", what = ""] = key.split("\n");
        out.push({ hour, agent, what, ms: Math.round(ms) });
      }
    return out;
  }

  private prune(now: number): void {
    const oldest = hourOf(now - this.days * 24 * HOUR_MS);
    for (const hour of this.hours.keys()) if (hour < oldest) this.hours.delete(hour);
  }
}

/** What a stretch of an activity counts as: the tool's words while working, otherwise what it was doing. */
export function timeKey(a: { doing: string; what: string }): string | undefined {
  switch (a.doing) {
    case "working":
      return a.what;
    case "thinking":
    case "talking":
    case "stuck":
      return a.doing;
    case "waiting":
      return "waiting on you";
    default:
      // Idle and asleep are most of every day: counted, they would drown the rest.
      return undefined;
  }
}
