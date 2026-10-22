/**
 * The directory: what each agent is for, the work it has taken on, and what
 * it has written up, kept as world-state records other agents can ask about.
 * Off by default; turn it on with `{ module: "builtin:directory", enabled: true }`.
 * See `docs/directory.md`, and `docs/ownership-design.md` for where it's going.
 *
 * It brings six record types (`profile`, `commitment`, `doc`, `miss`,
 * `page`, `upkeep`), three tools (`directory`, `commitment`, `writeup`), a
 * "Your commitments" block in the prompt of every agent that has the
 * `commitment` tool, and the routes the agent and room pages in the web UI
 * read and hand work over through. Rooms keep the same records, led by an
 * agent (`directory-rooms.ts`). It registers through the same seams a
 * third-party plugin would, and core knows nothing about it.
 *
 * Config (`plugins: [{ module: builtin:directory, config: {...} }]`):
 *   - `pin` (default true): the prompt block. `false` leaves it out.
 *   - `minMeaning` (default 0.5) and `minWords` (default 0.3): how close a
 *     search hit must be to count as found, for searches matched by meaning
 *     and by words. Below the bar a search finds nothing and notes a miss.
 *   - `upkeep`: `{ every, agents }` gives each agent an upkeep turn on that
 *     interval (`directory-upkeep.ts`), plus the bars its evidence is counted
 *     against. Off unless set; a person can still start one from the page.
 *   - `leads`: `{ "<room name or ref>": "<agent>" }`, who leads which room.
 *     A room left out is led by the agent that created it, and a person can
 *     choose another on the room's page.
 */

import { resolveAgent } from "../agent/agents.js";
import {
  type ContextSlot,
  type ContextSlotContext,
  listContextSlots,
  registerContextSlot,
  unregisterContextSlot,
} from "../agent/context-slots.js";
import { findOrCreateSession } from "../agent/session.js";
import { getExploratoryState } from "../db/exploratory-queries.js";
import type { TaiHttpResponse } from "../http/registry.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { Disposer } from "../registry.js";
import type { RoomStore } from "../rooms/store.js";
import { formatRoomRef, type Room } from "../rooms/types.js";
import type { AgentRuntime } from "../runtime.js";
import type { StateCaller, StateService } from "../state/service.js";
import { StateError, type StateRecord, type StateTypeDef } from "../state/types.js";
import { systemTimeZone } from "../time/provider.js";
import { rederive } from "./directory-checks.js";
import {
  ACTIVE,
  AUTONOMY,
  type Autonomy,
  type Bar,
  COMMITMENT_TYPE,
  DEFAULT_BAR,
  DIRECTORY_TYPES,
  Directory,
  DOC_TYPE,
  MISS_TYPE,
  ownerOf,
  PAGE_TYPE,
  PERSON,
  PROFILE_TYPE,
  STATUSES,
  stringList,
  UPKEEP_TYPE,
} from "./directory-records.js";
import { type RoomInfo, type RoomSource, roomOfOwner, roomOwner } from "./directory-rooms.js";
import { CommitmentTool, commitmentLine, DirectoryTool, WriteupTool } from "./directory-tools.js";
import { changedOf, parseUpkeep, Upkeep, type UpkeepSettings } from "./directory-upkeep.js";
import {
  busy,
  everyWords,
  REFUSED_WORDS,
  refused,
  runNow,
  Tender,
  turnSession,
  UPKEEP_KIND,
  whyAsleep,
} from "./places-tend.js";

export const COMMITMENTS_SLOT_ID = "directory.commitments";
/** Commitments shown in the prompt block before the rest are counted. */
const PINNED = 10;
/** Commitments read for the block, to show ten and count the rest. */
const PINNED_READ = 100;
/**
 * The block's ceiling. Core cuts a slot past it, so the block stops adding
 * lines before that, and the count of the rest is never what gets cut.
 */
const PINNED_BUDGET_TOKENS = 400;
const PINNED_CHARS = PINNED_BUDGET_TOKENS * 4;
/** One commitment's line at most, so one long goal can't crowd out the others. */
const PINNED_LINE_CHARS = 400;

export interface DirectoryConfig {
  pin: boolean;
  bar: Bar;
  upkeep: UpkeepSettings;
  /** Who leads which room, by the room's name or ref. */
  leads: Record<string, string>;
}

/**
 * The config of the load in effect, or null once the plugin is unloaded with
 * nothing in its place. A reload swaps in the tools the new load builds, but
 * a call already running keeps the instance it started on. Tools read this
 * rather than their own load's config, so such a call sees the new bar, and
 * one running as the plugin is turned off says so instead of failing against
 * types that are gone.
 */
let live: DirectoryConfig | null = null;

/** The plugin's config bag, with anything unusable replaced by its default and said once. */
export function readConfig(raw: Record<string, unknown>): DirectoryConfig {
  const share = (key: "minMeaning" | "minWords", fallback: number): number => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && value >= 0 && value <= 1) return value;
    console.warn(`[directory] ${key} should be a number from 0 to 1; using ${fallback}.`);
    return fallback;
  };
  return {
    pin: raw.pin !== false,
    bar: { meaning: share("minMeaning", DEFAULT_BAR.meaning), words: share("minWords", DEFAULT_BAR.words) },
    upkeep: parseUpkeep(raw.upkeep, (problem) => console.warn(`[directory] ${problem}`)),
    leads: parseLeads(raw.leads, (problem) => console.warn(`[directory] ${problem}`)),
  };
}

/** The config's `leads`, read: room name or ref to agent, leaving out what can't be used and saying so. */
export function parseLeads(raw: unknown, warn: (problem: string) => void): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn('leads is { "<room name or ref>": "<agent>" }; it is left out.');
    return {};
  }
  const leads: Record<string, string> = {};
  for (const [room, agent] of Object.entries(raw as Record<string, unknown>)) {
    if (room.trim() && typeof agent === "string" && agent.trim()) leads[room.trim()] = agent.trim();
    else warn(`leads["${room}"] should name an agent; it is left out.`);
  }
  return leads;
}

/** The runtime's rooms store, as the directory reads it. Undefined for a runtime without one. */
function roomSource(runtime: AgentRuntime): RoomSource | undefined {
  return typeof runtime.getRoomStore === "function" ? roomsFrom(runtime.getRoomStore()) : undefined;
}

/** A rooms store, as the directory reads it: live rooms, a room by name or ref, and who's subscribed. */
export function roomsFrom(store: RoomStore): RoomSource {
  const info = (room: Room): RoomInfo => ({
    ref: formatRoomRef(room.ref),
    name: room.name,
    ...(room.purpose ? { purpose: room.purpose } : {}),
    ...(room.createdBy ? { createdBy: room.createdBy } : {}),
    archived: !!room.archivedAt,
  });
  return {
    list: () => store.listRooms().map(info),
    find: (nameOrRef) => {
      const room = store.resolve(nameOrRef);
      return room ? info(room) : undefined;
    },
    subscribers: (ref) => store.listSubscriptionsForRoom(ref).map((s) => s.agent),
  };
}

/** Every agent that exists, registry and config.yaml together, so authored-resource agents count too. */
function roster(runtime: AgentRuntime): string[] {
  const ids = (runtime.getAgentRegistry?.().list?.() ?? []).map((r) => r.id);
  const fromConfig = Object.keys(runtime.getConfig().agents ?? {});
  return [...new Set([...ids, ...fromConfig])].sort();
}

/**
 * Whether an agent has the `commitment` tool: named in its `tools:` list, or
 * no list at all, which means every tool.
 */
function hasCommitmentTool(runtime: AgentRuntime, agent: string): boolean {
  const tools = runtime.getAgentDefinition(agent)?.tools;
  return Array.isArray(tools) ? tools.includes("commitment") : true;
}

/**
 * Whether an agent's turn will hold a tool: a meta tool every top-level turn
 * gets, or one that exists and that its `tools:` list names (no list means
 * every tool).
 */
function hasTool(runtime: AgentRuntime, agent: string, tool: string): boolean {
  if (tool === "commitment") return hasCommitmentTool(runtime, agent);
  if (runtime.getMetaTools?.().some((t) => t.name === tool)) return true;
  const known = runtime.getResolvableTools?.();
  if (known && !known.some((t) => t.name === tool)) return false;
  const tools = runtime.getAgentDefinition(agent)?.tools;
  return Array.isArray(tools) ? tools.includes(tool) : true;
}

/** Why an agent can't take an upkeep turn now (agents paused, its own switch off), or null when it can. */
function asleep(runtime: AgentRuntime, agent: string): string | null {
  const online = agent !== "default" && !!runtime.getConfig().agents?.[agent]?.online?.enabled;
  return whyAsleep({
    paused: runtime.isAgentsPaused("autonomous"),
    own: online ? getExploratoryState(runtime.db, agent) : null,
    now: new Date(),
  });
}

/**
 * Upkeep turns for the agents of this runtime: the evidence read through the
 * directory and the memory store, and the turn run in the agent's own
 * `upkeep:<agent>` session through the runtime's waker, with the round budget
 * as its ceiling.
 */
function upkeepFor(runtime: AgentRuntime, directory: Directory, settings: UpkeepSettings): Upkeep {
  const resolve = (agent: string) =>
    resolveAgent(
      agent === "default" ? undefined : agent,
      runtime.getConfig(),
      runtime.getResolvableTools(),
      undefined,
      runtime.contextDir,
      undefined,
      runtime.buildResolveOptions(),
    );
  return new Upkeep({
    directory,
    settings,
    has: (agent, tool) => hasTool(runtime, agent, tool),
    memory: () => runtime.getMemoryBackend(),
    embedder: () => runtime.getEmbedder(),
    session: (agent) => {
      const resolved = resolve(agent);
      return findOrCreateSession(runtime.db, turnSession(UPKEEP_KIND, agent), resolved.model, resolved.provider);
    },
    // By the session's id, so the turn runs in the session whose writes upkeep counts. The waker holds it to the
    // pause and the hourly ceiling, and caps its rounds: an agent configured for fewer keeps its own.
    run: async (agent, session, message, maxRounds) => {
      const where = { sessionId: session.id };
      const outcome = await runtime.wakeAgent(agent, {
        prompt: message,
        ...where,
        wake: { kind: UPKEEP_KIND, ref: `${UPKEEP_TYPE}/${agent}` },
        maxToolRounds: maxRounds,
      });
      if (outcome === "ran") return outcome;
      // The waker turns a wake away before it lets go of the event loop, so asking straight after gets its reason.
      return { outcome, why: runtime.wakeRefusal(agent, where)?.why ?? REFUSED_WORDS[outcome] };
    },
  });
}

/** The agent's open and waiting commitments, behind the history every turn. */
export function commitmentsSlot(directory: Directory, takesPart: (agent: string) => boolean): ContextSlot {
  return {
    id: COMMITMENTS_SLOT_ID,
    refresh: "turn",
    title: "Your commitments",
    budgetTokens: PINNED_BUDGET_TOKENS,
    render: async (ctx: ContextSlotContext) => {
      const agent = ctx.agent ?? "default";
      if (!takesPart(agent)) return null;
      const caller: StateCaller = {
        actor: { kind: "agent", name: agent },
        source: { surface: "context" },
        rooms: ctx.rooms ?? [],
        projectId: ctx.projectId,
      };
      const records = await directory.commitments(caller, agent, ACTIVE, PINNED_READ);
      if (records.length === 0) return null;
      // Work in hand before work that waits on someone.
      const ordered = [
        ...records.filter((r) => r.data.status === "open"),
        ...records.filter((r) => r.data.status !== "open"),
      ];
      const now = directory.now();
      // Room for the count line, which goes last and must survive.
      const reserve = `\n…and ${PINNED_READ}+ more; commitment list shows them.`.length;
      const lines: string[] = [];
      let used = 0;
      const name = (owner: string) => directory.ownerName(owner);
      for (const r of ordered.slice(0, PINNED)) {
        const full = commitmentLine(r, now, name) + (r.scope === `agent:${agent}` ? ", private" : "");
        const line = full.length > PINNED_LINE_CHARS ? `${full.slice(0, PINNED_LINE_CHARS - 1)}…` : full;
        const cost = line.length + (lines.length ? 1 : 0);
        if (lines.length > 0 && used + cost + reserve > PINNED_CHARS) break;
        lines.push(line);
        used += cost;
      }
      const rest = ordered.length - lines.length;
      if (rest > 0) {
        // A full read means there may be more than were read, and the count says so rather than coming up short.
        const plus = records.length >= PINNED_READ ? "+" : "";
        lines.push(`…and ${rest}${plus} more; commitment list shows them.`);
      }
      return lines.join("\n");
    },
  };
}

/**
 * Say so when config declares a type of the same name as one of the
 * directory's: config wins, so that declaration's `access` and `search` apply
 * instead, and only-the-owner-changes-it no longer holds for agents writing
 * through `state`.
 */
function warnReplaced(service: StateService, types: StateTypeDef[]): void {
  for (const def of types) {
    const declared = service.getType(def.name);
    if (declared && declared !== def) {
      console.warn(
        `[directory] state.types in config declares "${def.name}", which replaces the directory's own type of that name. ` +
          "Its access and search rules apply instead, so agents may be able to change each other's records. Rename the config type to keep the directory's.",
      );
    }
  }
}

/** What the agent pages list for each agent: its profile, or its configured description, and counts. */
async function agentSummaries(directory: Directory) {
  const [profiles, commitments, docs] = await Promise.all([
    directory.all(PROFILE_TYPE),
    directory.all(COMMITMENT_TYPE),
    directory.all(DOC_TYPE),
  ]);
  const byOwner = (records: StateRecord[]) => {
    const map = new Map<string, StateRecord[]>();
    for (const r of records) {
      const owner = ownerOf(r);
      if (owner) map.set(owner, [...(map.get(owner) ?? []), r]);
    }
    return map;
  };
  const profileOf = byOwner(profiles);
  const commitmentsOf = byOwner(commitments);
  const docsOf = byOwner(docs);
  // A room's profile is the room's, not an agent's.
  const profiled = [...profileOf.keys()].filter((owner) => !roomOfOwner(owner));
  const names = [...new Set([...directory.agents(), ...profiled])].sort();
  return names.map((name) => {
    const own = commitmentsOf.get(name) ?? [];
    const count = (status: string) => own.filter((r) => r.data.status === status).length;
    const description = directory.describe(name);
    return {
      name,
      profile: profileOf.get(name)?.[0]?.data ?? null,
      ...(description ? { description } : {}),
      commitments: { open: count("open"), waiting: count("waiting"), done: count("done") },
      docs: (docsOf.get(name) ?? []).length,
    };
  });
}

/** What the rooms list shows for each live room: what it's for, who leads it, who's in it, and counts. */
async function roomSummaries(directory: Directory) {
  const [commitments, docs] = await Promise.all([directory.all(COMMITMENT_TYPE), directory.all(DOC_TYPE)]);
  const summaries = [];
  for (const room of directory.rooms()) {
    const profile = await directory.roomProfile(room);
    const lead = await directory.lead(room, profile);
    const members = await directory.members(room, lead);
    // What it's working on: its own commitments and those its lead took on for it.
    const work = commitments.filter((r) => r.data.room === room.ref);
    const count = (status: string) => work.filter((r) => r.data.status === status).length;
    const purpose =
      typeof profile?.data.purpose === "string" && profile.data.purpose.trim() ? profile.data.purpose : room.purpose;
    summaries.push({
      ref: room.ref,
      name: room.name,
      purpose: purpose ?? null,
      lead: lead.agent ?? null,
      ...(lead.source ? { leadFrom: lead.source } : {}),
      members,
      commitments: { open: count("open"), waiting: count("waiting"), done: count("done") },
      docs: docs.filter((d) => d.data.owner === roomOwner(room.ref)).length,
    });
  }
  return summaries;
}

/** A string field of a request body, trimmed; undefined when it isn't there, "" when it's there and empty. */
function field(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  if (value === null) return "";
  return typeof value === "string" ? value.trim() : undefined;
}

const plugin: Plugin = (ctx) => {
  const runtime = ctx.runtime;
  if (!runtime) return;
  const config = readConfig(ctx.config ?? {});
  const disposers: Disposer[] = [];
  live = config;
  disposers.push(() => {
    // Only ours: a newer load may already be in effect.
    if (live === config) live = null;
  });

  // The loader doesn't collect state-type registrations, so these are taken
  // back here. A reload disposes the plugin and loads it again, which
  // registers them afresh. Each load registers its own copy: a registry's
  // disposer removes an entry only while it is the very object that call
  // registered, so an older load disposed late leaves a newer load's types in.
  const types: StateTypeDef[] = DIRECTORY_TYPES.map((def) => ({ ...def }));
  for (const def of types) disposers.push(ctx.stateTypes.register(def));
  warnReplaced(runtime.getStateService(), types);
  for (const [room, agent] of Object.entries(config.leads)) {
    if (!roster(runtime).includes(agent)) {
      console.warn(`[directory] leads names ${agent} for ${room}, but there's no such agent; it leads nothing.`);
    }
  }

  const directoryFor = (getService: () => StateService) =>
    new Directory({
      getService,
      agents: () => roster(runtime),
      describe: (agent) => runtime.getAgentDefinition(agent)?.description?.trim() || undefined,
      bar: () => (live ?? config).bar,
      active: () => live !== null,
      rooms: () => roomSource(runtime),
      leads: () => (live ?? config).leads,
      // The runtime's clock and time zone, read on every use: a reload can change them.
      now: () => runtime.getTimeProvider?.().now() ?? new Date(),
      timeZone: () => runtime.getTimeProvider?.().timeZone() ?? systemTimeZone(),
    });

  ctx.tools.register("directory", (_cfg, tctx) =>
    tctx.getStateService ? [new DirectoryTool(directoryFor(tctx.getStateService))] : [],
  );
  ctx.tools.register("commitment", (_cfg, tctx) =>
    tctx.getStateService ? [new CommitmentTool(directoryFor(tctx.getStateService))] : [],
  );
  ctx.tools.register("writeup", (_cfg, tctx) =>
    tctx.getStateService ? [new WriteupTool(directoryFor(tctx.getStateService))] : [],
  );

  const directory = directoryFor(() => runtime.getStateService());

  // A person's edit of a commitment's nextCheck, on the State page or an agent or room page, is read again here,
  // so what wakes the agent follows what the person wrote. The tools read it as they write it.
  const edits = ctx.events.on("state.changed", (change) => {
    rederive(directory, change).catch((err: unknown) =>
      console.warn(`[directory] couldn't read the check on ${change.id}: ${(err as Error).message}`),
    );
  });
  disposers.push(() => edits.dispose());

  // A reload disposes this load, which takes the block out, and loads the plugin again, which puts it back.
  if (config.pin) {
    const slot = commitmentsSlot(directory, (agent) => hasCommitmentTool(runtime, agent));
    registerContextSlot(slot);
    disposers.push(() => {
      // Only ours: a newer load may already have put its own in.
      if (listContextSlots().find((s) => s.id === COMMITMENTS_SLOT_ID) === slot) {
        unregisterContextSlot(COMMITMENTS_SLOT_ID);
      }
    });
  }

  // Upkeep: each agent, on the interval, looks after what it owns (`directory-upkeep.ts`). The schedule is off unless
  // set; a person can start a turn from the agent's page either way.
  const upkeep = upkeepFor(runtime, directory, config.upkeep);
  const schedule = config.upkeep.schedule;
  if (schedule) {
    if (schedule.agents !== "all") {
      for (const agent of schedule.agents) {
        if (!roster(runtime).includes(agent))
          console.warn(`[directory] ${agent} is set for upkeep, but there's no such agent.`);
        else if (!hasCommitmentTool(runtime, agent))
          console.warn(`[directory] ${agent} is set for upkeep, but has no commitment tool, so it won't have one.`);
      }
    }
    const tender = new Tender({
      kind: UPKEEP_KIND,
      settings: schedule,
      agents: () => roster(runtime).filter((a) => hasCommitmentTool(runtime, a)),
      // At its hourly wake ceiling, the turn is skipped before its evidence is read: the waker would turn it away.
      unready: (agent) =>
        asleep(runtime, agent) ??
        runtime.wakeRefusal(agent, { sessionKey: turnSession(UPKEEP_KIND, agent) })?.why ??
        null,
      tend: (agent) => upkeep.turn(agent),
      log: (line) => console.log(`[directory] ${line}`),
      warn: (line) => console.warn(`[directory] ${line}`),
      said: {
        woken: (agent) => `${agent} looked after what it owns`,
        quiet: (agent) => `${agent}'s upkeep found nothing new, so it wasn't woken`,
        failed: (agent) => `${agent}'s upkeep failed`,
      },
    });
    tender.start();
    disposers.push(() => tender.stop());
  }

  // A reload that turns the directory off takes these routes away, but a request already on its way answers this,
  // the way a running tool call does, and the agent pages fall back to the configured description.
  const off = (): TaiHttpResponse => ({ status: 404, json: { error: "The directory is turned off." } });

  ctx.http.register({
    method: "GET",
    path: "agents",
    handler: async (): Promise<TaiHttpResponse> =>
      directory.active() ? { json: { agents: await agentSummaries(directory) } } : off(),
  });

  ctx.http.register({
    method: "GET",
    path: "agents/:name",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const name = req.params.name ?? "";
      const agent = await directory.resolve(name);
      if (!agent) return { status: 404, json: { error: `There's no agent called "${name}".` } };
      const where = { owner: agent };
      const [profile, page, commitments, docs, misses] = await Promise.all([
        directory.profile(PERSON, agent),
        directory.page(PERSON, agent),
        directory.all(COMMITMENT_TYPE, where),
        directory.all(DOC_TYPE, where),
        directory.all(MISS_TYPE, where),
      ]);
      const description = directory.describe(agent);
      // The rooms its commitments were taken on for, by name, so the page can say which.
      const rooms: Record<string, string> = {};
      for (const c of commitments) {
        const ref = typeof c.data.room === "string" ? c.data.room : undefined;
        const room = ref ? directory.room(ref) : undefined;
        if (ref && room) rooms[ref] = room.name;
      }
      return {
        json: {
          name: agent,
          profile,
          ...(description ? { description } : {}),
          page,
          commitments,
          docs,
          misses,
          upkeep: await upkeepView(agent),
          rooms,
          leads: (await directory.ledBy(agent)).map((r) => r.name),
        },
      };
    },
  });

  /**
   * What the page shows of an agent's upkeep: when the last one finished and
   * what it changed, whether one is running, and how often it comes round.
   * Null for an agent upkeep can't run for: no agent to wake, or no
   * commitment tool.
   */
  const upkeepView = async (agent: string) => {
    if (!directory.agents().includes(agent) || !hasCommitmentTool(runtime, agent)) return null;
    const data = (await directory.upkeep(agent))?.data ?? {};
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const scheduled = schedule && (schedule.agents === "all" || schedule.agents.includes(agent));
    const changed = changedOf(data.changed);
    return {
      running: busy(UPKEEP_KIND, agent),
      ...(text(data.at) ? { at: text(data.at) } : {}),
      ...(changed ? { changed } : {}),
      ...(text(data.error) ? { error: text(data.error) } : {}),
      ...(text(data.error) && text(data.failedAt) ? { failedAt: text(data.failedAt) } : {}),
      ...(scheduled ? { every: everyWords(schedule.everyMs) } : {}),
    };
  };

  // A person handing an agent something from its page: a commitment the agent owns, from them.
  ctx.http.register({
    method: "POST",
    path: "agents/:name/commitments",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const name = req.params.name ?? "";
      const agent = await directory.resolve(name);
      if (!agent) return { status: 404, json: { error: `There's no agent called "${name}".` } };
      // A name with only a profile left is no agent to work it.
      if (!directory.agents().includes(agent)) {
        return { status: 404, json: { error: `${agent} has a profile but isn't an agent any more.` } };
      }
      const body = await req.json<Record<string, unknown>>().catch(() => null);
      const field = (key: string) => (typeof body?.[key] === "string" ? (body[key] as string).trim() : "");
      const goal = field("goal");
      const doneWhen = field("doneWhen");
      const autonomy = field("autonomy");
      if (!goal) return { status: 400, json: { error: "Say what you're handing over in `goal`." } };
      if (autonomy && !(AUTONOMY as readonly string[]).includes(autonomy)) {
        return { status: 400, json: { error: `autonomy is one of: ${AUTONOMY.join(", ")}.` } };
      }
      if (goal.length > 300)
        return { status: 400, json: { error: "Keep the goal to one line: 300 characters at most." } };
      if (doneWhen.length > 500) return { status: 400, json: { error: "Keep done-when to 500 characters at most." } };
      try {
        const commitment = await directory.handOver(agent, {
          goal,
          ...(doneWhen ? { doneWhen } : {}),
          ...(autonomy ? { autonomy: autonomy as Autonomy } : {}),
        });
        // Whether the agent will see it behind its history next turn, and if not why, so the page can say so
        // honestly: it has no commitment tool, or the block is turned off.
        const why = !hasCommitmentTool(runtime, agent) ? "tool" : !(live ?? config).pin ? "pin" : undefined;
        return { status: 201, json: { commitment, inPrompt: !why, ...(why ? { why } : {}) } };
      } catch (err) {
        if (err instanceof StateError) return { status: 400, json: { error: err.message } };
        throw err;
      }
    },
  });

  // A person asking an agent to tidy up now: its upkeep turn at once, past the "nothing changed" check but not the
  // pause or the agent's hourly wake ceiling. It runs on after the answer, which is 202; the page sees it start and
  // finish from the state stream.
  ctx.http.register({
    method: "POST",
    path: "agents/:name/upkeep",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const name = req.params.name ?? "";
      const agent = await directory.resolve(name);
      if (!agent || !directory.agents().includes(agent)) {
        return { status: 404, json: { error: `There's no agent called "${name}".` } };
      }
      if (!hasCommitmentTool(runtime, agent)) {
        return { status: 409, json: { error: `${agent} has no commitment tool, so it has no upkeep to do.` } };
      }
      const why = asleep(runtime, agent);
      if (why) return { status: 409, json: { error: `${agent} can't tidy up now: ${why}.` } };
      // Asked before the answer, since the turn only reaches the waker once its evidence is read.
      const refusal = runtime.wakeRefusal(agent, { sessionKey: turnSession(UPKEEP_KIND, agent) });
      const started = refusal ? undefined : runNow(UPKEEP_KIND, agent, () => upkeep.turn(agent, { force: true }));
      if (!started) {
        // Turns on an interval go one at a time, a person's included: one is going now, this agent's or another's.
        // The waker's reason comes before another turn's, since it lasts longer: a minute's wait wouldn't help.
        const error = busy(UPKEEP_KIND, agent)
          ? `${agent} is already tidying up.`
          : refusal
            ? `${agent} can't tidy up now: ${refusal.why}. Try again later.`
            : "Another turn is running now: tends and upkeep go one at a time. Try again in a minute.";
        return { status: 409, json: { error } };
      }
      started.then(
        (how) => {
          // The waker can still turn it away once the evidence is read; the turn keeps why for the page.
          if (refused(how)) console.log(`[directory] ${agent}'s upkeep was turned away: ${REFUSED_WORDS[how]}`);
        },
        (err: unknown) => console.warn(`[directory] ${agent}'s upkeep failed: ${(err as Error).message}`),
      );
      return { status: 202, json: { started: true } };
    },
  });

  // ------------------------------------------------------------------ rooms

  /** The room a route names, by name or ref, archived ones too. */
  const roomFrom = (req: { params: Record<string, string> }) => directory.room(req.params.room ?? "");
  // Names the room asked for, so a page can tell "no such room" from routes that aren't there at all.
  const noRoom = (req: { params: Record<string, string> }): TaiHttpResponse => ({
    status: 404,
    json: { error: `There's no room called "${req.params.room ?? ""}".`, room: req.params.room ?? "" },
  });
  const archived = (room: RoomInfo): TaiHttpResponse => ({
    status: 409,
    json: { error: `The ${room.name} room is archived, so its records stay as they are.` },
  });

  ctx.http.register({
    method: "GET",
    path: "rooms",
    handler: async (): Promise<TaiHttpResponse> =>
      directory.active() ? { json: { rooms: await roomSummaries(directory) } } : off(),
  });

  ctx.http.register({
    method: "GET",
    path: "rooms/:room",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const room = roomFrom(req);
      if (!room) return noRoom(req);
      const entry = await directory.roomEntry(PERSON, room);
      const [commitments, docs, misses] = await Promise.all([
        directory.all(COMMITMENT_TYPE, { room: room.ref }),
        directory.all(DOC_TYPE, { owner: roomOwner(room.ref) }),
        directory.all(MISS_TYPE, { owner: roomOwner(room.ref) }),
      ]);
      // Which fields a person set, record by record, so the page can show what agents leave alone.
      const held: Record<string, string[]> = {};
      for (const record of [...(entry.profile ? [entry.profile] : []), ...commitments, ...docs]) {
        const fields = await directory.held(record);
        if (fields.length) held[record.id] = fields;
      }
      return {
        json: {
          ref: room.ref,
          name: room.name,
          ...(room.purpose ? { purpose: room.purpose } : {}),
          ...(room.createdBy ? { createdBy: room.createdBy } : {}),
          archived: room.archived,
          profile: entry.profile,
          lead: entry.lead,
          members: entry.members,
          agents: directory.agents(),
          commitments,
          docs,
          misses,
          held,
        },
      };
    },
  });

  // A person handing a room something: a commitment for its lead, from them, that names the room.
  ctx.http.register({
    method: "POST",
    path: "rooms/:room/commitments",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const room = roomFrom(req);
      if (!room) return noRoom(req);
      if (room.archived) return archived(room);
      const lead = (await directory.lead(room)).agent;
      if (!lead) {
        return { status: 409, json: { error: `The ${room.name} room has no lead to hand this to. Choose one first.` } };
      }
      const body = await req.json<Record<string, unknown>>().catch(() => null);
      const goal = field(body, "goal") ?? "";
      const doneWhen = field(body, "doneWhen") ?? "";
      const autonomy = field(body, "autonomy") ?? "";
      if (!goal) return { status: 400, json: { error: "Say what you're handing over in `goal`." } };
      if (autonomy && !(AUTONOMY as readonly string[]).includes(autonomy)) {
        return { status: 400, json: { error: `autonomy is one of: ${AUTONOMY.join(", ")}.` } };
      }
      if (goal.length > 300)
        return { status: 400, json: { error: "Keep the goal to one line: 300 characters at most." } };
      if (doneWhen.length > 500) return { status: 400, json: { error: "Keep done-when to 500 characters at most." } };
      try {
        const commitment = await directory.handOver(
          lead,
          {
            goal,
            ...(doneWhen ? { doneWhen } : {}),
            ...(autonomy ? { autonomy: autonomy as Autonomy } : {}),
          },
          room,
        );
        const why = !hasCommitmentTool(runtime, lead) ? "tool" : !(live ?? config).pin ? "pin" : undefined;
        return { status: 201, json: { commitment, lead, inPrompt: !why, ...(why ? { why } : {}) } };
      } catch (err) {
        if (err instanceof StateError) return { status: 400, json: { error: err.message } };
        throw err;
      }
    },
  });

  // A person choosing a room's lead, or with null handing the choice back to config and the room's creator.
  ctx.http.register({
    method: "PUT",
    path: "rooms/:room/lead",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const room = roomFrom(req);
      if (!room) return noRoom(req);
      if (room.archived) return archived(room);
      const body = await req.json<Record<string, unknown>>().catch(() => null);
      const lead = field(body, "lead");
      if (lead === undefined) {
        return { status: 400, json: { error: "Say who leads it in `lead`, or null to go back to config's choice." } };
      }
      if (lead && !directory.agents().includes(lead)) {
        return { status: 400, json: { error: `There's no agent called "${lead}".` } };
      }
      try {
        await directory.saveRoomProfile(PERSON, room.ref, () => ({ lead: lead || null }));
      } catch (err) {
        if (err instanceof StateError) return { status: 400, json: { error: err.message } };
        throw err;
      }
      return { json: { lead: await directory.lead(room) } };
    },
  });

  // A person's edit to what a room is for and its note: theirs, so it stays as they left it.
  ctx.http.register({
    method: "PATCH",
    path: "rooms/:room/profile",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const room = roomFrom(req);
      if (!room) return noRoom(req);
      if (room.archived) return archived(room);
      const body = await req.json<Record<string, unknown>>().catch(() => null);
      const changes: Record<string, unknown> = {};
      const limits: Record<string, number> = { purpose: 600, howToAsk: 400, note: 300 };
      for (const [key, max] of Object.entries(limits)) {
        const value = field(body, key);
        if (value === undefined) continue;
        if (value.length > max) return { status: 400, json: { error: `Keep ${key} to ${max} characters at most.` } };
        changes[key] = value || null;
      }
      if (body && "takesOn" in body) {
        const takesOn = stringList(body.takesOn) ?? [];
        changes.takesOn = takesOn.length ? takesOn : null;
      }
      if (Object.keys(changes).length === 0) {
        return { status: 400, json: { error: "Give at least one of purpose, takesOn, howToAsk or note." } };
      }
      if ("note" in changes) changes.noteAt = changes.note ? directory.now().toISOString() : null;
      try {
        const profile = await directory.saveRoomProfile(PERSON, room.ref, () => changes);
        return { json: { profile } };
      } catch (err) {
        if (err instanceof StateError) return { status: 400, json: { error: err.message } };
        throw err;
      }
    },
  });

  // A person's edit to one of a room's commitments: written as them, with a dated update that says so.
  ctx.http.register({
    method: "PATCH",
    path: "rooms/:room/commitments/:id",
    handler: async (req): Promise<TaiHttpResponse> => {
      if (!directory.active()) return off();
      const room = roomFrom(req);
      if (!room) return noRoom(req);
      if (room.archived) return archived(room);
      const body = await req.json<Record<string, unknown>>().catch(() => null);
      const changes: Record<string, unknown> = {};
      const limits: Record<string, number> = {
        goal: 300,
        doneWhen: 500,
        nextStep: 300,
        nextCheck: 200,
        waitingOn: 200,
      };
      for (const [key, max] of Object.entries(limits)) {
        const value = field(body, key);
        if (value === undefined) continue;
        if (key === "goal" && !value) return { status: 400, json: { error: "A commitment needs a goal." } };
        if (value.length > max) return { status: 400, json: { error: `Keep ${key} to ${max} characters at most.` } };
        changes[key] = value || null;
      }
      const status = field(body, "status");
      if (status !== undefined) {
        if (!(STATUSES as readonly string[]).includes(status)) {
          return { status: 400, json: { error: `status is one of: ${STATUSES.join(", ")}.` } };
        }
        changes.status = status;
      }
      if (Object.keys(changes).length === 0) {
        return {
          status: 400,
          json: { error: "Give at least one of goal, doneWhen, nextStep, nextCheck, status or waitingOn." },
        };
      }
      try {
        const commitment = await directory.editRoomCommitment(room, req.params.id ?? "", changes);
        return { json: { commitment } };
      } catch (err) {
        if (err instanceof StateError) return { status: 400, json: { error: err.message } };
        throw err;
      }
    },
  });

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
};

export const meta: PluginMeta = {
  name: "Directory",
  description:
    "What agents and rooms are for, the work they've taken on and what they've written up: profile, commitment, doc and page records, the directory, commitment and writeup tools, a commitments block in the prompt, upkeep turns, room leads, and the routes behind agent and room pages.",
  registers: [
    { kind: "tool", id: "directory" },
    { kind: "tool", id: "commitment" },
    { kind: "tool", id: "writeup" },
    { kind: "stateType", id: PROFILE_TYPE },
    { kind: "stateType", id: COMMITMENT_TYPE },
    { kind: "stateType", id: DOC_TYPE },
    { kind: "stateType", id: MISS_TYPE },
    { kind: "stateType", id: PAGE_TYPE },
    { kind: "stateType", id: UPKEEP_TYPE },
    { kind: "httpRoutes", id: "builtin:directory" },
  ],
};

export default plugin;
