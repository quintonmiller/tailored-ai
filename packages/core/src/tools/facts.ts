import type Database from "better-sqlite3";
import type { Fact } from "../db/fact-queries.js";
import type { MemoryBackend, MemoryFragment } from "../memory/interface.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Durable typed memory: structured facts the agent can read and write
 * across sessions. Identified by (category, entity, key). Examples:
 *   - person / alice / birthday = 1988-03-12
 *   - subscription / netflix / monthly_cost = 22.99
 *
 * Phase 3 routes every action through `MemoryBackend`. The "facts"
 * concept becomes an agent-layer convention on top of the verb
 * interface: structured payload `{ category, entity, key }` with
 * `kind: "fact"` hint. Backends that don't index structured payloads
 * still work — the helper falls back to client-side filtering of the
 * returned fragments.
 */
export class FactsTool implements Tool {
  name = "facts";
  description =
    "Store and recall structured personal facts (people, subscriptions, things) saved in past sessions, not what is in the conversation in front of you. Use for atoms like birthdays, sizes, IDs, deadlines — not prose.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "set", "list", "forget", "search"],
        description:
          "get: fetch one fact. set: upsert. list: filter by category/entity. forget: delete. search: text-match.",
      },
      category: { type: "string", description: "Top-level grouping. e.g. person, subscription, vehicle, device." },
      entity: {
        type: "string",
        description: 'Optional identifier within a category. e.g. "alice" under person. Omit for category-level facts.',
      },
      key: { type: "string", description: "Attribute name. e.g. birthday, monthly_cost, tire_size." },
      value: { type: "string", description: "Value to store. Required for set." },
      asof: { type: "string", description: "Optional ISO date marking when this value was true." },
      source: {
        type: "string",
        description: 'Optional pointer to where the fact came from (e.g. "chat:2026-05-11", "document:abc").',
      },
      confidence: { type: "number", description: "Optional 0..1 confidence. Default unset." },
      query: {
        type: "string",
        description: "Search term for action=search. Matches category, entity, key, and value.",
      },
      project_id: {
        type: "string",
        description: 'Project scope. Default: active project. Use "global" for cross-project facts.',
      },
      limit: { type: "number", description: "Cap for list/search results. Default 50." },
    },
    required: ["action"],
  };

  private getBackend: () => Promise<MemoryBackend>;

  constructor(db: Database.Database, opts: { getMemoryBackend?: () => Promise<MemoryBackend> } = {}) {
    if (opts.getMemoryBackend) {
      this.getBackend = opts.getMemoryBackend;
    } else {
      let cached: MemoryBackend | undefined;
      this.getBackend = async () => {
        if (!cached) cached = new SqliteMemoryBackend(db);
        return cached;
      };
    }
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? "").toLowerCase();
    const projectId = resolveProjectId(args.project_id);
    const backend = await this.getBackend();

    try {
      switch (action) {
        case "get":
          return this.get(backend, args, projectId);
        case "set":
          return this.set(backend, args, projectId, context);
        case "list":
          return this.list(backend, args, projectId);
        case "forget":
          return this.forget(backend, args, projectId);
        case "search":
          return this.search(backend, args, projectId);
        default:
          return { success: false, output: "", error: `unknown action "${action}"` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async get(
    backend: MemoryBackend,
    args: Record<string, unknown>,
    projectId: string | null,
  ): Promise<ToolResult> {
    const category = String(args.category ?? "");
    const entity = String(args.entity ?? "");
    const key = String(args.key ?? "");
    if (!category || !key) {
      return { success: false, output: "", error: "category and key are required for get" };
    }
    const hits = await backend.query({
      scope: scopeOf(projectId),
      wantStructured: { category, entity, key },
      limit: 1,
    });
    const fact = hits.find(isFactFragment) ?? null;
    if (!fact) {
      return { success: true, output: `(no fact at ${describe(category, entity, key)})` };
    }
    return { success: true, output: formatFactFragment(fact) };
  }

  private async set(
    backend: MemoryBackend,
    args: Record<string, unknown>,
    projectId: string | null,
    context: ToolContext,
  ): Promise<ToolResult> {
    const category = String(args.category ?? "");
    const key = String(args.key ?? "");
    const value = args.value !== undefined ? String(args.value) : "";
    if (!category || !key) {
      return { success: false, output: "", error: "category and key are required for set" };
    }
    if (value === "") {
      return { success: false, output: "", error: "value is required for set" };
    }
    const entity = args.entity !== undefined ? String(args.entity) : "";
    const structured: Record<string, unknown> = { category, entity, key };
    if (args.asof !== undefined) structured.asof = String(args.asof);
    if (typeof args.confidence === "number") structured.confidence = args.confidence;

    await backend.write(
      { text: value, structured },
      {
        kind: "fact",
        scope: scopeOf(projectId),
        sourceUri:
          args.source !== undefined
            ? String(args.source)
            : context.agentName
              ? `agent:${context.agentName}`
              : undefined,
      },
    );

    // Echo back the canonical formatted form by re-reading. Keeps output
    // identical to the legacy `formatFact(upsertFact(...))` flow even when
    // the backend annotates with extra metadata on write.
    const written = await backend.query({
      scope: scopeOf(projectId),
      wantStructured: { category, entity, key },
      limit: 1,
    });
    const fragment = written.find(isFactFragment);
    return {
      success: true,
      output: fragment
        ? `saved: ${formatFactFragment(fragment)}`
        : `saved: ${describe(category, entity, key)} = ${value}`,
    };
  }

  private async list(
    backend: MemoryBackend,
    args: Record<string, unknown>,
    projectId: string | null,
  ): Promise<ToolResult> {
    if (!backend.list) {
      return { success: false, output: "", error: "list is not supported by the active memory backend" };
    }
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const fragments = await backend.list({
      scope: scopeOf(projectId),
      kind: "fact",
      limit,
    });
    const facts = fragments.filter(isFactFragment).filter((f) => matchesFilter(f, args));
    if (facts.length === 0) return { success: true, output: "(no facts match)" };
    return { success: true, output: facts.map(formatFactFragment).join("\n") };
  }

  private async forget(
    backend: MemoryBackend,
    args: Record<string, unknown>,
    projectId: string | null,
  ): Promise<ToolResult> {
    const category = String(args.category ?? "");
    const entity = String(args.entity ?? "");
    const key = String(args.key ?? "");
    if (!category || !key) {
      return { success: false, output: "", error: "category and key are required for forget" };
    }
    if (!backend.delete) {
      return { success: false, output: "", error: "delete is not supported by the active memory backend" };
    }
    const hits = await backend.query({
      scope: scopeOf(projectId),
      wantStructured: { category, entity, key },
      limit: 1,
    });
    const fragment = hits.find(isFactFragment);
    if (!fragment || !fragment.id) {
      return { success: true, output: "(no fact to forget)" };
    }
    const removed = await backend.delete(fragment.id);
    return {
      success: true,
      output: removed ? `forgot ${describe(category, entity, key)}` : "(no fact to forget)",
    };
  }

  private async search(
    backend: MemoryBackend,
    args: Record<string, unknown>,
    projectId: string | null,
  ): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query) {
      return { success: false, output: "", error: "query is required for search" };
    }
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const hits = await backend.query({
      scope: scopeOf(projectId),
      freeText: query,
      limit,
    });
    const facts = hits.filter(isFactFragment);
    if (facts.length === 0) return { success: true, output: `(no facts match "${query}")` };
    return { success: true, output: facts.map(formatFactFragment).join("\n") };
  }

  /** Test/internal helper. Returns the SQLite Fact shape when the active
   *  backend is SqliteMemoryBackend; otherwise null. */
  async resolveById(id: string): Promise<Fact | null> {
    const backend = await this.getBackend();
    if (!backend.get) return null;
    const fragment = await backend.get(id);
    return fragment ? fragmentToFact(fragment) : null;
  }

  /** Test/internal helper. */
  async removeById(id: string): Promise<boolean> {
    const backend = await this.getBackend();
    if (!backend.delete) return false;
    return backend.delete(id);
  }
}

function resolveProjectId(raw: unknown): string | null {
  if (typeof raw === "string") {
    if (raw === "global" || raw === "") return null;
    return raw;
  }
  return null;
}

function scopeOf(projectId: string | null): string {
  return projectId ? `project:${projectId}` : "global";
}

function describe(category: string, entity: string, key: string): string {
  return entity ? `${category}:${entity}/${key}` : `${category}/${key}`;
}

function isFactFragment(f: MemoryFragment): boolean {
  return f.metadata?.kind === "fact";
}

function matchesFilter(f: MemoryFragment, args: Record<string, unknown>): boolean {
  const md = f.metadata ?? {};
  if (typeof args.category === "string" && md.category !== args.category) return false;
  if (typeof args.entity === "string" && md.entity !== args.entity) return false;
  if (typeof args.key === "string" && md.key !== args.key) return false;
  return true;
}

function formatFactFragment(f: MemoryFragment): string {
  const md = f.metadata ?? {};
  const category = typeof md.category === "string" ? md.category : "?";
  const entity = typeof md.entity === "string" ? md.entity : "";
  const key = typeof md.key === "string" ? md.key : "?";
  const head = describe(category, entity, key);
  const meta: string[] = [];
  if (typeof md.asof === "string") meta.push(`asof=${md.asof}`);
  if (typeof md.confidence === "number") meta.push(`confidence=${md.confidence}`);
  if (typeof md.source === "string") meta.push(`source=${md.source}`);
  const suffix = meta.length ? `  (${meta.join(", ")})` : "";
  return `${head} = ${f.text}${suffix}`;
}

function fragmentToFact(f: MemoryFragment): Fact | null {
  const md = f.metadata ?? {};
  if (md.kind !== "fact") return null;
  return {
    id: typeof f.id === "string" && f.id.startsWith("fact:") ? f.id.slice("fact:".length) : (f.id ?? ""),
    category: typeof md.category === "string" ? md.category : "",
    entity: typeof md.entity === "string" ? md.entity : "",
    key: typeof md.key === "string" ? md.key : "",
    value: f.text,
    asof: typeof md.asof === "string" ? md.asof : null,
    source: typeof md.source === "string" ? md.source : null,
    confidence: typeof md.confidence === "number" ? md.confidence : null,
    project_id: typeof md.project_id === "string" ? md.project_id : null,
    created_at: typeof md.created_at === "string" ? md.created_at : "",
    updated_at: typeof md.updated_at === "string" ? md.updated_at : "",
  };
}
