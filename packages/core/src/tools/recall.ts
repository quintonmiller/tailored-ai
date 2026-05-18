import type Database from "better-sqlite3";
import { promoteNote } from "../agent/memory-promotion.js";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  type Note,
} from "../db/note-queries.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { formatHits, recallQuery, recallQueryAsync, type Tier } from "./recall-query.js";
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
        enum: ["query", "note", "forget", "list", "promote", "archive"],
        description: "query: ranked search. note: write prose. forget: delete by id. list: show recent notes. promote: clone a note into long-term semantic memory. archive: mark a note as durable (survives TTL sweeps) — requires reason.",
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
        description: "Note id (required for action=forget and action=promote).",
      },
      force: {
        type: "boolean",
        description: "For promote: re-index even when chunks already exist.",
      },
      reason: {
        type: "string",
        description: "Required for action=archive — a one-liner on why this note is worth keeping forever. Forces selectivity; over-archiving crowds out signal.",
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
  private getEmbedder?: () => EmbeddingProvider | undefined;
  private embedModel?: string;

  constructor(
    db: Database.Database,
    opts: {
      defaultTtlDays?: number;
      getEmbedder?: () => EmbeddingProvider | undefined;
      embedModel?: string;
    } = {},
  ) {
    this.db = db;
    this.defaultTtlDays = opts.defaultTtlDays ?? 14;
    this.getEmbedder = opts.getEmbedder;
    this.embedModel = opts.embedModel;
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
        case "promote":
          return this.promote(args);
        case "archive":
          return this.archive(args);
        default:
          return { success: false, output: "", error: `unknown action "${action}"` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async query(
    args: Record<string, unknown>,
    projectId: string | null,
  ): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { success: false, output: "", error: "query is required for action=query" };
    }
    const tierArg = typeof args.tier === "string" ? args.tier : "any";
    if (tierArg !== "any" && tierArg !== "short" && tierArg !== "long") {
      return { success: false, output: "", error: `invalid tier "${tierArg}" — use any|short|long` };
    }
    const limit = typeof args.limit === "number" ? args.limit : 5;
    const embedder = this.getEmbedder?.();
    const hits = embedder
      ? await recallQueryAsync(this.db, {
          query,
          tier: tierArg as "any" | Tier,
          projectId,
          limit,
          embedder,
          embedModel: this.embedModel,
          trackRefs: true,
          autoPromote: true,
        })
      : recallQuery(this.db, {
          query,
          tier: tierArg as "any" | Tier,
          projectId,
          limit,
          trackRefs: true,
        });
    return { success: true, output: formatHits(hits) };
  }

  private async promote(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) {
      return { success: false, output: "", error: "id is required for action=promote" };
    }
    const embedder = this.getEmbedder?.();
    if (!embedder) {
      return {
        success: false,
        output: "",
        error: "memory.embeddings is not enabled — cannot promote to semantic memory",
      };
    }
    const force = args.force === true;
    const result = await promoteNote(this.db, embedder, id, {
      force,
      model: this.embedModel,
    });
    if (!result) {
      return { success: true, output: `(no note with id ${id})` };
    }
    if (result.alreadyPromoted) {
      return { success: true, output: `${id} is already promoted (${result.chunkCount} chunks; use force to re-index)` };
    }
    return { success: true, output: `promoted ${id} → ${result.chunkCount} chunks` };
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
    // Channel discipline (docs/agent-unification.md, RC2): refuse to write
    // operational telemetry into the semantic-recall store. Idle ticks and
    // status pings belong in tick_log, not in notes future recall will surface.
    // Strict prefix match keeps the filter narrow — a note that *mentions*
    // these phrases mid-sentence is fine, only ones that *open* with them
    // get rejected.
    const TELEMETRY_PREFIXES = [
      /^tick:/i,
      /^standing by\b/i,
      /^no new material\b/i,
      /^email check at\b/i,
      /^no[_ ]new[_ ]mail\b/i,
    ];
    if (TELEMETRY_PREFIXES.some((re) => re.test(content))) {
      return {
        success: false,
        output: "",
        error:
          "Refusing to write a telemetry-style note to recall. " +
          "Idle/status logs belong in tick_log, not in semantic memory. " +
          "If this is a real observation, rephrase it so it does not open with 'tick:', 'standing by', 'email check at', etc.",
      };
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

  private archive(args: Record<string, unknown>): ToolResult {
    const id = typeof args.id === "string" ? args.id : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!id) {
      return { success: false, output: "", error: "id is required for action=archive" };
    }
    if (!reason) {
      return {
        success: false,
        output: "",
        error:
          "reason is required for action=archive — one short line on why this note is worth keeping forever. Forces selectivity.",
      };
    }
    const note = getNote(this.db, id);
    if (!note) {
      return { success: false, output: "", error: `no note with id ${id}` };
    }
    // Flip the archival flag; append the reason to tags so it's queryable
    // from the Memory UI ("why was this archived?"). Idempotent.
    this.db
      .prepare(
        "UPDATE notes SET archival = 1, tags = json_insert(tags, '$[#]', ?) WHERE id = ? AND archival = 0",
      )
      .run(`archive: ${reason}`, id);
    return { success: true, output: `archived ${id} — "${reason}"` };
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
