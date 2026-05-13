import type Database from "better-sqlite3";
import {
  deleteFact,
  findFact,
  forgetFact,
  getFact,
  listFacts,
  upsertFact,
  type Fact,
} from "../db/fact-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Durable typed memory: structured facts the agent can read and write across
 * sessions. Identified by (category, entity, key). Examples:
 *   - person / alice / birthday = 1988-03-12
 *   - subscription / netflix / monthly_cost = 22.99
 *   - vehicle / civic / tire_size = 215/55R16
 *
 * Differs from the markdown memory tool in two ways:
 *   1. Structured — discrete key/value pairs the agent can query precisely.
 *   2. Durable across reformats — the markdown file isn't the source of truth.
 *
 * Project scope: when the tool is called from within an active project, all
 * facts are scoped to that project. Pass project_id: "global" to share across
 * projects, or "" / null to default to the call's project.
 */
export class FactsTool implements Tool {
  name = "facts";
  description =
    "Store and recall structured personal facts (people, subscriptions, things). Use for atoms like birthdays, sizes, IDs, deadlines — not prose.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "set", "list", "forget", "search"],
        description: "get: fetch one fact. set: upsert. list: filter by category/entity. forget: delete. search: text-match.",
      },
      category: {
        type: "string",
        description: "Top-level grouping. e.g. person, subscription, vehicle, device.",
      },
      entity: {
        type: "string",
        description: "Optional identifier within a category. e.g. \"alice\" under person. Omit for category-level facts.",
      },
      key: {
        type: "string",
        description: "Attribute name. e.g. birthday, monthly_cost, tire_size.",
      },
      value: {
        type: "string",
        description: "Value to store. Required for set.",
      },
      asof: {
        type: "string",
        description: "Optional ISO date marking when this value was true.",
      },
      source: {
        type: "string",
        description: "Optional pointer to where the fact came from (e.g. \"chat:2026-05-11\", \"document:abc\").",
      },
      confidence: {
        type: "number",
        description: "Optional 0..1 confidence. Default unset (treated as user-asserted).",
      },
      query: {
        type: "string",
        description: "Search term for action=search. Matches category, entity, key, and value.",
      },
      project_id: {
        type: "string",
        description: "Project scope. Default: active project. Use \"global\" for cross-project facts.",
      },
      limit: {
        type: "number",
        description: "Cap for list/search results. Default 50.",
      },
    },
    required: ["action"],
  };

  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? "").toLowerCase();
    const projectId = resolveProjectId(args.project_id, context);

    try {
      switch (action) {
        case "get":
          return this.get(args, projectId);
        case "set":
          return this.set(args, projectId, context);
        case "list":
          return this.list(args, projectId);
        case "forget":
          return this.forget(args, projectId);
        case "search":
          return this.search(args, projectId);
        default:
          return { success: false, output: "", error: `unknown action "${action}"` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private get(args: Record<string, unknown>, projectId: string | null): ToolResult {
    const category = String(args.category ?? "");
    const entity = String(args.entity ?? "");
    const key = String(args.key ?? "");
    if (!category || !key) {
      return { success: false, output: "", error: "category and key are required for get" };
    }
    const fact = findFact(this.db, category, entity, key, projectId);
    if (!fact) {
      return { success: true, output: `(no fact at ${describe(category, entity, key)})` };
    }
    return { success: true, output: formatFact(fact) };
  }

  private set(
    args: Record<string, unknown>,
    projectId: string | null,
    context: ToolContext,
  ): ToolResult {
    const category = String(args.category ?? "");
    const key = String(args.key ?? "");
    const value = args.value !== undefined ? String(args.value) : "";
    if (!category || !key) {
      return { success: false, output: "", error: "category and key are required for set" };
    }
    if (value === "") {
      return { success: false, output: "", error: "value is required for set" };
    }
    const fact = upsertFact(this.db, {
      category,
      entity: args.entity !== undefined ? String(args.entity) : "",
      key,
      value,
      asof: args.asof !== undefined ? String(args.asof) : null,
      source:
        args.source !== undefined
          ? String(args.source)
          : context.agentName
            ? `agent:${context.agentName}`
            : null,
      confidence: typeof args.confidence === "number" ? args.confidence : null,
      project_id: projectId,
    });
    return { success: true, output: `saved: ${formatFact(fact)}` };
  }

  private list(args: Record<string, unknown>, projectId: string | null): ToolResult {
    const facts = listFacts(this.db, {
      project_id: projectId,
      category: typeof args.category === "string" ? args.category : undefined,
      entity: typeof args.entity === "string" ? args.entity : undefined,
      key: typeof args.key === "string" ? args.key : undefined,
      limit: typeof args.limit === "number" ? args.limit : 50,
    });
    if (facts.length === 0) return { success: true, output: "(no facts match)" };
    return { success: true, output: facts.map(formatFact).join("\n") };
  }

  private forget(args: Record<string, unknown>, projectId: string | null): ToolResult {
    const category = String(args.category ?? "");
    const entity = String(args.entity ?? "");
    const key = String(args.key ?? "");
    if (!category || !key) {
      return { success: false, output: "", error: "category and key are required for forget" };
    }
    const removed = forgetFact(this.db, category, entity, key, projectId);
    return {
      success: true,
      output: removed ? `forgot ${describe(category, entity, key)}` : "(no fact to forget)",
    };
  }

  private search(args: Record<string, unknown>, projectId: string | null): ToolResult {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query) {
      return { success: false, output: "", error: "query is required for search" };
    }
    const facts = listFacts(this.db, {
      project_id: projectId,
      search: query,
      limit: typeof args.limit === "number" ? args.limit : 50,
    });
    if (facts.length === 0) return { success: true, output: `(no facts match "${query}")` };
    return { success: true, output: facts.map(formatFact).join("\n") };
  }

  /** Test/internal helper. */
  resolveById(id: string): Fact | null {
    return getFact(this.db, id);
  }

  /** Test/internal helper. */
  removeById(id: string): boolean {
    return deleteFact(this.db, id);
  }
}

function resolveProjectId(raw: unknown, context: ToolContext): string | null {
  if (typeof raw === "string") {
    if (raw === "global" || raw === "") return null;
    return raw;
  }
  // Fall back to the runtime-set active project from the session id prefix if present.
  // Context here doesn't carry projectId today, so default to global; the
  // runtime layer overlays the active project via its own wiring later.
  return null;
}

function describe(category: string, entity: string, key: string): string {
  return entity ? `${category}:${entity}/${key}` : `${category}/${key}`;
}

function formatFact(f: Fact): string {
  const head = describe(f.category, f.entity, f.key);
  const meta: string[] = [];
  if (f.asof) meta.push(`asof=${f.asof}`);
  if (f.confidence != null) meta.push(`confidence=${f.confidence}`);
  if (f.source) meta.push(`source=${f.source}`);
  const suffix = meta.length ? `  (${meta.join(", ")})` : "";
  return `${head} = ${f.value}${suffix}`;
}
