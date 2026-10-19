/**
 * Activity: what each agent is doing right now, as world state.
 *
 * One `activity` record per agent (id = the agent's name), kept by the
 * built-in `memory` provider because it is only true while it lasts. It says
 * whether the agent is thinking, working with a tool, talking to another agent,
 * waiting on you, stuck, idle or asleep, in a few words a status line can show
 * ("searching the web", "talking to planner"), with a `look` the page can draw
 * — a prop to hold: a camera, a laptop, a book — and who else is involved.
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
 * online agent's own enabled/paused state from the Agents page.
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
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { StateCaller, StateService } from "../state/service.js";
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
  /** When it started doing this. */
  since: string;
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

/** The built-in tools, and the plugins' that ship here. A tool not listed is "using <tool>". */
const LOOKS: Record<string, (args: Record<string, unknown>) => Look> = {
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
  room: (a) =>
    a.action === "dm"
      ? talkingTo(words(a.agent ?? a.to ?? a.member), "talking to")
      : { what: "posting in a room", look: "phone", detail: words(a.room) },
  place: (a) =>
    a.action === "photo"
      ? { what: String(a.view).toLowerCase() === "selfie" ? "taking a selfie" : "taking a photo", look: "camera" }
      : a.action === "go" || a.action === "new"
        ? { what: "going somewhere", detail: words(a.place ?? a.name) }
        : a.action === "look" || a.action === "places"
          ? { what: "looking around" }
          : { what: "rearranging the room" },
};

export interface ActivityOptions {
  events: EventBus;
  state: () => StateService;
  /** Every agent there is a record for, from the start. */
  agents: () => string[];
  /** Why an agent is asleep when it has nothing to do, or null when it is awake. */
  asleep: (agent: string) => string | null;
  /** Deployment overrides: `tool` or `tool.action` → how it looks. */
  tools?: Record<string, Partial<Look>>;
  /** Changes within this many ms are written as one, so a quick tool call doesn't flicker. 0 writes each. */
  settleMs?: number;
  /** Keep what agents say, in rooms and to each other. Default on. */
  speech?: boolean;
  now?: () => Date;
}

interface Tracked {
  /** Sessions with a turn running. */
  turns: Set<string>;
  /** The tool call in flight, by its id. */
  tool?: { id: string; name: string; look: Look };
  /** A person is being asked to approve a call. */
  approval?: string;
  /** Something it asked a person, unanswered: shown until its next turn starts. */
  asked?: { what: string; detail?: string };
  /** Its last turn stalled or failed: shown until the next one starts. */
  stuck?: string;
  /** The agent whose message started the turn it is in. */
  from?: string;
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
      on.on("approval.requested", (e) => this.change(nameOf(e.agent), (t) => (t.approval = e.tool))),
      on.on("approval.settled", (e) => this.change(nameOf(e.agent), (t) => (t.approval = undefined))),
      on.on("task.needs_human", (e) =>
        this.change(nameOf(e.agentName), (t) => (t.asked = { what: "needs you", detail: words(e.message) })),
      ),
      on.on("agent.stalled", (e) => this.change(nameOf(e.agentName), (t) => (t.stuck = stuckWords(e.stallReason)))),
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
    this.stopped = true;
    for (const sub of this.subs) sub.dispose();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** What an agent is doing, from what has been heard. */
  current(agent: string): Omit<Activity, "since"> {
    const t = this.tracked.get(agent);
    const base = { agent };
    if (t?.approval) return { ...base, doing: "waiting", what: "waiting for your OK", tool: t.approval };
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
    if (t?.asked)
      return { ...base, doing: "waiting", what: t.asked.what, ...(t.asked.detail ? { detail: t.asked.detail } : {}) };
    if (t?.stuck) return { ...base, doing: "stuck", what: "stuck", detail: t.stuck };
    const why = this.opts.asleep(agent);
    if (why) return { ...base, doing: "asleep", what: "asleep", detail: why };
    return { ...base, doing: "idle", what: "idle" };
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
      t.tool = undefined;
      t.from = undefined;
      if (e.error) t.stuck = `something went wrong: ${words(e.error) ?? "an error"}`;
      else if (e.stop && isStallStop(e.stop)) t.stuck = stuckWords(stallReasonOf(e.stop));
    });
  }

  private toolStarted(p: { agent?: string; tool: string; toolUseId: string; args: Record<string, unknown> }): void {
    const agent = nameOf(p.agent);
    const look = this.lookOf(p.tool, p.args);
    // The agent on the other end of a dm or delegation will start a turn: it is talking too.
    if (look.with) this.incoming.set(look.with, agent);
    this.change(agent, (t) => (t.tool = { id: p.toolUseId, name: p.tool, look }));
    if (p.tool === "ask_user") this.track(agent).asked = { what: "has a question for you", detail: look.detail };
  }

  private toolEnded(e: RuntimeEventPayload<"agent.post_tool_use">): void {
    const agent = nameOf(e.agent);
    this.change(agent, (t) => {
      if (t.tool?.id === e.toolUseId) t.tool = undefined;
      if (e.tool === "ask_user" && !e.success) t.asked = undefined;
      // A question sent as a choice, form or confirmation waits for the person, like ask_user.
      if (e.tool === "interface" && e.success && e.args.action === "send" && ASKS.has(String(e.args.kind))) {
        const props = (e.args.props ?? {}) as Record<string, unknown>;
        t.asked = { what: "has a question for you", detail: words(props.question ?? props.title ?? props.summary) };
      }
    });
    const look = this.lookOf(e.tool, e.args);
    if (look.with && this.incoming.get(look.with) === agent) this.incoming.delete(look.with);
  }

  private lookOf(tool: string, args: Record<string, unknown>): Look {
    const action = typeof args.action === "string" ? args.action : "";
    const own = (action && this.opts.tools?.[`${tool}.${action}`]) || this.opts.tools?.[tool];
    const builtIn = LOOKS[tool]?.(args) ?? { what: `using ${tool}` };
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
    const next = this.current(agent);
    const last = this.written.get(agent);
    if (last && same(last, next)) return;
    const record: Activity = { ...next, since: this.now().toISOString() };
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

function same(a: Omit<Activity, "since">, b: Omit<Activity, "since">): boolean {
  const keys: (keyof Omit<Activity, "since">)[] = ["agent", "doing", "what", "detail", "tool", "look", "with"];
  return keys.every((k) => a[k] === b[k]);
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
    since: { type: "string" },
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

  const tracker = new ActivityTracker({
    events: ctx.events,
    state: () => runtime.getStateService(),
    agents: () => ["default", ...Object.keys(runtime.getConfig().agents ?? {}).filter((a) => a !== "default")],
    asleep: (agent) => {
      const online = agent !== "default" && !!runtime.getConfig().agents?.[agent]?.online?.enabled;
      return whyAsleep({
        paused: runtime.isAgentsPaused("autonomous"),
        own: online ? getExploratoryState(runtime.db, agent) : null,
        now: new Date(),
      });
    },
    ...(cfg.tools ? { tools: cfg.tools } : {}),
    ...(typeof cfg.settleMs === "number" ? { settleMs: cfg.settleMs } : {}),
    speech: cfg.speech !== false,
  });
  void tracker.start();
  const timer = setInterval(() => tracker.refresh(), SLEEP_CHECK_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    tracker.stop();
  };
};

export default plugin;
