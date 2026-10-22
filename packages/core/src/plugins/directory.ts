/**
 * The directory: what each agent is for, the work it has taken on, and what
 * it has written up, kept as world-state records other agents can ask about.
 * Off by default; turn it on with `{ module: "builtin:directory", enabled: true }`.
 * See `docs/directory.md`, and `docs/ownership-design.md` for where it's going.
 *
 * It brings five record types (`profile`, `commitment`, `doc`, `miss`,
 * `page`), three tools (`directory`, `commitment`, `writeup`), a "Your
 * commitments" block in the prompt of every agent that has the `commitment`
 * tool, and the routes the agent pages in the web UI read and hand work over
 * through. It registers through the same seams a third-party plugin would,
 * and core knows nothing about it.
 *
 * Config (`plugins: [{ module: builtin:directory, config: {...} }]`):
 *   - `pin` (default true): the prompt block. `false` leaves it out.
 *   - `minMeaning` (default 0.5) and `minWords` (default 0.3): how close a
 *     search hit must be to count as found, for searches matched by meaning
 *     and by words. Below the bar a search finds nothing and notes a miss.
 *   - `upkeep`: `{ every, agents }` gives each agent an upkeep turn on that
 *     interval (`directory-upkeep.ts`), plus the bars its evidence is counted
 *     against. Off unless set; a person can still start one from the page.
 */

import { resolveAgent } from "../agent/agents.js";
import {
  type ContextSlot,
  type ContextSlotContext,
  listContextSlots,
  registerContextSlot,
  unregisterContextSlot,
} from "../agent/context-slots.js";
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession } from "../agent/session.js";
import { getExploratoryState } from "../db/exploratory-queries.js";
import type { TaiHttpResponse } from "../http/registry.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { Disposer } from "../registry.js";
import type { AgentRuntime } from "../runtime.js";
import type { StateCaller, StateService } from "../state/service.js";
import { StateError, type StateRecord, type StateTypeDef } from "../state/types.js";
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
  UPKEEP_TYPE,
} from "./directory-records.js";
import { CommitmentTool, commitmentLine, DirectoryTool, WriteupTool } from "./directory-tools.js";
import { changedOf, parseUpkeep, Upkeep, type UpkeepSettings } from "./directory-upkeep.js";
import { busy, everyWords, runNow, Tender, turnSession, UPKEEP_KIND, whyAsleep } from "./places-tend.js";

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
 * `upkeep:<agent>` session with the round budget as its ceiling.
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
    run: async (agent, session, message, maxRounds) => {
      const options = runtime.buildLoopOptions({
        session: session as ReturnType<typeof findOrCreateSession>,
        ...(agent === "default" ? {} : { agentName: agent }),
      });
      // The budget is a ceiling: an agent configured for fewer rounds keeps its own.
      const rounds = Math.min(options.maxToolRounds ?? maxRounds, maxRounds);
      await runAgentLoop(message, { ...options, maxToolRounds: rounds });
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
      for (const r of ordered.slice(0, PINNED)) {
        const full = commitmentLine(r, now) + (r.scope === `agent:${agent}` ? ", private" : "");
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
  const names = [...new Set([...directory.agents(), ...profileOf.keys()])].sort();
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

  const directoryFor = (getService: () => StateService) =>
    new Directory({
      getService,
      agents: () => roster(runtime),
      describe: (agent) => runtime.getAgentDefinition(agent)?.description?.trim() || undefined,
      bar: () => (live ?? config).bar,
      active: () => live !== null,
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
      unready: (agent) => asleep(runtime, agent),
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
  // pause. It runs on after the answer, which is 202; the page sees it start and finish from the state stream.
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
      const started = runNow(UPKEEP_KIND, agent, () => upkeep.turn(agent, { force: true }));
      if (!started) {
        // Turns on an interval go one at a time, a person's included: one is going now, this agent's or another's.
        const error = busy(UPKEEP_KIND, agent)
          ? `${agent} is already tidying up.`
          : "Another turn is running now: tends and upkeep go one at a time. Try again in a minute.";
        return { status: 409, json: { error } };
      }
      started.catch((err: unknown) => console.warn(`[directory] ${agent}'s upkeep failed: ${(err as Error).message}`));
      return { status: 202, json: { started: true } };
    },
  });

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
};

export const meta: PluginMeta = {
  name: "Directory",
  description:
    "What agents are for, the work they've taken on and what they've written up: profile, commitment, doc and page records, the directory, commitment and writeup tools, a commitments block in the prompt, upkeep turns, and the routes behind agent pages.",
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
