import { WAKE_ROOMS_KEY } from "../rooms/keys.js";
import { formatRecordList, parseOrderBy } from "../state/format.js";
import type { StateCaller, StateService, StateTypeView } from "../state/service.js";
import { type FieldCondition, StateConflictError, StateError, type StateRecord } from "../state/types.js";
import { summarizeFields } from "../state/validate.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/** A query's default page. Small, because every record lands in the prompt. */
const DEFAULT_LIMIT = 20;

/**
 * World state for an agent: one tool, six actions.
 *
 * One tool rather than six because every tool costs attention and history
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
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["types", "get", "query", "put", "patch", "delete"],
        description:
          "types: what exists. get: one record. query: records matching `where`. put: create, or replace by id. patch: change some fields. delete: remove it (its history is kept).",
      },
      type: { type: "string", description: 'Record type, e.g. "plan". Required except for types.' },
      id: {
        type: "string",
        description: "Record id. Required for get, patch and delete. For put, omit it to create a new record.",
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
        description:
          'Optional. Where a new record goes, or the one scope to query: "global", "agent:<name>", "room:<ref>".',
      },
      orderBy: {
        type: "string",
        description:
          'query: field to sort by, "-" first for descending (e.g. "-priority"). Default: most recently updated.',
      },
      limit: { type: "number", description: `query: at most this many records. Default ${DEFAULT_LIMIT}.` },
      expectedVersion: {
        type: "number",
        description: "put or patch: write only if the record is still at this version.",
      },
    },
    required: ["action"],
  };

  constructor(private readonly getService: () => StateService) {}

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
      if (!["get", "query", "put", "patch", "delete"].includes(action)) {
        return fail(`Unknown action "${args.action}". Use one of: types, get, query, put, patch, delete.`);
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

function callerFrom(context: ToolContext): StateCaller {
  const rooms = (context.workingMemory?.get(WAKE_ROOMS_KEY) ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return {
    actor: { kind: "agent", name: context.agentName ?? "default" },
    source: { tool: "state" },
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
      lines.push(
        `  new records go in ${where[def.scope ?? "global"]}; you can ${canWrite ? "read and write" : "only read"}`,
      );
      return lines.join("\n");
    })
    .join("\n");
}

function formatRecord(record: StateRecord): string {
  const by = record.updatedBy.kind === "agent" ? record.updatedBy.name : record.updatedBy.kind;
  return (
    `${record.type}/${record.id} (version ${record.version}, scope ${record.scope}, updated ${record.updatedAt} by ${by})\n` +
    JSON.stringify(record.data)
  );
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}
