/**
 * Pinned state in the prompt.
 *
 * An agent's `state.context` queries run every turn and the records they
 * match render behind the history, in the volatile `turn` group, so the agent
 * sees what is true now without spending a tool round to ask, and without
 * piecing it back together from forty messages of transcript.
 *
 * The query runs as the agent: the same scopes and the same read access a
 * `state` tool query would get, including the rooms a room wake is about.
 */
import type { ContextSlot, ContextSlotContext } from "../agent/context-slots.js";
import { formatRecordList, parseOrderBy } from "./format.js";
import type { StateCaller, StateService } from "./service.js";
import type { StateContextQuery } from "./types.js";

/** Records per query when the query does not say. Small: every one lands in every turn's prompt. */
const DEFAULT_CONTEXT_LIMIT = 10;
/** The slot's ceiling. Core cuts past it and says so in the text. */
const STATE_SLOT_BUDGET_TOKENS = 2_000;

/** Queries whose failure has already been logged, so a broken one warns once, not every turn. */
const warned = new Set<string>();

/** The slot for one agent's pinned queries. */
export function stateContextSlot(getService: () => StateService, queries: StateContextQuery[]): ContextSlot {
  return {
    id: "state",
    refresh: "turn",
    title: "Current state",
    budgetTokens: STATE_SLOT_BUDGET_TOKENS,
    render: async (ctx) => {
      const service = getService();
      const caller = callerFor(ctx);
      const sections: string[] = [];
      for (const query of queries) {
        const section = await renderQuery(service, caller, query);
        if (section) sections.push(section);
      }
      return sections.join("\n\n");
    },
  };
}

async function renderQuery(
  service: StateService,
  caller: StateCaller,
  query: StateContextQuery,
): Promise<string | undefined> {
  const limit = query.limit && query.limit > 0 ? Math.floor(query.limit) : DEFAULT_CONTEXT_LIMIT;
  try {
    const records = await service.query(caller, {
      type: query.type,
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.where ? { where: query.where } : {}),
      ...parseOrderBy(query.orderBy),
      limit,
    });
    const lines = [describe(query), formatRecordList(query.type, records, service.getType(query.type)?.title)];
    if (records.length === limit) lines.push(`Showing the first ${limit}; there may be more.`);
    return lines.join("\n");
  } catch (err) {
    const key = `${caller.actor.name}:${JSON.stringify(query)}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(
        `[state] ${caller.actor.name}'s pinned ${query.type} query failed and was left out of its prompt: ${(err as Error).message}`,
      );
    }
    return undefined;
  }
}

/** The query as one line, so the agent knows what the records below it are. */
function describe(query: StateContextQuery): string {
  const parts = [query.type];
  if (query.where && Object.keys(query.where).length) parts.push(`where ${JSON.stringify(query.where)}`);
  if (query.scope) parts.push(`in ${query.scope}`);
  if (query.orderBy) parts.push(`by ${query.orderBy}`);
  return `${parts.join(" ")}:`;
}

function callerFor(ctx: ContextSlotContext): StateCaller {
  return {
    actor: { kind: "agent", name: ctx.agent ?? "default" },
    source: { surface: "context" },
    rooms: ctx.rooms ?? [],
    projectId: ctx.projectId,
  };
}

/** Test seam: forget which broken queries have been reported. */
export function resetStateSlotWarnings(): void {
  warned.clear();
}
