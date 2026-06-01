import type Database from "better-sqlite3";
import {
  CORE_MEMORY_SECTIONS,
  type CoreMemorySection,
  type CoreMemoryScope,
  clearCoreMemorySection,
  getCoreMemory,
  getCoreMemorySection,
  renderCoreMemory,
  setCoreMemory,
} from "../db/core-memory-queries.js";
import {
  type Fact,
  type FactQuery,
  deleteFact,
  findFact,
  getFact,
  listFacts,
  upsertFact,
} from "../db/fact-queries.js";
import {
  type MemoryChunk,
  countChunks,
  createChunk,
  deleteChunksBySource,
  getChunk,
  semanticSearch,
} from "../db/chunk-queries.js";
import {
  type Note,
  type NoteQuery,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  listPinnedNotes,
} from "../db/note-queries.js";
import type {
  ListQuery,
  MemoryBackend,
  MemoryContent,
  MemoryFragment,
  MemoryHint,
  PreludeContext,
  QueryContext,
} from "./interface.js";

/**
 * Verb-shaped adapter over the existing SQLite `db/*-queries.ts` modules.
 *
 * Routing rules:
 *   - `hint.kind === "fact"`    → facts table (via upsertFact / listFacts / deleteFact)
 *   - `hint.kind === "chunk"`   → memory_chunks table (vector + metadata)
 *   - `hint.kind === "prelude"` → core_memory table (identity)
 *   - default / "note"           → notes table
 *
 * Ids returned to callers are prefixed with the table-of-origin so
 * `delete(id)` / `get(id)` can route without a sniffing lookup:
 *   `note:<id>`, `fact:<id>`, `chunk:<id>`, `prelude:<agent>/<section>[/<project>]`.
 *
 * Phase 1 keeps the adapter functionally complete enough that a plugin
 * author can register a backend and exercise every verb. Phase 2 routes
 * the agent loop through it for real; Phase 3 routes tools + server
 * routes.
 */
export class SqliteMemoryBackend implements MemoryBackend {
  readonly id = "builtin";

  constructor(private readonly db: Database.Database) {}

  async write(content: MemoryContent, hint: MemoryHint = {}): Promise<{ id: string }> {
    const kind = hint.kind ?? "note";
    const { projectId, agent } = parseScope(hint.scope);

    // Structural supersession: drop the prior record before writing the new
    // one. The contract leaves interpretation to the backend; SQLite's
    // simplest is replace-in-place.
    if (hint.supersedes) {
      try {
        await this.delete(hint.supersedes);
      } catch {
        // best-effort — unknown ids are not fatal
      }
    }

    if (kind === "fact") {
      const s = (content.structured ?? {}) as Record<string, unknown>;
      const fact = upsertFact(this.db, {
        category: str(s.category) ?? "general",
        entity: str(s.entity),
        key: str(s.key) ?? "value",
        value: content.text,
        asof: str(s.asof),
        source: hint.sourceUri ?? null,
        confidence: typeof s.confidence === "number" ? s.confidence : null,
        project_id: projectId,
      });
      return { id: `fact:${fact.id}` };
    }

    if (kind === "chunk") {
      const md = (content.structured && typeof content.structured === "object"
        ? (content.structured as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const chunk = createChunk(this.db, {
        source: hint.sourceUri ?? str(md.source) ?? "memory",
        content: content.text,
        project_id: projectId,
        embedding: hint.vector ?? null,
        embed_model: str(md.embed_model) ?? null,
        metadata: md,
      });
      return { id: `chunk:${chunk.id}` };
    }

    if (kind === "prelude") {
      const s = (content.structured ?? {}) as Record<string, unknown>;
      const section = (str(s.section) as CoreMemorySection | undefined) ?? "persona";
      if (!CORE_MEMORY_SECTIONS.includes(section)) {
        throw new Error(`Unknown core_memory section "${section}". Known: ${CORE_MEMORY_SECTIONS.join(", ")}`);
      }
      if (!agent) {
        throw new Error('write({ kind: "prelude" }) requires hint.scope to include "agent:<name>"');
      }
      const row = setCoreMemory(this.db, {
        agent,
        project_id: projectId,
        section,
        content: content.text,
        updated_by: str(s.updated_by) ?? null,
      });
      return { id: `prelude:${row.agent}/${row.section}${row.project_id ? `/${row.project_id}` : ""}` };
    }

    // Default: note
    const note = createNote(this.db, {
      content: content.text,
      session_id: null,
      project_id: projectId,
      agent: agent ?? null,
      tags: hint.tags,
      importance: hint.suggestedImportance ?? null,
      ttl_at: hint.suggestedTtl ?? null,
    });
    return { id: `note:${note.id}` };
  }

  async query(context: QueryContext): Promise<MemoryFragment[]> {
    const { projectId } = parseScope(context.scope);
    const limit = context.limit ?? 10;
    const fragments: MemoryFragment[] = [];

    // Exact structured lookup first — the FactsTool's "find this triplet" path.
    if (context.wantStructured) {
      const s = context.wantStructured;
      const category = str(s.category);
      const key = str(s.key);
      if (category && key) {
        const fact = findFact(this.db, category, str(s.entity) ?? "", key, projectId);
        if (fact) fragments.push(factFragment(fact));
        if (fragments.length >= limit) return fragments;
      }
    }

    // Pinned items (when caller wants prelude-ish context).
    if (context.includePrelude) {
      const pinned = listPinnedNotes(this.db, { project_id: projectId, limit });
      for (const note of pinned) {
        fragments.push(noteFragment(note));
        if (fragments.length >= limit) return fragments;
      }
    }

    // Semantic search when the caller supplied a vector.
    if (context.vector) {
      const hits = semanticSearch(this.db, context.vector, { projectId, limit });
      for (const hit of hits) {
        fragments.push(chunkFragment(hit.chunk, hit.score));
        if (fragments.length >= limit) return fragments;
      }
    }

    // Keyword recall across notes.
    if (context.freeText) {
      const noteQuery: NoteQuery = {
        project_id: projectId,
        search: context.freeText,
        excludeExpired: true,
        includeGlobal: projectId !== null,
        limit,
      };
      const matched = listNotes(this.db, noteQuery);
      for (const note of matched) {
        fragments.push(noteFragment(note));
        if (fragments.length >= limit) return fragments;
      }
    }

    return fragments;
  }

  async delete(id: string): Promise<boolean> {
    const parsed = parseId(id);
    if (!parsed) return false;
    switch (parsed.kind) {
      case "note":
        return deleteNote(this.db, parsed.rest);
      case "fact":
        return deleteFact(this.db, parsed.rest);
      case "chunk":
        // chunks are addressed by source in the existing API; for verb-level
        // delete-by-id we use the id directly via a small one-shot DELETE.
        return this.db.prepare("DELETE FROM memory_chunks WHERE id = ?").run(parsed.rest).changes > 0;
      case "prelude": {
        const [agent, section, project_id] = parsed.rest.split("/");
        if (!agent || !section) return false;
        return clearCoreMemorySection(
          this.db,
          { agent, project_id: project_id ?? null },
          section as CoreMemorySection,
        );
      }
      default:
        return false;
    }
  }

  async prelude(context: PreludeContext): Promise<string> {
    const { projectId, agent } = parseScope(context.scope);
    if (!agent) return "";
    const scope: CoreMemoryScope = { agent, project_id: projectId };
    return renderCoreMemory(getCoreMemory(this.db, scope));
  }

  async list(query: ListQuery): Promise<MemoryFragment[]> {
    const { projectId } = parseScope(query.scope);
    const kind = query.kind ?? "note";

    if (kind === "fact") {
      const factQuery: FactQuery = {
        project_id: projectId,
        limit: query.limit,
        includeGlobal: projectId !== null,
      };
      return listFacts(this.db, factQuery).map(factFragment);
    }

    if (kind === "chunk") {
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;
      const rows = this.db
        .prepare(
          projectId === null
            ? "SELECT * FROM memory_chunks WHERE project_id IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?"
            : "SELECT * FROM memory_chunks WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .all(...(projectId === null ? [limit, offset] : [projectId, limit, offset])) as Array<{ id: string; content: string; source: string }>;
      return rows.map((r) => ({
        text: r.content,
        id: `chunk:${r.id}`,
        metadata: { kind: "chunk", source: r.source },
      }));
    }

    if (kind === "prelude") {
      // List every section row for the scope. Without an agent, return [].
      const { agent } = parseScope(query.scope);
      if (!agent) return [];
      return getCoreMemory(this.db, { agent, project_id: projectId }).map((row) => ({
        text: row.content,
        id: `prelude:${row.agent}/${row.section}${row.project_id ? `/${row.project_id}` : ""}`,
        metadata: { kind: "prelude", section: row.section, updated_at: row.updated_at },
      }));
    }

    // Default: notes
    const notes = listNotes(this.db, {
      project_id: projectId,
      tag: query.tags?.[0],
      excludeExpired: true,
      includeGlobal: projectId !== null,
      limit: query.limit,
    });
    return notes.map(noteFragment);
  }

  async get(id: string): Promise<MemoryFragment | null> {
    const parsed = parseId(id);
    if (!parsed) return null;
    switch (parsed.kind) {
      case "note": {
        const note = getNote(this.db, parsed.rest);
        return note ? noteFragment(note) : null;
      }
      case "fact": {
        const fact = getFact(this.db, parsed.rest);
        return fact ? factFragment(fact) : null;
      }
      case "chunk": {
        const chunk = getChunk(this.db, parsed.rest);
        return chunk ? chunkFragment(chunk) : null;
      }
      case "prelude": {
        const [agent, section, project_id] = parsed.rest.split("/");
        if (!agent || !section) return null;
        const row = getCoreMemorySection(
          this.db,
          { agent, project_id: project_id ?? null },
          section as CoreMemorySection,
        );
        return row
          ? {
              text: row.content,
              id: `prelude:${row.agent}/${row.section}${row.project_id ? `/${row.project_id}` : ""}`,
              metadata: { kind: "prelude", section: row.section, updated_at: row.updated_at },
            }
          : null;
      }
      default:
        return null;
    }
  }

  async count(query: ListQuery = {}): Promise<number> {
    const { projectId } = parseScope(query.scope);
    const kind = query.kind ?? "note";

    if (kind === "chunk") return countChunks(this.db, projectId);

    if (kind === "fact") {
      const r = this.db
        .prepare(
          projectId === null
            ? "SELECT COUNT(*) AS c FROM facts WHERE project_id IS NULL"
            : "SELECT COUNT(*) AS c FROM facts WHERE project_id = ? OR project_id IS NULL",
        )
        .get(...(projectId === null ? [] : [projectId])) as { c: number };
      return r.c;
    }

    if (kind === "prelude") {
      const r = this.db.prepare("SELECT COUNT(*) AS c FROM core_memory").get() as { c: number };
      return r.c;
    }

    const r = this.db
      .prepare(
        projectId === null
          ? "SELECT COUNT(*) AS c FROM notes WHERE project_id IS NULL"
          : "SELECT COUNT(*) AS c FROM notes WHERE project_id = ?",
      )
      .get(...(projectId === null ? [] : [projectId])) as { c: number };
    return r.c;
  }

  // close intentionally omitted — the underlying DB is owned by the runtime,
  // not by the backend; closing it here would yank it from every other
  // subsystem. Phase 2 may revisit if remote backends need lifecycle.
}

// ─── helpers ────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseScope(scope: string | string[] | undefined): { projectId: string | null; agent: string | undefined } {
  if (!scope) return { projectId: null, agent: undefined };
  const parts = Array.isArray(scope) ? scope : scope.split(/\s+/);
  let projectId: string | null = null;
  let agent: string | undefined;
  for (const part of parts) {
    if (part === "global") continue;
    if (part.startsWith("project:")) projectId = part.slice("project:".length) || null;
    else if (part.startsWith("agent:")) agent = part.slice("agent:".length) || undefined;
  }
  return { projectId, agent };
}

function parseId(id: string): { kind: string; rest: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0) return null;
  return { kind: id.slice(0, idx), rest: id.slice(idx + 1) };
}

function noteFragment(note: Note): MemoryFragment {
  return {
    text: note.content,
    id: `note:${note.id}`,
    metadata: {
      kind: "note",
      tags: note.tags,
      importance: note.importance,
      ref_count: note.ref_count,
      created_at: note.created_at,
      ttl_at: note.ttl_at,
      project_id: note.project_id,
      agent: note.agent,
    },
  };
}

function factFragment(fact: Fact): MemoryFragment {
  return {
    text: fact.value,
    id: `fact:${fact.id}`,
    metadata: {
      kind: "fact",
      category: fact.category,
      entity: fact.entity,
      key: fact.key,
      asof: fact.asof,
      source: fact.source,
      confidence: fact.confidence,
      project_id: fact.project_id,
      created_at: fact.created_at,
      updated_at: fact.updated_at,
    },
  };
}

function chunkFragment(chunk: MemoryChunk, score?: number): MemoryFragment {
  return {
    text: chunk.content,
    id: `chunk:${chunk.id}`,
    metadata: {
      kind: "chunk",
      source: chunk.source,
      score,
      embed_model: chunk.embed_model,
      created_at: chunk.created_at,
      project_id: chunk.project_id,
      ...chunk.metadata,
    },
  };
}
