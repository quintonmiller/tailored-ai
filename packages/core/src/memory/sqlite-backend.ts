import type Database from "better-sqlite3";
import {
  countChunks,
  createChunk,
  deleteChunksBySource,
  getChunk,
  type MemoryChunk,
  semanticSearch,
} from "../db/chunk-queries.js";
import {
  CORE_MEMORY_SECTIONS,
  type CoreMemoryScope,
  type CoreMemorySection,
  clearCoreMemorySection,
  getCoreMemory,
  getCoreMemorySection,
  renderCoreMemory,
  setCoreMemory,
} from "../db/core-memory-queries.js";
import { deleteFact, type Fact, type FactQuery, findFact, getFact, listFacts, upsertFact } from "../db/fact-queries.js";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  listPinnedNotes,
  type Note,
  type NoteQuery,
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
import {
  factLabel,
  factSnippet,
  noteSnippet,
  chunkSnippet as renderChunkSnippet,
  scoreFact,
  scoreNote,
  tokenize,
} from "./scoring.js";

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
      const md = (
        content.structured && typeof content.structured === "object"
          ? (content.structured as Record<string, unknown>)
          : {}
      ) as Record<string, unknown>;
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
    const { sessionId } = parseScope(hint.scope);
    const note = createNote(this.db, {
      content: content.text,
      session_id: sessionId ?? null,
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
    const limit = context.limit ?? 5;

    // Exact structured lookup first — the FactsTool's "find this triplet" path.
    if (context.wantStructured) {
      const s = context.wantStructured;
      const category = str(s.category);
      const key = str(s.key);
      if (category && key) {
        const fact = findFact(this.db, category, str(s.entity) ?? "", key, projectId);
        return fact ? [factFragment(fact)] : [];
      }
    }

    const fragments: MemoryFragment[] = [];

    // Pinned tier — always-inject high-importance notes. Surfaces with
    // metadata.pinned=true so the agent layer can render them in their
    // own block. SQLite-specific concept; other backends may omit.
    if (context.includePrelude) {
      const pinned = listPinnedNotes(this.db, { project_id: projectId, limit });
      for (const note of pinned) fragments.push(noteFragment(note, { pinned: true }));
    }
    const pinnedIds = new Set(fragments.filter((f) => f.metadata?.pinned).map((f) => f.id ?? ""));

    // Keyword + structured recall over notes and facts. Mirrors the old
    // recallQuery scoring; ranking now lives behind the backend so plugin
    // backends can replace it entirely.
    const keywordHits: Array<MemoryFragment & { _score: number; _createdAt: string }> = [];
    if (context.freeText) {
      const terms = tokenize(context.freeText);
      if (terms.length > 0) {
        const minImportance = context.minImportance;
        const notes = listNotes(this.db, {
          project_id: projectId,
          excludeExpired: true,
          includeGlobal: projectId !== null,
          limit: 500,
        });
        for (const n of notes) {
          if (typeof minImportance === "number" && (n.importance ?? 0) < minImportance) continue;
          const score = scoreNote(terms, n);
          if (score <= 0) continue;
          const frag = noteFragment(n, { tier: "short", score, snippet: noteSnippet(n) });
          keywordHits.push({ ...frag, _score: score, _createdAt: n.created_at });
        }

        const facts = listFacts(this.db, {
          project_id: projectId,
          includeGlobal: projectId !== null,
          limit: 1000,
        });
        for (const f of facts) {
          const score = scoreFact(terms, f);
          if (score <= 0) continue;
          const frag = factFragment(f, {
            tier: "long",
            score,
            label: factLabel(f),
            snippet: factSnippet(f),
          });
          keywordHits.push({ ...frag, _score: score, _createdAt: f.updated_at });
        }
      }
    }

    // Semantic tier — only when the caller has already embedded.
    const semanticHits: Array<MemoryFragment & { _score: number; _createdAt: string }> = [];
    if (context.vector) {
      const minScore = context.minImportance ?? 0;
      const hits = semanticSearch(this.db, context.vector, { projectId, limit, minScore });
      for (const hit of hits) {
        const frag = chunkFragment(hit.chunk, {
          tier: "long",
          score: hit.score,
          snippet: renderChunkSnippet(hit.chunk.content),
        });
        semanticHits.push({ ...frag, _score: hit.score, _createdAt: hit.chunk.created_at });
      }
    }

    // Merge keyword + semantic. Dedupe: a chunk whose source is a note id
    // collapses onto that note's keyword hit (keep the higher score). Then
    // sort by score desc, recency desc.
    const merged = new Map<string, MemoryFragment & { _score: number; _createdAt: string }>();
    for (const h of [...keywordHits, ...semanticHits]) {
      const key = canonicalSourceKey(h);
      const existing = merged.get(key);
      if (!existing || h._score > existing._score) merged.set(key, h);
    }
    const ranked = Array.from(merged.values())
      .filter((f) => !pinnedIds.has(f.id ?? ""))
      .sort((a, b) => {
        if (b._score !== a._score) return b._score - a._score;
        return b._createdAt.localeCompare(a._createdAt);
      })
      .slice(0, Math.max(0, limit - fragments.length));

    for (const r of ranked) {
      const { _score, _createdAt, ...frag } = r;
      void _score;
      void _createdAt;
      fragments.push(frag);
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
        return clearCoreMemorySection(this.db, { agent, project_id: project_id ?? null }, section as CoreMemorySection);
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
      return listFacts(this.db, factQuery).map((f) => factFragment(f));
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
        .all(...(projectId === null ? [limit, offset] : [projectId, limit, offset])) as Array<{
        id: string;
        content: string;
        source: string;
      }>;
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
    return notes.map((n) => noteFragment(n));
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

function parseScope(scope: string | string[] | undefined): {
  projectId: string | null;
  agent: string | undefined;
  sessionId: string | undefined;
} {
  if (!scope) return { projectId: null, agent: undefined, sessionId: undefined };
  const parts = Array.isArray(scope) ? scope : scope.split(/\s+/);
  let projectId: string | null = null;
  let agent: string | undefined;
  let sessionId: string | undefined;
  for (const part of parts) {
    if (part === "global") continue;
    if (part.startsWith("project:")) projectId = part.slice("project:".length) || null;
    else if (part.startsWith("agent:")) agent = part.slice("agent:".length) || undefined;
    else if (part.startsWith("session:")) sessionId = part.slice("session:".length) || undefined;
  }
  return { projectId, agent, sessionId };
}

function parseId(id: string): { kind: string; rest: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0) return null;
  return { kind: id.slice(0, idx), rest: id.slice(idx + 1) };
}

function noteFragment(note: Note, extra: Record<string, unknown> = {}): MemoryFragment {
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
      ...extra,
    },
  };
}

function factFragment(fact: Fact, extra: Record<string, unknown> = {}): MemoryFragment {
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
      ...extra,
    },
  };
}

function chunkFragment(chunk: MemoryChunk, extra: Record<string, unknown> = {}): MemoryFragment {
  return {
    text: chunk.content,
    id: `chunk:${chunk.id}`,
    metadata: {
      kind: "chunk",
      source: chunk.source,
      embed_model: chunk.embed_model,
      created_at: chunk.created_at,
      project_id: chunk.project_id,
      ...chunk.metadata,
      ...extra,
    },
  };
}

/**
 * Canonical key for dedup between keyword and semantic hits — a chunk
 * whose source is `note:<id>` collapses onto the note's keyword hit so
 * the same note isn't surfaced twice. Falls back to the fragment id.
 */
function canonicalSourceKey(f: MemoryFragment): string {
  const src = f.metadata?.source;
  if (typeof src === "string" && src.startsWith("note:")) return src.slice("note:".length);
  return f.id ?? "";
}
