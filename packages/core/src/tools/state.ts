import { WAKE_ROOMS_KEY } from "../rooms/keys.js";
import { actorName, archivedLine, formatRecordList, formatSearchHits, parseOrderBy } from "../state/format.js";
import { searchFields } from "../state/search.js";
import type { StateCaller, StateService, StateTypeView } from "../state/service.js";
import { type FieldCondition, StateConflictError, StateError, type StateRecord } from "../state/types.js";
import { summarizeFields } from "../state/validate.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/** A query's default page. Small, because every record lands in the prompt. */
const DEFAULT_LIMIT = 20;
/** A search's default number of hits, smaller still: it should find the few that matter. */
const SEARCH_LIMIT = 8;

/**
 * The tool's parameters, without search or with it. `search` and `text` are
 * offered only once some type opts into search: until then they would cost
 * every agent schema it can't use, and invite a call that can only fail.
 * Both are built once, so the schema an agent sees changes only when that
 * does.
 */
function schemaFor(search: boolean): Record<string, unknown> {
  const actions = ["types", "get", "query", ...(search ? ["search"] : []), "put", "patch", "delete", "archive"];
  const searchLine = search ? " search: records about `text`, closest first." : "";
  const reads = search ? "query or search" : "query";
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...actions, "unarchive"],
        description: `types: what exists. get: one record. query: records matching \`where\`.${searchLine} put: create, or replace by id. patch: change some fields. archive: retire it, kept but left out of queries; better than delete for anything that may matter again. unarchive: bring it back. delete: remove it (its history is kept).`,
      },
      type: {
        type: "string",
        description: search
          ? 'Record type, e.g. "plan". Required except for types and search; search takes one, several comma-separated, or none for every searchable type.'
          : 'Record type, e.g. "plan". Required except for types.',
      },
      ...(search ? { text: { type: "string", description: "search: what to look for, in a few words." } } : {}),
      id: {
        type: "string",
        description:
          "Record id. Required for get, patch, delete, archive and unarchive. For put, omit it to create a new record.",
      },
      data: {
        type: "object",
        description: "put: the whole record. patch: only the fields to change; set a field to null to remove it.",
      },
      where: {
        type: "object",
        description: 'query: conditions on fields, e.g. {"status": "active"} or {"priority": {"gte": 3}}.',
      },
      scope: {
        type: "string",
        description: `Optional. Where a new record goes, or the one scope to ${search ? "query or search" : "query"}: "global", "agent:<name>", "room:<ref>".`,
      },
      orderBy: {
        type: "string",
        description:
          'query: field to sort by, "-" first for descending (e.g. "-priority"). Default: most recently updated.',
      },
      limit: {
        type: "number",
        description: search
          ? `query or search: at most this many records. Default ${DEFAULT_LIMIT}, or ${SEARCH_LIMIT} for search.`
          : `query: at most this many records. Default ${DEFAULT_LIMIT}.`,
      },
      includeArchived: { type: "boolean", description: `${reads}: include archived records.` },
      reason: { type: "string", description: "archive: why, in a few words." },
      expectedVersion: {
        type: "number",
        description: "put, patch, archive or unarchive: write only if the record is still at this version.",
      },
    },
    required: ["action"],
  };
}

const PLAIN_SCHEMA = schemaFor(false);
const SEARCH_SCHEMA = schemaFor(true);

/**
 * World state for an agent: one tool, eight actions, and a ninth, `search`,
 * once a type opts into it.
 *
 * One tool rather than nine because every tool costs attention and history
 * budget, and that cost is steepest on the small local models TAI has to
 * work well on. For the same reason output is compact — field summaries
 * rather than JSON Schema, one line per record — and every failure is a
 * sentence saying what to do instead.
 *
 * The caller's identity, rooms and project come from the tool context, never
 * from arguments, so an agent cannot read or write as another agent.
 */
export class StateTool implements Tool {
  name = "state";
  description =
    'Read and write shared, structured state: typed records other agents and people also see. Start with action "types" to see what exists and each type\'s fields.';

  constructor(private readonly getService: () => StateService) {}

  /**
   * Read on every request, so a type that opts into search later (a plugin
   * loaded after this tool was built, a config edit) brings `search` in
   * without rebuilding the tool.
   */
  get parameters(): Record<string, unknown> {
    return this.offersSearch() ? SEARCH_SCHEMA : PLAIN_SCHEMA;
  }

  private offersSearch(): boolean {
    try {
      return this.getService()
        .types()
        .some((def) => searchFields(def).length > 0);
    } catch {
      return false;
    }
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const service = this.getService();
    const caller = callerFrom(context);
    const action = String(args.action ?? "").toLowerCase();
    const type = typeof args.type === "string" ? args.type.trim() : "";
    const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
    const scope = typeof args.scope === "string" && args.scope.trim() ? args.scope.trim() : undefined;
    const expectedVersion = typeof args.expectedVersion === "number" ? args.expectedVersion : undefined;

    try {
      if (action === "types") return ok(formatTypes(service.listTypes(caller)));
      if (action === "search") return await search(service, caller, args, scope);
      if (!ACTIONS.includes(action)) {
        const offered = ["types", ...(this.offersSearch() ? ["search"] : []), ...ACTIONS];
        return fail(`Unknown action "${args.action}". Use one of: ${offered.join(", ")}.`);
      }
      if (!type) return fail(`Say which type with \`type\`. Use action "types" to see what exists.`);
      const title = service.getType(type)?.title;

      switch (action) {
        case "get": {
          if (!id) return fail("get needs the record's `id`.");
          const record = await service.get(caller, { type, id });
          return record ? ok(formatRecord(record)) : fail(`There is no ${type} record with id "${id}".`);
        }
        case "query": {
          const where = objectArg(args.where, "where");
          const records = await service.query(caller, {
            type,
            ...(scope ? { scope } : {}),
            ...(where ? { where: where as Record<string, FieldCondition> } : {}),
            ...parseOrderBy(args.orderBy),
            limit: typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT,
            ...(args.includeArchived === true || args.includeArchived === "true" ? { includeArchived: true } : {}),
          });
          return ok(formatRecordList(type, records, title));
        }
        case "put": {
          const data = objectArg(args.data, "data");
          if (!data) return fail("put needs `data`: the whole record, as an object of field names to values.");
          const record = await service.put(
            caller,
            { type, ...(id ? { id } : {}), ...(scope ? { scope } : {}), data },
            expectedVersion,
          );
          return ok(`Saved ${record.type}/${record.id} (version ${record.version}, scope ${record.scope}).`);
        }
        case "patch": {
          if (!id) return fail("patch needs the record's `id`.");
          const changes = objectArg(args.data, "data");
          if (!changes) return fail("patch needs `data`: the fields to change, as an object.");
          const record = await service.patch(caller, { type, id }, changes, expectedVersion);
          return ok(`Updated ${record.type}/${record.id} (version ${record.version}).`);
        }
        case "archive": {
          if (!id) return fail("archive needs the record's `id`.");
          const reason = typeof args.reason === "string" ? args.reason : undefined;
          const archived = await service.archive(caller, { type, id }, reason, expectedVersion);
          return archived
            ? ok(`Archived ${type}/${id}. Queries leave it out now; action "unarchive" brings it back.`)
            : fail(`There is no ${type} record with id "${id}" to archive.`);
        }
        case "unarchive": {
          if (!id) return fail("unarchive needs the record's `id`.");
          // Unarchiving a live record changes nothing, and saying it "is back" would suggest it was gone.
          const found = await service.get(caller, { type, id });
          if (found && !found.archivedAt) return ok(`${type}/${id} isn't archived; nothing to do.`);
          const restored = found ? await service.unarchive(caller, { type, id }, expectedVersion) : null;
          return restored
            ? ok(`${type}/${id} is back (version ${restored.version}).`)
            : fail(`There is no ${type} record with id "${id}" to unarchive.`);
        }
        default: {
          if (!id) return fail("delete needs the record's `id`.");
          const removed = await service.delete(caller, { type, id });
          return removed
            ? ok(`Deleted ${type}/${id}. Its history is kept.`)
            : fail(`There is no ${type} record with id "${id}" to delete.`);
        }
      }
    } catch (err) {
      if (err instanceof StateConflictError) {
        return fail(`${err.message} Read it again with action "get", then make your change against what is there now.`);
      }
      if (err instanceof StateError) return fail(err.message);
      return fail(`State is unavailable right now: ${(err as Error).message}`);
    }
  }
}

/** Every action but `types` and `search`, which need no record type. */
const ACTIONS = ["get", "query", "put", "patch", "delete", "archive", "unarchive"];

async function search(
  service: StateService,
  caller: StateCaller,
  args: Record<string, unknown>,
  scope: string | undefined,
): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return fail('search needs `text`: what to look for, e.g. "hotel prices in Lisbon".');
  // `types` isn't in the schema, but a model that sends it means the same as `type`.
  const types = listArg(args.type ?? args.types);
  const searchable = service
    .listTypes(caller)
    .filter((v) => searchFields(v.def).length > 0)
    .map((v) => v.def.name);
  if (types.length === 0 && searchable.length === 0) {
    return fail(
      'None of the types you can read are searchable. Use action "query" to filter records by field instead.',
    );
  }
  const { hits, partial } = await service.search(caller, {
    text,
    ...(types.length ? { types } : {}),
    ...(scope ? { scope } : {}),
    limit: typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : SEARCH_LIMIT,
    ...(args.includeArchived === true || args.includeArchived === "true" ? { includeArchived: true } : {}),
  });
  return ok(formatSearchHits(text, hits, types.length ? types : searchable, partial, (t) => service.getType(t)?.title));
}

/** A list of names from an array, or from one string with commas between them. */
function listArg(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function callerFrom(context: ToolContext): StateCaller {
  return agentStateCaller(context, "state");
}

/**
 * The agent behind a tool call, as world state sees it: its name, the rooms
 * the turn is about, and its project, all from the tool context rather than
 * an argument, so an agent cannot read as someone else.
 */
export function agentStateCaller(context: ToolContext, tool: string): StateCaller {
  const rooms = (context.workingMemory?.get(WAKE_ROOMS_KEY) ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return {
    actor: { kind: "agent", name: context.agentName ?? "default" },
    source: { tool },
    rooms,
    projectId: context.projectId ?? null,
  };
}

/**
 * Models, especially small ones, often send an object argument as a JSON
 * string. Accept that rather than failing a write over its encoding.
 */
function objectArg(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new StateError(`\`${name}\` must be an object, and this text is not valid JSON.`);
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateError(`\`${name}\` must be an object of field names to values.`);
  }
  return value as Record<string, unknown>;
}

function formatTypes(views: StateTypeView[]): string {
  if (views.length === 0) return "There are no state types you can use.";
  const where: Record<string, string> = {
    global: "shared by everyone",
    room: "the room you are in",
    agent: "your own scope",
    project: "the current project",
  };
  return views
    .map(({ def, canWrite }) => {
      const lines = [`- ${def.name}${def.description ? `: ${def.description}` : ""}`];
      lines.push(`  fields: ${summarizeFields(def.schema)}`);
      const fields = searchFields(def);
      if (fields.length) lines.push(`  searchable by: ${fields.join(", ")}`);
      lines.push(
        `  new records go in ${where[def.scope ?? "global"]}; you can ${canWrite ? "read and write" : "only read"}`,
      );
      return lines.join("\n");
    })
    .join("\n");
}

function formatRecord(record: StateRecord): string {
  const archived = archivedLine(record);
  return (
    `${record.type}/${record.id} (version ${record.version}, scope ${record.scope}, updated ${record.updatedAt} by ${actorName(record.updatedBy)})\n` +
    (archived ? `${archived} Action "unarchive" brings it back.\n` : "") +
    JSON.stringify(record.data)
  );
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}
