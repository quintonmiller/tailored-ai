/**
 * The directory: what each agent is for, the work it has taken on, and what
 * it has written up, kept as world-state records other agents can ask about.
 * Off by default; turn it on with `{ module: "builtin:directory", enabled: true }`.
 * See `docs/directory.md`, and `docs/ownership-design.md` for where it's going.
 *
 * It brings four record types (`profile`, `commitment`, `doc`, `miss`), three
 * tools (`directory`, `commitment`, `writeup`), a "Your commitments" block in
 * the prompt of every agent that has the `commitment` tool, and two read-only
 * routes for the agent pages. It registers through the same seams a
 * third-party plugin would, and core knows nothing about it.
 *
 * Config (`plugins: [{ module: builtin:directory, config: {...} }]`):
 *   - `pin` (default true): the prompt block. `false` leaves it out.
 *   - `minMeaning` (default 0.5) and `minWords` (default 0.3): how close a
 *     search hit must be to count as found, for searches matched by meaning
 *     and by words. Below the bar a search finds nothing and notes a miss.
 */
import {
  type ContextSlot,
  type ContextSlotContext,
  listContextSlots,
  registerContextSlot,
  unregisterContextSlot,
} from "../agent/context-slots.js";
import type { TaiHttpResponse } from "../http/registry.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { Disposer } from "../registry.js";
import type { AgentRuntime } from "../runtime.js";
import type { StateCaller, StateService } from "../state/service.js";
import type { StateRecord, StateTypeDef } from "../state/types.js";
import {
  ACTIVE,
  type Bar,
  COMMITMENT_TYPE,
  DEFAULT_BAR,
  DIRECTORY_TYPES,
  Directory,
  DOC_TYPE,
  MISS_TYPE,
  ownerOf,
  PERSON,
  PROFILE_TYPE,
  profileId,
} from "./directory-records.js";
import { CommitmentTool, commitmentLine, DirectoryTool, WriteupTool } from "./directory-tools.js";

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
}

/**
 * The config of the load in effect, or null once the plugin is unloaded with
 * nothing in its place. A reload rebuilds the tool set before it reloads
 * plugins, so agents keep the tools an older load built until the reload
 * after. Those tools read this rather than their own load's config: a new
 * bar applies at once, and a plugin turned off says so instead of failing
 * against types that are gone.
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

  ctx.http.register({
    method: "GET",
    path: "agents",
    handler: async (): Promise<TaiHttpResponse> => ({ json: { agents: await agentSummaries(directory) } }),
  });

  ctx.http.register({
    method: "GET",
    path: "agents/:name",
    handler: async (req): Promise<TaiHttpResponse> => {
      const name = req.params.name ?? "";
      const agent = await directory.resolve(name);
      if (!agent) return { status: 404, json: { error: `There's no agent called "${name}".` } };
      const where = { owner: agent };
      const [profile, commitments, docs, misses] = await Promise.all([
        runtime.getStateService().get(PERSON, { type: PROFILE_TYPE, id: profileId(agent) }),
        directory.all(COMMITMENT_TYPE, where),
        directory.all(DOC_TYPE, where),
        directory.all(MISS_TYPE, where),
      ]);
      const description = directory.describe(agent);
      return {
        json: {
          name: agent,
          profile: profile && !profile.archivedAt ? profile : null,
          ...(description ? { description } : {}),
          commitments,
          docs,
          misses,
        },
      };
    },
  });

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
};

export const meta: PluginMeta = {
  name: "Directory",
  description:
    "What agents are for, the work they've taken on and what they've written up: profile, commitment and doc records, the directory, commitment and writeup tools, and a commitments block in the prompt.",
  registers: [
    { kind: "tool", id: "directory" },
    { kind: "tool", id: "commitment" },
    { kind: "tool", id: "writeup" },
    { kind: "stateType", id: PROFILE_TYPE },
    { kind: "stateType", id: COMMITMENT_TYPE },
    { kind: "stateType", id: DOC_TYPE },
    { kind: "stateType", id: MISS_TYPE },
    { kind: "httpRoutes", id: "builtin:directory" },
  ],
};

export default plugin;
