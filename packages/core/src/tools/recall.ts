import type Database from "better-sqlite3";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  type Note,
} from "../db/note-queries.js";
import { formatHits, recallQuery, type Tier } from "./recall-query.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Tiered memory surface. See docs/memory-tiers.md.
 *
 * Actions:
 *   - query   Search notes (short-term) and facts (long-term) by relevance.
 *   - note    Write a new short-term note. Tags / TTL / importance optional.
 *   - forget  Delete a note by ID.
 *   - list    Plain unranked list of recent notes.
 */
export class RecallTool implements Tool {
  name = "recall";
  description =
    "Search and write short-term memory. Use query to find relevant notes + facts; note to save an observation; forget/list to manage notes.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["query", "note", "forget", "list"],
        description: "query: ranked search. note: write prose. forget: delete by id. list: show recent notes.",
      },
      query: {
        type: "string",
        description: "Search terms (required for action=query). Coverage is scored over notes content/tags and fact category/entity/key/value.",
      },
      tier: {
        type: "string",
        enum: ["any", "short", "long"],
        description: "Limit query to one tier. Default: any (union of notes + facts).",
      },
      content: {
        type: "string",
        description: "Note body (required for action=note).",
      },
      tags: {
        type: "array",
        description: "Optional tags for the note.",
      },
      importance: {
        type: "number",
        description: "Optional 0..1 importance. Notes >= 0.8 survive TTL sweeps.",
      },
      ttl_days: {
        type: "number",
        description: "Optional retention window in days. Omit for the default (14).",
      },
      id: {
        type: "string",
        description: "Note id (required for action=forget).",
      },
      project_id: {
        type: "string",
        description: 'Project scope. Default: active project. Use "global" for cross-project notes.',
      },
      limit: {
        type: "number",
        description: "Cap for list. Default 10.",
      },
      tag: {
        type: "string",
        description: "Filter list to notes carrying this tag.",
      },
    },
    required: ["action"],
  };

  private db: Database.Database;
  private defaultTtlDays: number;

  constructor(db: Database.Database, opts: { defaultTtlDays?: number } = {}) {
    this.db = db;
    this.defaultTtlDays = opts.defaultTtlDays ?? 14;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? "").toLowerCase();
    const projectId = resolveProjectId(args.project_id);

    try {
      switch (action) {
        case "query":
          return this.query(args, projectId);
        case "note":
          return this.note(args, context, projectId);
        case "forget":
          return this.forget(args);
        case "list":
          return this.list(args, context, projectId);
        default:
          return { success: false, output: "", error: `unknown action "${action}"` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private query(args: Record<string, unknown>, projectId: string | null): ToolResult {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { success: false, output: "", error: "query is required for action=query" };
    }
    const tierArg = typeof args.tier === "string" ? args.tier : "any";
    if (tierArg !== "any" && tierArg !== "short" && tierArg !== "long") {
      return { success: false, output: "", error: `invalid tier "${tierArg}" — use any|short|long` };
    }
    const limit = typeof args.limit === "number" ? args.limit : 5;
    const hits = recallQuery(this.db, {
      query,
      tier: tierArg as "any" | Tier,
      projectId,
      limit,
    });
    return { success: true, output: formatHits(hits) };
  }

  private note(
    args: Record<string, unknown>,
    context: ToolContext,
    projectId: string | null,
  ): ToolResult {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return { success: false, output: "", error: "content is required for action=note" };
    }
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((t): t is string => typeof t === "string")
      : [];
    const importance = typeof args.importance === "number" ? args.importance : null;
    const ttlDays = typeof args.ttl_days === "number" ? args.ttl_days : this.defaultTtlDays;
    const ttlAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null;

    const note = createNote(this.db, {
      content,
      session_id: context.sessionId ?? null,
      project_id: projectId,
      agent: context.agentName ?? null,
      tags,
      importance,
      ttl_at: ttlAt,
    });
    return { success: true, output: `saved ${note.id}` };
  }

  private forget(args: Record<string, unknown>): ToolResult {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) {
      return { success: false, output: "", error: "id is required for action=forget" };
    }
    const existing = getNote(this.db, id);
    if (!existing) {
      return { success: true, output: `(no note with id ${id})` };
    }
    deleteNote(this.db, id);
    return { success: true, output: `forgot ${id}` };
  }

  private list(
    args: Record<string, unknown>,
    _context: ToolContext,
    projectId: string | null,
  ): ToolResult {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const tag = typeof args.tag === "string" && args.tag.length > 0 ? args.tag : undefined;
    const notes = listNotes(this.db, {
      project_id: projectId,
      tag,
      limit,
      excludeExpired: true,
    });
    if (notes.length === 0) {
      return { success: true, output: "(no notes)" };
    }
    return { success: true, output: notes.map(formatNote).join("\n") };
  }
}

function resolveProjectId(raw: unknown): string | null {
  if (typeof raw === "string") {
    if (raw === "global" || raw === "") return null;
    return raw;
  }
  return null;
}

function formatNote(n: Note): string {
  const meta: string[] = [n.created_at.slice(0, 16).replace("T", " ")];
  if (n.tags.length) meta.push(`tags=${n.tags.join(",")}`);
  if (n.importance != null) meta.push(`importance=${n.importance}`);
  const head = `${n.id}  (${meta.join(", ")})`;
  const body = n.content.length > 200 ? `${n.content.slice(0, 200)}…` : n.content;
  return `${head}\n  ${body}`;
}
