/**
 * Activity: what each agent is doing right now, as world state.
 *
 * One `activity` record per agent (id = the agent's name), kept by the
 * built-in `memory` provider because it is only true while it lasts. It says
 * whether the agent is thinking, working with a tool, talking to another agent,
 * waiting on you, stuck, idle or asleep, in a few words a status line can show
 * ("searching the web", "talking to planner"), with a `look` the page can draw
 * — a prop to hold: a camera, a laptop, a book — and who else is involved.
 * Waiting on you, it says on what — the approval request, or the task — so a
 * page that shows the wait can answer it there.
 *
 * Everything comes off the event bus: turns starting and ending, tool calls,
 * approvals, questions for a person, stalls, the pause switch. Nothing here
 * runs a model or touches a turn. Which tool looks like what is a table below,
 * and a deployment adds its own tools or overrides ours in plugin config:
 *
 * ```yaml
 * plugins:
 *   - module: builtin:activity
 *     config:
 *       tools:
 *         flights: { what: "looking up flights", look: "tablet" }
 *         place.photo: { what: "taking a picture", look: "camera" }   # tool.action
 * ```
 *
 * Asleep reuses the switches that already exist: the global pause, and an
 * online agent's own enabled/paused state from the Agents page, with when a
 * pause runs out.
 *
 * While an agent is idle or asleep, its record also says the last thing it
 * did and when (`last`), so a page can show what it was up to, and when it
 * next wakes on its own (`next`): a wake it booked with the `schedule` tool,
 * or its next turn when it runs on its own.
 *
 * It also keeps a `speech` record per agent: the last thing it said, in a
 * room or to another agent directly, for the page to show in a bubble over
 * its head. Only people can read those — the type is closed to agents — so a
 * direct message stays as private from other agents as it was. `speech:
 * false` in plugin config keeps none.
 *
 * Free when unused: with no avatar configured — nothing to draw it on — it
 * registers nothing.
 */

import { isStallStop, stallReasonOf } from "../agent/loop.js";
import { type ExploratoryState, getExploratoryState } from "../db/exploratory-queries.js";
import type { EventBus, RuntimeEventPayload, Subscription } from "../events.js";
import { nextOwnTurn, type OwnTurns, ownTurnsOf } from "../exploratory/next-turn.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import { fromDbTime, ScheduleStore } from "../schedules/store.js";
import type { StateCaller, StateService } from "../state/service.js";
import { runtimeTimeProvider } from "../time/provider.js";
import {
  hourlyStats,
  type Ongoing,
  recentFeed,
  STATS_DAYS,
  type Stats,
  TimeTally,
  timeKey,
} from "./activity-history.js";
import { anyAvatar } from "./places.js";

export const ACTIVITY_TYPE = "activity";
export const SPEECH_TYPE = "speech";

export const meta: PluginMeta = {
  name: "Activity",
  description:
    "Keeps an `activity` world-state record per agent — thinking, working, talking, waiting on you, stuck, idle or asleep — for pages that show what agents are doing.",
  registers: [
    { kind: "stateType", id: ACTIVITY_TYPE },
    { kind: "stateType", id: SPEECH_TYPE },
    { kind: "httpRoutes", id: "activity" },
  ],
};

export type Doing = "thinking" | "working" | "talking" | "waiting" | "stuck" | "idle" | "asleep";

/** The record's data. */
export interface Activity {
  agent: string;
  doing: Doing;
  /** A few words for a status line. */
  what: string;
  /** What it is about, when there is something worth saying: a search, a question. */
  detail?: string;
  /** The tool it is using. */
  tool?: string;
  /** Something the page can draw it holding. An open string: camera, laptop, book, phone… */
  look?: string;
  /** Another agent it is dealing with. */
  with?: string;
  /**
   * Waiting for your OK: the approval request's id, which `GET /api/approvals`
   * lists while it can be answered there (`POST /api/approvals/:id`).
   */
  request?: string;
  /** Waiting on you about a task: its id. */
  task?: string;
  /** Waiting on an answer from you: the question in full, which `detail` cuts short. */
  question?: string;
  /** Waiting on an answer to a question it asked in a conversation: that conversation's session id. */
  session?: string;
  /** When it started doing this. */
  since: string;
  /** Idle or asleep: the last thing it did, and when: a tool it used, or a turn it took without one. */
  last?: LastDone;
  /** Asleep: when the pause runs out, when it is known. */
  until?: string;
  /** Idle or asleep: when it next wakes on its own, when it will. */
  next?: string;
}

/** Something an agent did, in the words its status line used ("searching the web"), and when it started. */
export interface LastDone {
  what: string;
  look?: string;
  at: string;
}

/** A `speech` record: the last thing an agent said, and to whom. */
export interface Speech {
  agent: string;
  text: string;
  /** Who it was said to; nobody in particular when empty. */
  to?: string[];
  /** The room it was said in, as `<backend>:<id>`; absent for a direct message. */
  room?: string;
  /** When to show it: a reply is timed to follow the message it answers. */
  at: string;
}

/** Characters of a line kept: a bubble is a glimpse, not the transcript. */
const SPEECH_CHARS = 280;

/** How a tool call looks from outside. */
export interface Look {
  what: string;
  look?: string;
  detail?: string;
  /** Another agent the call is to: the agent is talking rather than working. */
  with?: string;
}

const DETAIL_CHARS = 80;

function words(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS - 1)}…` : line;
}

/** Characters of a question kept whole: enough to answer it from, not a transcript. */
const QUESTION_CHARS = 2000;

/** A question as asked, for a page that answers it: its own line breaks kept, cut only when very long. */
function whole(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const text = v.trim();
  if (!text) return undefined;
  return text.length > QUESTION_CHARS ? `${text.slice(0, QUESTION_CHARS - 1)}…` : text;
}

function host(v: unknown): string | undefined {
  try {
    return typeof v === "string" ? new URL(v).hostname : undefined;
  } catch {
    return undefined;
  }
}

function talkingTo(name: string | undefined, what: string, look?: string): Look {
  return name ? { what: `${what} ${name}`, with: name, ...(look ? { look } : {}) } : { what: "messaging someone" };
}

/** A room a tool call names, as "#name": by its name when the call gave its `<backend>:<id>`. */
type RoomWords = (room: unknown) => string | undefined;

/**
 * A `room` call, by what it does: talking to one agent, saying something in
 * a room, or reading one and keeping quiet. Only saying something is said as
 * speaking, so an agent that read a room and passed isn't remembered as
 * having talked there.
 */
function roomLook(a: Record<string, unknown>, room: RoomWords): Look {
  const where = room(a.room);
  switch (a.action) {
    case "dm":
      return talkingTo(words(a.agent ?? a.to ?? a.member), "talking to");
    case "post":
      return { what: where ? `posting in ${where}` : "posting in a room", look: "phone" };
    case "update":
      return { what: where ? `editing a post in ${where}` : "editing a post", look: "phone" };
    case "react":
      return { what: where ? `reacting in ${where}` : "reacting in a room", look: "phone" };
    case "read":
    case "pass":
      return {
        what: where ? `reading ${where}` : a.action === "read" ? "reading its rooms" : "reading a room",
        look: "phone",
      };
    case "create":
      return { what: "opening a room" };
    default:
      return { what: "looking after rooms" };
  }
}

/** The built-in tools, and the plugins' that ship here. A tool not listed is "using <tool>". */
const LOOKS: Record<string, (args: Record<string, unknown>, room: RoomWords) => Look> = {
  web_search: (a) => ({ what: "searching the web", look: "magnifier", detail: words(a.query) }),
  web_fetch: (a) => ({ what: "reading a page", look: "tablet", detail: host(a.url) }),
  browser: () => ({ what: "browsing", look: "tablet" }),
  browser_mediator: () => ({ what: "browsing", look: "tablet" }),
  read: () => ({ what: "reading", look: "book" }),
  extract_document: () => ({ what: "reading a document", look: "book" }),
  documents: () => ({ what: "going through documents", look: "book" }),
  write: () => ({ what: "writing", look: "laptop" }),
  edit: () => ({ what: "editing", look: "laptop" }),
  exec: () => ({ what: "running commands", look: "laptop" }),
  coding_agent: () => ({ what: "coding", look: "laptop" }),
  claude_code: () => ({ what: "coding", look: "laptop" }),
  md_to_pdf: () => ({ what: "making a PDF", look: "laptop" }),
  recall: (a) => ({ what: "remembering", look: "book", detail: words(a.query) }),
  memory: () => ({ what: "taking notes", look: "notebook" }),
  facts: () => ({ what: "taking notes", look: "notebook" }),
  collections: () => ({ what: "sorting notes", look: "notebook" }),
  tasks: () => ({ what: "updating tasks", look: "clipboard" }),
  task_query: () => ({ what: "checking tasks", look: "clipboard" }),
  projects: () => ({ what: "checking projects", look: "clipboard" }),
  state: () => ({ what: "checking records", look: "clipboard" }),
  schedule: () => ({ what: "setting a reminder", look: "clock" }),
  interface: () => ({ what: "showing you something", look: "clipboard" }),
  ask_user: (a) => ({ what: "asking you something", look: "phone", detail: words(a.question) }),
  notify_owner: () => ({ what: "messaging you", look: "phone" }),
  speak: () => ({ what: "recording", look: "microphone" }),
  delegate: (a) => talkingTo(words(a.agent), "handing work to", "folder"),
  room: roomLook,
  place: (a) =>
    a.action === "photo"
      ? { what: String(a.view).toLowerCase() === "selfie" ? "taking a selfie" : "taking a photo", look: "camera" }
      : a.action === "go" || a.action === "new"
        ? { what: "going somewhere", detail: words(a.place ?? a.name) }
        : a.action === "look" || a.action === "places"
          ? { what: "looking around" }
          : { what: "rearranging the room" },
  body: (a) =>
    a.action === "go"
      ? { what: "going somewhere", detail: words(a.to) }
      : a.action === "emote"
        ? { what: "making a gesture", detail: words(a.emote) }
        : a.action === "look"
          ? { what: "looking itself over" }
          : { what: "changing how it looks" },
};

export interface ActivityOptions {
  events: EventBus;
  state: () => StateService;
  /** Every agent there is a record for, from the start. */
  agents: () => string[];
  /** Why an agent is asleep when it has nothing to do, and until when if that is known; null when it is awake. */
  asleep: (agent: string) => string | { why: string; until?: string } | null;
  /** When an agent next wakes on its own, as an ISO time; null when nothing will wake it. */
  next?: (agent: string) => string | null;
  /** A room's name, by its `<backend>:<id>`, for saying where an agent talked or read. */
  roomName?: (ref: string) => string | undefined;
  /** Deployment overrides: `tool` or `tool.action` → how it looks. */
  tools?: Record<string, Partial<Look>>;
  /** Changes within this many ms are written as one, so a quick tool call doesn't flicker. 0 writes each. */
  settleMs?: number;
  /** Keep what agents say, in rooms and to each other. Default on. */
  speech?: boolean;
  /** Where time spent at each activity is counted as records change; none counts nothing. */
  tally?: TimeTally;
  now?: () => Date;
}

interface Tracked {
  /** Sessions with a turn running. */
  turns: Set<string>;
  /** The tool call in flight, by its id. */
  tool?: { id: string; name: string; look: Look };
  /** A person is being asked to approve a call: which tool, and the request's id. */
  approval?: { tool: string; request: string };
  /**
   * Something it asked a person, unanswered, and the task it is about when it
   * is about one: shown until its next turn starts, or the task moves on.
   */
  asked?: { what: string; detail?: string; task?: string; question?: string; session?: string };
  /** Its last turn stalled or failed: shown until the next one starts. */
  stuck?: string;
  /** The agent whose message started the turn it is in. */
  from?: string;
  /** The room whose messages woke it for the turn it is in. */
  room?: string;
  /** A tool was used in the turn it is in. */
  used?: boolean;
  /** It said something in a room with the room tool in the turn it is in. */
  posted?: boolean;
  /** The room a turn without a tool was for, until the room says whether it spoke there. */
  heard?: string;
  /** The last thing it did. */
  last?: LastDone;
}

const CALLER: StateCaller = { actor: { kind: "plugin", name: "activity" }, source: { surface: "events" } };

/** Follows the bus and keeps one record per agent saying what it is doing. */
export class ActivityTracker {
  private readonly tracked = new Map<string, Tracked>();
  private readonly written = new Map<string, Activity>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly chains = new Map<string, Promise<void>>();
  /** A dm or delegation just sent: whose turn it will start, and who sent it. */
  private readonly incoming = new Map<string, string>();
  private readonly subs: Subscription[] = [];
  private readonly now: () => Date;
  private stopped = false;

  constructor(private readonly opts: ActivityOptions) {
    this.now = opts.now ?? (() => new Date());
    const on = opts.events;
    this.subs.push(
      on.on("agent.turn_started", (e) => this.turnStarted(e)),
      on.on("agent.turn_ended", (e) => this.turnEnded(e)),
      on.onWaterfall("agent.pre_tool_use", async (p, next) => {
        const out = await next(p);
        if (!out.deny) this.toolStarted(out);
        return out;
      }),
      on.on("agent.post_tool_use", (e) => this.toolEnded(e)),
      on.on("approval.requested", (e) =>
        this.change(nameOf(e.agent), (t) => (t.approval = { tool: e.tool, request: e.requestId })),
      ),
      // Only the request it is waiting on: a call on another path that nobody was asked about (`unattended`)
      // leaves it waiting.
      on.on("approval.settled", (e) =>
        this.change(nameOf(e.agent), (t) => {
          if (t.approval?.request === e.requestId) t.approval = undefined;
        }),
      ),
      on.on("task.needs_human", (e) =>
        this.change(nameOf(e.agentName), (t) => {
          t.asked = { what: "needs you", detail: words(e.message), task: e.taskId, question: whole(e.message) };
        }),
      ),
      // A question asked from a task run is about that task: the page can answer it there.
      on.on("question.asked", (e) => {
        const agent = e.taskId ? this.agentIn(e.sessionId) : undefined;
        if (agent && e.taskId) {
          const task = e.taskId;
          this.change(agent, (t) => {
            t.asked = { what: "has a question for you", detail: words(e.question), task, question: whole(e.question) };
          });
        }
      }),
      // The task it was waiting on you about moved on, out of blocked: answered, wherever that was done. Only a
      // move out of blocked: a task that needs you without being blocked (the verify gate's, left done) moves
      // to get there, and that move may reach this after the escalation it set off.
      on.on("task.transitioned", (e) => {
        if (e.from !== "blocked" || e.to === "blocked") return;
        for (const [agent, t] of this.tracked)
          if (t.asked?.task === e.taskId) this.change(agent, (u) => (u.asked = undefined));
      }),
      on.on("agent.stalled", (e) => this.change(nameOf(e.agentName), (t) => (t.stuck = stuckWords(e.stallReason)))),
      // The room a turn is for, so a turn that uses no tool can say after whether it spoke there or only read it.
      on.on("room.woke", (e) => {
        this.track(nameOf(e.agent)).room = e.roomRef;
      }),
      on.on("room.turn_ended", (e) => this.change(nameOf(e.agent), (t) => this.roomTurnEnded(t, e))),
      on.on("agents.pause_changed", () => this.refresh()),
    );
    if (opts.speech !== false) {
      this.subs.push(
        on.on("room.message", (e) => {
          // Only an agent has a body to say it with; a label that isn't an agent's name is a person.
          if (e.speaker && this.opts.agents().includes(e.speaker)) this.say(e.speaker, e.body, e.to, e.roomRef);
        }),
        on.on("agent.messaged", (e) => {
          this.say(e.from, e.body, [e.to]);
          // The answer follows the message, after about as long as it takes to read it.
          const readMs = Math.min(6000, Math.max(1500, 1200 + 50 * e.body.length));
          this.say(e.to, e.reply, [e.from], undefined, readMs);
        }),
      );
    }
  }

  /** Record what an agent said, for a bubble over its head. */
  private say(agent: string, text: string, to: string[] = [], room?: string, laterMs = 0): void {
    const line = text.replace(/\s+/g, " ").trim();
    if (!line || this.stopped) return;
    const speech: Speech = {
      agent,
      text: line.length > SPEECH_CHARS ? `${line.slice(0, SPEECH_CHARS - 1)}…` : line,
      ...(to.length ? { to } : {}),
      ...(room ? { room } : {}),
      at: new Date(this.now().getTime() + laterMs).toISOString(),
    };
    this.queue(`${SPEECH_TYPE}:${agent}`, () =>
      this.opts.state().put(CALLER, { type: SPEECH_TYPE, id: agent, scope: "global", data: { ...speech } }),
    );
  }

  /** Writes for one record, in order: a later write never lands under an earlier one. */
  private queue(key: string, write: () => Promise<unknown>, failed?: () => void): void {
    const prior = this.chains.get(key) ?? Promise.resolve();
    const chain = prior.then(write).then(
      () => {},
      (err: unknown) => {
        failed?.();
        console.warn(`[activity] could not record ${key}: ${(err as Error).message}`);
      },
    );
    this.chains.set(key, chain);
  }

  /** Write every agent's starting record. */
  start(): Promise<void> {
    for (const agent of this.opts.agents()) this.schedule(agent, 0);
    return this.settled();
  }

  /** Look again at whether idle agents are asleep: for switches that announce nothing. */
  refresh(): void {
    for (const agent of new Set([...this.opts.agents(), ...this.tracked.keys()])) this.schedule(agent);
  }

  /** Resolves once every write so far has landed. */
  async settled(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  stop(): void {
    // What agents are in the middle of counts up to now: a tracker started after this one starts afresh.
    const now = this.now().getTime();
    for (const o of this.ongoing()) this.opts.tally?.add(o.agent, o.what, o.since, now);
    // Counted once: a stopped tracker has nothing ongoing, so a route still holding it can't count it again.
    this.written.clear();
    this.stopped = true;
    for (const sub of this.subs) sub.dispose();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** What each agent is in the middle of that counts toward time by activity, and since when. */
  ongoing(): Ongoing[] {
    return [...this.written.values()].flatMap((a) => {
      const what = timeKey(a);
      const since = Date.parse(a.since);
      return what && Number.isFinite(since) ? [{ agent: a.agent, what, since }] : [];
    });
  }

  /** How a tool call looks from outside, in the words a status line uses: for a feed of what agents did. */
  looks(tool: string, args: Record<string, unknown>): Look {
    return this.lookOf(tool, args);
  }

  /** What an agent is doing, from what has been heard. */
  current(agent: string): Omit<Activity, "since"> {
    const t = this.tracked.get(agent);
    const base = { agent };
    if (t?.approval)
      return {
        ...base,
        doing: "waiting",
        what: "waiting for your OK",
        tool: t.approval.tool,
        request: t.approval.request,
      };
    if (t && t.turns.size > 0) {
      if (t.tool) {
        const { name, look } = t.tool;
        return {
          ...base,
          doing: look.with ? "talking" : "working",
          what: look.what,
          tool: name,
          ...(look.detail ? { detail: look.detail } : {}),
          ...(look.look ? { look: look.look } : {}),
          ...(look.with ? { with: look.with } : {}),
        };
      }
      if (t.from) return { ...base, doing: "talking", what: `talking to ${t.from}`, with: t.from };
      return { ...base, doing: "thinking", what: "thinking" };
    }
    if (t?.asked) {
      const { what, detail, task, question, session } = t.asked;
      return {
        ...base,
        doing: "waiting",
        what,
        ...(detail ? { detail } : {}),
        ...(task ? { task } : {}),
        ...(question ? { question } : {}),
        ...(session ? { session } : {}),
      };
    }
    if (t?.stuck) return { ...base, doing: "stuck", what: "stuck", detail: t.stuck };
    const next = this.opts.next?.(agent) ?? undefined;
    const ahead = next ? { next } : {};
    const sleep = this.opts.asleep(agent);
    if (sleep) {
      const { why, until } = typeof sleep === "string" ? { why: sleep, until: undefined } : sleep;
      return { ...base, doing: "asleep", what: "asleep", detail: why, ...(until ? { until } : {}), ...ahead };
    }
    return { ...base, doing: "idle", what: "idle", ...ahead };
  }

  /** The agent with a turn running in a session: whoever asked something from it. */
  private agentIn(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    for (const [agent, t] of this.tracked) if (t.turns.has(sessionId)) return agent;
    return undefined;
  }

  private track(agent: string): Tracked {
    let t = this.tracked.get(agent);
    if (!t) {
      t = { turns: new Set() };
      this.tracked.set(agent, t);
    }
    return t;
  }

  private change(agent: string, edit: (t: Tracked) => void): void {
    edit(this.track(agent));
    this.schedule(agent);
  }

  private turnStarted(e: RuntimeEventPayload<"agent.turn_started">): void {
    const agent = nameOf(e.agent);
    this.change(agent, (t) => {
      // A new turn is the answer to whatever it was waiting on, or a fresh start after a stall.
      if (t.turns.size === 0) {
        t.asked = undefined;
        t.stuck = undefined;
        t.used = false;
        t.posted = false;
        t.heard = undefined;
        t.from = this.incoming.get(agent);
        this.incoming.delete(agent);
      }
      t.turns.add(e.sessionId);
    });
  }

  private turnEnded(e: RuntimeEventPayload<"agent.turn_ended">): void {
    this.change(nameOf(e.agent), (t) => {
      t.turns.delete(e.sessionId);
      if (t.turns.size > 0) return;
      // A turn that used no tool still did something: it talked to whoever started it, or to you. One a room woke
      // waits for the room to say whether it spoke there (`roomTurnEnded`).
      if (!t.used) {
        if (t.room && !t.from) t.heard = t.room;
        else t.last = { what: t.from ? `talking to ${t.from}` : "replying", at: this.now().toISOString() };
      }
      t.tool = undefined;
      t.from = undefined;
      t.room = undefined;
      if (e.error) t.stuck = `something went wrong: ${words(e.error) ?? "an error"}`;
      else if (e.stop && isStallStop(e.stop)) t.stuck = stuckWords(stallReasonOf(e.stop));
    });
  }

  private toolStarted(p: {
    sessionId: string;
    agent?: string;
    tool: string;
    toolUseId: string;
    args: Record<string, unknown>;
  }): void {
    const agent = nameOf(p.agent);
    const look = this.lookOf(p.tool, p.args);
    // The agent on the other end of a dm or delegation will start a turn: it is talking too.
    if (look.with) this.incoming.set(look.with, agent);
    // What it did last waits for the call to have worked (`toolEnded`): a photo that couldn't be taken, or a call the
    // loop turned back, was never done.
    this.change(agent, (t) => {
      t.tool = { id: p.toolUseId, name: p.tool, look };
    });
    // Asked in a conversation, which is where an answer to it goes; one asked from a task run is about the task
    // (`question.asked`), which takes the conversation off again.
    if (p.tool === "ask_user")
      this.track(agent).asked = {
        what: "has a question for you",
        detail: look.detail,
        question: whole(p.args.question),
        session: p.sessionId,
      };
  }

  private toolEnded(e: RuntimeEventPayload<"agent.post_tool_use">): void {
    const agent = nameOf(e.agent);
    const done = this.lookOf(e.tool, e.args);
    this.change(agent, (t) => {
      if (t.tool?.id === e.toolUseId) t.tool = undefined;
      // Done, it is what the agent did; failed, the turn goes on as if it hadn't tried, and a reply after it is the
      // last thing it did.
      if (e.success) {
        t.used = true;
        if (e.tool === "room" && (e.args.action === "post" || e.args.action === "update")) t.posted = true;
        t.last = { what: done.what, ...(done.look ? { look: done.look } : {}), at: this.now().toISOString() };
      }
      if (e.tool === "ask_user" && !e.success) t.asked = undefined;
      // A question sent as a choice, form or confirmation waits for the person, like ask_user.
      if (e.tool === "interface" && e.success && e.args.action === "send" && ASKS.has(String(e.args.kind))) {
        const props = (e.args.props ?? {}) as Record<string, unknown>;
        const asking = props.question ?? props.title ?? props.summary;
        t.asked = {
          what: "has a question for you",
          detail: words(asking),
          question: whole(asking),
          session: e.sessionId,
        };
      }
    });
    if (done.with && this.incoming.get(done.with) === agent) this.incoming.delete(done.with);
  }

  /**
   * A room turn over, and whether anything reached the room. A reply goes
   * out as the turn ends, after any tool, so it is the last thing the agent
   * did, unless the room tool already said it. A turn that used no tool and
   * said nothing only read the room.
   */
  private roomTurnEnded(t: Tracked, e: RuntimeEventPayload<"room.turn_ended">): void {
    const where = this.where(e.rooms.length === 1 ? e.rooms[0] : t.heard);
    const at = this.now().toISOString();
    if (e.posted && !t.posted) t.last = { what: where ? `talking in ${where}` : "talking in a room", at };
    else if (!e.posted && t.heard) t.last = { what: where ? `reading ${where}` : "reading a room", at };
    t.heard = undefined;
    t.posted = false;
  }

  /** A room as "#name", by its name when given its `<backend>:<id>`. */
  private readonly where: RoomWords = (room) => {
    const given = words(room)?.replace(/^#/, "");
    if (!given) return undefined;
    let name: string | undefined;
    try {
      name = words(this.opts.roomName?.(given));
    } catch {
      // A store that can't say keeps the name the call gave.
    }
    return `#${name ?? given}`;
  };

  private lookOf(tool: string, args: Record<string, unknown>): Look {
    const action = typeof args.action === "string" ? args.action : "";
    const own = (action && this.opts.tools?.[`${tool}.${action}`]) || this.opts.tools?.[tool];
    const builtIn = LOOKS[tool]?.(args, this.where) ?? { what: `using ${tool}` };
    return own ? { ...builtIn, ...own } : builtIn;
  }

  private schedule(agent: string, delay = this.opts.settleMs ?? 250): void {
    if (this.stopped) return;
    if (this.pending.has(agent)) return;
    if (delay <= 0) {
      this.flush(agent);
      return;
    }
    this.pending.set(
      agent,
      setTimeout(() => {
        this.pending.delete(agent);
        this.flush(agent);
      }, delay),
    );
  }

  private flush(agent: string): void {
    const now = this.current(agent);
    // What it did last is news once it has stopped: while it works, what it is doing says more, and costs no writes.
    const last = now.doing === "idle" || now.doing === "asleep" ? this.tracked.get(agent)?.last : undefined;
    const next = { ...now, ...(last ? { last } : {}) };
    const was = this.written.get(agent);
    if (was && same(was, next)) return;
    // Only a change in what it is doing is a new start: a new `next` keeps its `since`. Idle with something new done
    // last is a new start too: a turn too short to be written between two idle records still ended its idle time,
    // so it is idle from now, not since before it did it.
    const didMore = next.doing === "idle" && !!next.last && next.last.at !== was?.last?.at;
    const since = was && sameDoing(was, next) && !didMore ? was.since : this.now().toISOString();
    // A stretch at something has ended: counted toward time by activity.
    const ended = was && since !== was.since ? timeKey(was) : undefined;
    if (was && ended) this.opts.tally?.add(agent, ended, Date.parse(was.since), Date.parse(since));
    const record: Activity = { ...next, since };
    this.written.set(agent, record);
    this.queue(
      `${ACTIVITY_TYPE}:${agent}`,
      () => this.opts.state().put(CALLER, { type: ACTIVITY_TYPE, id: agent, scope: "global", data: { ...record } }),
      // Forget it, so the next change tries again rather than thinking this landed.
      () => {
        if (this.written.get(agent) === record) this.written.delete(agent);
      },
    );
  }
}

/** Interface kinds that ask a person something and wait for the answer. */
const ASKS = new Set(["choice", "form", "confirm"]);

/** An unnamed turn is the default agent's. */
function nameOf(agent: string | undefined): string {
  return agent || "default";
}

function stuckWords(reason: string | null | undefined): string {
  if (reason === "max tool rounds reached") return "ran out of steps";
  if (reason === "repeated identical tool calls") return "going round in circles";
  return reason || "stuck";
}

/** Two records that say the agent is doing the same thing. */
function sameDoing(a: Omit<Activity, "since">, b: Omit<Activity, "since">): boolean {
  const keys = [
    "agent",
    "doing",
    "what",
    "detail",
    "tool",
    "look",
    "with",
    "request",
    "task",
    "question",
    "session",
  ] as const;
  return keys.every((k) => a[k] === b[k]);
}

/** Two records with nothing between them to write. */
function same(a: Omit<Activity, "since">, b: Omit<Activity, "since">): boolean {
  return (
    sameDoing(a, b) &&
    a.until === b.until &&
    a.next === b.next &&
    a.last?.at === b.last?.at &&
    a.last?.what === b.last?.what
  );
}

export const ACTIVITY_SCHEMA = {
  type: "object",
  required: ["agent", "doing", "what", "since"],
  properties: {
    agent: { type: "string" },
    doing: { type: "string", enum: ["thinking", "working", "talking", "waiting", "stuck", "idle", "asleep"] },
    what: { type: "string", maxLength: 160 },
    detail: { type: "string", maxLength: 160 },
    tool: { type: "string" },
    look: { type: "string" },
    with: { type: "string" },
    request: { type: "string" },
    task: { type: "string" },
    question: { type: "string", maxLength: 2000 },
    session: { type: "string" },
    since: { type: "string" },
    last: {
      type: "object",
      required: ["what", "at"],
      properties: { what: { type: "string", maxLength: 160 }, look: { type: "string" }, at: { type: "string" } },
    },
    until: { type: "string" },
    next: { type: "string" },
  },
} as const;

/**
 * Why an agent with nothing to do is asleep, or null when it is awake: the
 * global pause, or an online agent's own switch from the Agents page.
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

/**
 * When an agent next wakes on its own, as an ISO time: the soonest wake it
 * booked, or its next turn when it runs on its own, whichever comes first.
 * Null when nothing will wake it. A time that has passed stays as it was
 * rather than becoming "now": the plugin asks again every few seconds, and a
 * time that moved each time would be a new record each time. So nothing
 * before its first turn either, which the worker takes at its next look.
 */
export function nextWake(at: { booked: string | null; own: OwnTurns | null; now: Date }): string | null {
  const times: number[] = [];
  const booked = at.booked ? Date.parse(at.booked) : Number.NaN;
  if (Number.isFinite(booked)) times.push(booked);
  const first = !at.own || !Number.isFinite(Date.parse(at.own.last ?? ""));
  const own = at.own && !first ? nextOwnTurn(at.own, at.now.getTime()) : undefined;
  if (own !== undefined) times.push(own);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export const SPEECH_SCHEMA = {
  type: "object",
  required: ["agent", "text", "at"],
  properties: {
    agent: { type: "string" },
    text: { type: "string", maxLength: SPEECH_CHARS },
    to: { type: "array", items: { type: "string" } },
    room: { type: "string" },
    at: { type: "string" },
  },
} as const;

/** How often idle agents are looked at again, for the per-agent pause, which announces nothing. */
const SLEEP_CHECK_MS = 5_000;

/**
 * Time by activity, counted since the process started. Kept outside the
 * plugin, so a config reload, which runs every plugin again, doesn't start
 * the count over.
 */
const TALLY = new TimeTally();

/**
 * The tracker of the plugin's latest run. The server mounts a route's
 * handler once, at startup, and a reload runs the plugin again with a new
 * tracker, so the routes read the one running now from here rather than the
 * one they were registered with.
 */
let live: ActivityTracker | undefined;

/** How long the charts' numbers are kept before they are read again: they change by the hour, not the second. */
const STATS_MS = 30_000;

const plugin: Plugin = (ctx) => {
  const runtime = ctx.runtime;
  if (!runtime || !anyAvatar(runtime.getConfig())) return;
  const cfg = (ctx.config ?? {}) as { tools?: Record<string, Partial<Look>>; settleMs?: number; speech?: boolean };

  ctx.stateTypes.register({
    name: ACTIVITY_TYPE,
    description:
      "What an agent is doing right now: thinking, working, talking, waiting on a person, stuck, idle or asleep. Kept by the activity plugin; gone on restart.",
    scope: "global",
    title: "what",
    provider: "memory",
    schema: ACTIVITY_SCHEMA as never,
    access: { write: [] },
  });

  if (cfg.speech !== false) {
    ctx.stateTypes.register({
      name: SPEECH_TYPE,
      description:
        "The last thing an agent said, in a room or to another agent, for a bubble over its head. People only: closed to agents.",
      scope: "global",
      title: "text",
      provider: "memory",
      schema: SPEECH_SCHEMA as never,
      access: { read: ["user"], write: [] },
    });
  }

  const schedules = new ScheduleStore(runtime.db);
  const onlineOf = (agent: string) => (agent === "default" ? undefined : runtime.getConfig().agents?.[agent]?.online);
  const tracker = new ActivityTracker({
    events: ctx.events,
    state: () => runtime.getStateService(),
    agents: () => ["default", ...Object.keys(runtime.getConfig().agents ?? {}).filter((a) => a !== "default")],
    asleep: (agent) => {
      const own = onlineOf(agent)?.enabled ? getExploratoryState(runtime.db, agent) : null;
      const why = whyAsleep({ paused: runtime.isAgentsPaused("autonomous"), own, now: new Date() });
      // A pause says when it runs out; being switched off or a pause on everyone doesn't.
      return why === "paused" && own?.paused_until ? { why, until: own.paused_until } : why;
    },
    next: (agent) => {
      // Paused, nobody wakes on their own: booked wakes and own turns alike wait for the pause to lift.
      if (runtime.isAgentsPaused("autonomous")) return null;
      let booked: string | null = null;
      try {
        const soonest = schedules.listForAgent(agent)[0];
        if (soonest) booked = fromDbTime(soonest.next_run_at).toISOString();
      } catch {
        // A store without schedules books nothing.
      }
      const online = onlineOf(agent);
      const now = new Date();
      const state =
        online?.enabled && runtime.getConfig().exploratory?.enabled && getExploratoryState(runtime.db, agent);
      const own = online && state ? ownTurnsOf(state, online, runtimeTimeProvider(runtime).timeZone(), now) : null;
      return nextWake({ booked, own, now });
    },
    roomName: (ref) => runtime.getRoomStore().getRoomByRef(ref)?.name,
    ...(cfg.tools ? { tools: cfg.tools } : {}),
    ...(typeof cfg.settleMs === "number" ? { settleMs: cfg.settleMs } : {}),
    speech: cfg.speech !== false,
    tally: TALLY,
  });
  void tracker.start();
  live = tracker;

  // What agents did lately and the numbers behind the charts, for the widgets in the 3D world. Under
  // /api/ext/builtin:activity/. Read from what the server keeps, so only people read them, as the page does.
  ctx.http.register({
    method: "GET",
    path: "feed",
    handler: () => ({
      json: { items: recentFeed(runtime.db, (tool, args) => (live ?? tracker).looks(tool, args)) },
    }),
  });
  let kept: { at: number; days: number; stats: Omit<Stats, "time" | "since"> } | undefined;
  ctx.http.register({
    method: "GET",
    path: "stats",
    handler: (req) => {
      const days = Math.max(1, Math.min(STATS_DAYS, Math.floor(Number(req.query.days) || STATS_DAYS)));
      const now = Date.now();
      if (!kept || kept.days !== days || now - kept.at > STATS_MS)
        kept = { at: now, days, stats: hourlyStats(runtime.db, days) };
      return {
        json: {
          ...kept.stats,
          time: TALLY.rows(live?.ongoing() ?? [], now),
          since: new Date(TALLY.since).toISOString(),
        },
      };
    },
  });
  const timer = setInterval(() => tracker.refresh(), SLEEP_CHECK_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    tracker.stop();
    if (live === tracker) live = undefined;
  };
};

export default plugin;
