import type Database from "better-sqlite3";
import { promoteNote } from "../agent/memory-promotion.js";
import { getNote, keepNote } from "../db/note-queries.js";
import type { MemoryBackend } from "../memory/interface.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { formatHits, recallQueryAsync, type Tier } from "./recall-query.js";

/**
 * Tiered memory surface. See docs/memory-tiers.md.
 *
 * Actions:
 *   - query      Search notes (short-term) and facts (long-term) by relevance.
 *   - note       Write a new short-term note. Tags / TTL / importance optional.
 *   - list       Plain unranked list of recent notes.
 *   - promote    Index a note for semantic search.
 *   - keep       Make a note never expire (reason required).
 *   - archive    Hide a note; `forget` is the same thing. Reversible.
 *   - unarchive  Bring an archived note back.
 *
 * Nothing an agent does here deletes. `forget` used to, and `archive` used to
 * mean what `keep` means now; both changed so an agent's mistakes can be undone.
 *
 * `query` and `list` read the calling agent's own notes plus unowned ones, the
 * scope prompt injection uses, and the actions that change a note change only
 * those; an unnamed session reads and changes them all. The project defaults
 * to the session's active project.
 */
export class RecallTool implements Tool {
  name = "recall";
  description =
    "Search and write short-term memory — what was saved in past sessions, not what is in the conversation in front of you. Use query to find relevant notes + facts; note to save an observation; list, keep, archive and unarchive to manage notes.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["query", "note", "list", "promote", "keep", "archive", "forget", "unarchive"],
        description:
          "query: ranked search. note: write prose. list: show recent notes. promote: clone a note into long-term semantic memory. keep: this note never expires (needs reason). archive or forget: hide a note; unarchive brings it back.",
      },
      query: {
        type: "string",
        description:
          "Search terms (required for action=query). Coverage is scored over notes content/tags and fact category/entity/key/value.",
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
        description: "Note id, for promote, keep, archive, forget and unarchive.",
      },
      force: {
        type: "boolean",
        description: "For promote: re-index even when chunks already exist.",
      },
      reason: {
        type: "string",
        description:
          "One line on why. Required for keep (keep few: kept notes crowd out the rest); optional for archive and forget.",
      },
      includeArchived: {
        type: "boolean",
        description: "For query and list: also return archived notes.",
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
  private getMemoryBackend?: () => Promise<MemoryBackend>;

  constructor(
    db: Database.Database,
    opts: {
      defaultTtlDays?: number;
      getEmbedder?: () => EmbeddingProvider | undefined;
      embedModel?: string;
      getMemoryBackend?: () => Promise<MemoryBackend>;
    } = {},
  ) {
    this.db = db;
    this.defaultTtlDays = opts.defaultTtlDays ?? 14;
    this.getEmbedder = opts.getEmbedder;
    this.embedModel = opts.embedModel;
    // Fall back to a SqliteMemoryBackend over the same db when the caller
    // doesn't wire one in. Lazily instantiated so the constructor stays
    // side-effect-free; once resolved, the same backend is reused for the
    // lifetime of the tool.
    if (opts.getMemoryBackend) {
      this.getMemoryBackend = opts.getMemoryBackend;
    } else {
      let cached: MemoryBackend | undefined;
      this.getMemoryBackend = async () => {
        if (!cached) cached = new SqliteMemoryBackend(db);
        return cached;
      };
    }
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action ?? "").toLowerCase();
    const projectId = resolveProjectId(args.project_id, context.projectId);

    try {
      switch (action) {
        case "query":
          return this.query(args, context, projectId);
        case "note":
          return this.note(args, context, projectId);
        case "forget":
          return this.archive(args, context, "forgotten");
        case "archive":
          return this.archive(args, context);
        case "unarchive":
          return this.unarchive(args, context);
        case "list":
          return this.list(args, context, projectId);
        case "promote":
          return this.promote(args, context);
        case "keep":
          // Lifecycle action — stays SQLite-direct, like the sweep it exempts
          // a note from. A plugin backend owns its own retention.
          return this.keep(args, context);
        default:
          return { success: false, output: "", error: `unknown action "${action}"` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async query(
    args: Record<string, unknown>,
    context: ToolContext,
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
    const backend = await this.getMemoryBackend!();
    const hits = await recallQueryAsync(
      backend,
      {
        query,
        tier: tierArg as "any" | Tier,
        projectId,
        // Whose memory this is: the agent's own notes plus unowned ones.
        // Without it any agent read every other agent's notes and narrated
        // them as its own recollection. Undefined for an unnamed session,
        // which keeps the cross-agent view.
        agent: context.agentName,
        limit,
        embedder,
        embedModel: this.embedModel,
        trackRefs: true,
        autoPromote: !!embedder,
        includeArchived: args.includeArchived === true,
      },
      this.db,
    );
    return { success: true, output: formatHits(hits) };
  }

  private async promote(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
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
    const owned = getNote(this.db, bareNoteId(id));
    if (owned && !mayChange(owned.agent, context.agentName)) {
      return { success: true, output: `(no note with id ${id})` };
    }
    const result = await promoteNote(this.db, embedder, bareNoteId(id), {
      force,
      model: this.embedModel,
    });
    if (!result) {
      return { success: true, output: `(no note with id ${id})` };
    }
    if (result.archived) {
      return { success: false, output: "", error: `${id} is archived — unarchive it before promoting` };
    }
    if (result.alreadyPromoted) {
      return {
        success: true,
        output: `${id} is already promoted (${result.chunkCount} chunks; use force to re-index)`,
      };
    }
    return { success: true, output: `promoted ${id} → ${result.chunkCount} chunks` };
  }

  private async note(
    args: Record<string, unknown>,
    context: ToolContext,
    projectId: string | null,
  ): Promise<ToolResult> {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) {
      return { success: false, output: "", error: "content is required for action=note" };
    }
    // Channel discipline (docs/agent-unification.md, RC2): refuse to write
    // operational telemetry into the semantic-recall store. Idle ticks and
    // status pings belong in tick_log, not in notes future recall will surface.
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
    const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string") : [];
    const importance = typeof args.importance === "number" ? args.importance : null;
    const ttlDays = typeof args.ttl_days === "number" ? args.ttl_days : this.defaultTtlDays;
    const ttlAt = ttlDays > 0 ? new Date(Date.now() + ttlDays * 86_400_000).toISOString() : null;

    const backend = await this.getMemoryBackend!();
    const scope = scopeStr(projectId, context.agentName, context.sessionId);
    const { id } = await backend.write(
      { text: content },
      {
        kind: "note",
        scope,
        tags,
        suggestedImportance: importance ?? undefined,
        suggestedTtl: ttlAt,
      },
    );
    // Strip the `note:` prefix so the legacy `saved <id>` output shape is
    // preserved for SQLite. Plugin backends with different id shapes still
    // round-trip — the returned id is whatever the backend assigned.
    const display = id.startsWith("note:") ? id.slice("note:".length) : id;
    return { success: true, output: `saved ${display}` };
  }

  /**
   * Hide a note. `forget` lands here too, so the notes an agent drops can be
   * brought back. A backend that can't archive gets the old delete for
   * `forget` (prompts rely on it working), said plainly in the output, and a
   * refusal for `archive`, which promises something it couldn't keep.
   */
  private async archive(
    args: Record<string, unknown>,
    context: ToolContext,
    defaultReason?: string,
  ): Promise<ToolResult> {
    const action = defaultReason ? "forget" : "archive";
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) {
      return { success: false, output: "", error: `id is required for action=${action}` };
    }
    const reason = (typeof args.reason === "string" && args.reason.trim()) || defaultReason;
    const backend = await this.getMemoryBackend!();
    const { candidates, found } = await findNote(backend, id, context.agentName);

    if (!backend.archive) {
      if (action === "archive" || !backend.delete) {
        return { success: false, output: "", error: `the active memory backend can't ${action} notes` };
      }
      for (const candidate of candidates) {
        if (await backend.delete(candidate)) {
          return { success: true, output: `deleted ${id} for good (this memory backend can't archive)` };
        }
      }
      return { success: true, output: `(no note with id ${id})` };
    }

    for (const candidate of candidates) {
      if (await backend.archive(candidate, { by: context.agentName, reason })) {
        const why = reason ? ` (${reason})` : "";
        return { success: true, output: `archived ${id}${why} — action=unarchive brings it back` };
      }
    }
    if (!found) return { success: true, output: `(no note with id ${id})` };
    // The note is there but this backend won't archive it. `forget` still has
    // to make it go, as it did before archiving existed; `archive` says it
    // failed rather than let the agent think the note is hidden.
    if (action === "forget" && backend.delete) {
      for (const candidate of candidates) {
        if (await backend.delete(candidate)) {
          return { success: true, output: `deleted ${id} for good (this memory backend couldn't archive it)` };
        }
      }
    }
    return { success: false, output: "", error: `the active memory backend couldn't ${action} ${id}` };
  }

  private async unarchive(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) {
      return { success: false, output: "", error: "id is required for action=unarchive" };
    }
    const backend = await this.getMemoryBackend!();
    if (!backend.unarchive) {
      return { success: false, output: "", error: "the active memory backend can't unarchive notes" };
    }
    const { candidates, found } = await findNote(backend, id, context.agentName);
    for (const candidate of candidates) {
      if (await backend.unarchive(candidate)) return { success: true, output: `restored ${id}` };
    }
    if (found) return { success: false, output: "", error: `the active memory backend couldn't restore ${id}` };
    return { success: true, output: `(no note with id ${id})` };
  }

  private keep(args: Record<string, unknown>, context: ToolContext): ToolResult {
    const id = typeof args.id === "string" ? args.id : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!id) {
      return { success: false, output: "", error: "id is required for action=keep" };
    }
    if (!reason) {
      return {
        success: false,
        output: "",
        error:
          "reason is required for action=keep — one short line on why this note is worth keeping forever. Forces selectivity.",
      };
    }
    const owned = getNote(this.db, bareNoteId(id));
    const note = owned && mayChange(owned.agent, context.agentName) ? keepNote(this.db, owned.id, reason) : null;
    if (!note) {
      return { success: false, output: "", error: `no note with id ${id}` };
    }
    // Keeping doesn't unhide: say so rather than let the agent think it's back.
    const hidden = note.archived_at ? " It is archived; action=unarchive brings it back." : "";
    return { success: true, output: `kept ${id} — "${reason}"; it no longer expires.${hidden}` };
  }

  private async list(
    args: Record<string, unknown>,
    context: ToolContext,
    projectId: string | null,
  ): Promise<ToolResult> {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const tag = typeof args.tag === "string" && args.tag.length > 0 ? args.tag : undefined;
    const backend = await this.getMemoryBackend!();
    if (!backend.list) {
      return { success: false, output: "", error: "list is not supported by the active memory backend" };
    }
    const fragments = await backend.list({
      scope: scopeStr(projectId, context.agentName),
      kind: "note",
      tags: tag ? [tag] : undefined,
      includeArchived: args.includeArchived === true,
      limit,
    });
    if (fragments.length === 0) {
      return { success: true, output: "(no notes)" };
    }
    return { success: true, output: fragments.map(formatNoteFragment).join("\n") };
  }
}

/**
 * The ids a note may go by in the backend: the prefixed one we hand out
 * (`note:<id>`), then the bare SQLite id older sessions may still hold.
 * `found` is true only when the backend's `get` confirmed the note exists.
 * Otherwise every form stays a candidate, as before this lookup existed: a
 * backend with no `get`, or one whose `get` doesn't cover notes, can't say.
 *
 * Another agent's note comes back as no candidates at all: see {@link mayChange}.
 */
async function findNote(
  backend: MemoryBackend,
  id: string,
  caller: string | undefined,
): Promise<{ candidates: string[]; found: boolean }> {
  const forms = id.startsWith("note:") ? [id] : [`note:${id}`, id];
  if (backend.get) {
    for (const form of forms) {
      const note = await backend.get(form);
      if (!note) continue;
      if (!mayChange(note.metadata?.agent, caller)) return { candidates: [], found: false };
      return { candidates: [form], found: true };
    }
  }
  return { candidates: forms, found: false };
}

/**
 * Whether the caller may change a note: a named agent its own notes and
 * unowned ones, the same notes its `query` and `list` read; an unnamed
 * session any note. To a named agent another agent's note doesn't exist, so
 * it can't hide, restore, keep or promote one whose id it saw somewhere else,
 * such as a shared room's transcript.
 */
function mayChange(owner: unknown, caller: string | undefined): boolean {
  return !caller || typeof owner !== "string" || owner === caller;
}

/**
 * The SQLite note id, for the actions that go to SQLite directly. `query`
 * shows a promoted note's chunk as `note:<id>`, and the other actions take
 * that form, so a model that copies it gets the same answer here.
 */
function bareNoteId(id: string): string {
  return id.startsWith("note:") ? id.slice("note:".length) : id;
}

function scopeStr(projectId: string | null, agentName?: string | null, sessionId?: string | null): string {
  const parts: string[] = [];
  if (projectId) parts.push(`project:${projectId}`);
  if (agentName) parts.push(`agent:${agentName}`);
  if (sessionId) parts.push(`session:${sessionId}`);
  return parts.length > 0 ? parts.join(" ") : "global";
}

function formatNoteFragment(f: import("../memory/interface.js").MemoryFragment): string {
  const md = f.metadata ?? {};
  const meta: string[] = [];
  if (typeof md.created_at === "string") meta.push(md.created_at.slice(0, 16).replace("T", " "));
  if (Array.isArray(md.tags) && md.tags.length) meta.push(`tags=${(md.tags as string[]).join(",")}`);
  if (typeof md.importance === "number") meta.push(`importance=${md.importance}`);
  if (md.kept === true) meta.push("kept");
  if (typeof md.archived_at === "string") {
    const why = typeof md.archive_reason === "string" ? `: ${md.archive_reason}` : "";
    meta.push(`archived ${md.archived_at.slice(0, 10)}${why}`);
  }
  const idStr = typeof f.id === "string" ? (f.id.startsWith("note:") ? f.id.slice("note:".length) : f.id) : "?";
  const head = `${idStr}  (${meta.join(", ")})`;
  const body = f.text.length > 200 ? `${f.text.slice(0, 200)}…` : f.text;
  return `${head}\n  ${body}`;
}

/**
 * `project_id` as given, `"global"` (or empty) for global, and the session's
 * active project when it's left out — what the parameter has always promised.
 * It used to fall back to global, so an agent working in a project couldn't
 * recall what it had noted there unless it passed the id.
 */
function resolveProjectId(raw: unknown, active: string | null | undefined): string | null {
  if (typeof raw === "string") {
    if (raw === "global" || raw === "") return null;
    return raw;
  }
  return active ?? null;
}
