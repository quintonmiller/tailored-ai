/**
 * Memory backend interface — see docs/memory-storage-registry.md for the
 * full design and the library survey that motivated the verb-based shape.
 *
 * Two required verbs (write / query), six optional capabilities (delete,
 * prelude, list, get, count, close). Flat — no sub-objects. Callers
 * narrow optionals via `if (backend.list)`.
 *
 * Lifecycle (ref-counts, TTL, sweep, promotion) is private to backends.
 * Semantic supersession is expressed structurally via MemoryHint.supersedes
 * — never in prose.
 */

export interface MemoryContent {
  /** The textual content the agent wants to remember. */
  text: string;
  /**
   * Optional structured payload — opaque to the backend. Agent-layer
   * helpers (FactsTool, CoreMemoryTool) put typed data here, then the
   * SqliteMemoryBackend indexes by the well-known shape. Backends that
   * don't index structured data can still store it as JSON.
   */
  structured?: unknown;
}

/**
 * Advisory metadata the backend may use or ignore. The two motivating
 * patterns: (a) the agent layer expresses *what kind* of memory this
 * is so the backend can route to the right table/index; (b) the agent
 * expresses *intent* (e.g. supersession) structurally rather than in
 * prose, so smart backends can act on it.
 */
export interface MemoryHint {
  /**
   * Tags applied to the record. Built-in SQLite filters on these via
   * the existing notes/facts schema. Other backends may use them as
   * search facets or ignore them entirely.
   */
  tags?: string[];

  /**
   * Logical kind. "fact" / "note" / "chunk" / "prelude" route to the
   * matching SQLite table in the built-in. Free-form strings beyond
   * those are stored on notes with a kind tag.
   */
  kind?: string;

  /**
   * Scope — typically "global", `project:<id>`, `agent:<name>`. Built-in
   * SQLite uses this to populate project_id / agent columns.
   */
  scope?: string;

  /** Provenance — source document, URL, conversation id, etc. */
  sourceUri?: string;

  /**
   * Agent-suggested importance (0–10ish). Backends with their own
   * relevance model may ignore.
   */
  suggestedImportance?: number;

  /**
   * Agent-suggested TTL. ISO 8601. `null` means "never expire."
   * Backends with their own retention policy may ignore.
   */
  suggestedTtl?: string | null;

  /**
   * Precomputed embedding. Backends that own their embedding (Pinecone)
   * may ignore and recompute internally. SQLite uses when present and
   * skips embedding when absent.
   */
  vector?: Float32Array;

  /**
   * Structural supersession. Set when this write replaces or invalidates
   * a prior record. Backend decides interpretation:
   *   - Built-in SQLite: replace the prior row in place.
   *   - Mem0/Zep-style: keep the prior with an invalidated flag, append
   *     the new one with a `supersedes` edge.
   * The contract doesn't pick a policy.
   */
  supersedes?: string;
}

/**
 * Context for a recall query. `freeText` plus optional filters; backends
 * decide how to combine them. The built-in SQLite backend runs hybrid
 * keyword + semantic ranking; vector-only backends ignore everything
 * except `freeText` / `vector`.
 */
export interface QueryContext {
  /** What to recall about, in natural language. */
  freeText?: string;
  /**
   * Precomputed query vector. Wins over `freeText` when both are
   * present — useful when the caller has already embedded.
   */
  vector?: Float32Array;
  /** Recent conversation messages for backends that use them. */
  recentMessages?: { role: string; content: string }[];
  /** Scope filter — single value or OR list. */
  scope?: string | string[];
  /** Tag filter — AND across all tags. */
  tags?: string[];
  /**
   * Exact-match filter on `structured` payload fields. Used by
   * FactsTool to express "find the fact with category=X entity=Y key=Z".
   * Backends that don't index structured data should ignore and let
   * the caller filter results; the helper does this on the agent side.
   */
  wantStructured?: Record<string, unknown>;
  /** Minimum suggestedImportance (or backend-computed equivalent). */
  minImportance?: number;
  /**
   * When true, include always-injected ("prelude") items in the result
   * set, used by the prompt-injection path.
   */
  includePrelude?: boolean;
  /** Maximum results. Backends pick a sensible default if omitted. */
  limit?: number;
}

/**
 * A single memory item returned by `query` / `list` / `get`. Intentionally
 * thin — backends surface whatever extra signal they want via `metadata`
 * (score, invalidated_at, tags, source, etc.). Callers that need specific
 * fields should read them from `metadata` and tolerate absence.
 */
export interface MemoryFragment {
  text: string;
  id?: string;
  metadata?: Record<string, unknown>;
}

export interface PreludeContext {
  scope?: string | string[];
}

export interface ListQuery {
  scope?: string | string[];
  tags?: string[];
  kind?: string;
  pinned?: boolean;
  expiringBefore?: string;
  limit?: number;
  offset?: number;
}

/**
 * The contract every memory backend implements. See module-level docs
 * for the design rationale.
 */
export interface MemoryBackend {
  /** Stable id matching `memory.backend.provider` in config. */
  id: string;

  // ─── Required ─────────────────────────────────────────────────
  /**
   * Persist a piece of memory. Backend owns ranking, dedup, lifecycle,
   * embedding choices. Returns the assigned id so callers can later
   * `delete(id)` or `write({ supersedes: id })`.
   */
  write(content: MemoryContent, hint?: MemoryHint): Promise<{ id: string }>;

  /**
   * Return whatever the backend thinks is relevant to the given context.
   * Backends may interpret `freeText` semantically, by keyword, or both.
   * Returning an empty array is fine — no results is not an error.
   */
  query(context: QueryContext): Promise<MemoryFragment[]>;

  // ─── Optional ─────────────────────────────────────────────────
  /**
   * Explicit delete by id. Universal across real memory libraries
   * (Letta, Zep, LangMem, Mem0 entity-level) for human/admin-initiated
   * cleanup. Optional in the type system so backends that genuinely
   * can't expose deletion (rare) aren't forced to lie. Returns true
   * when something was removed.
   */
  delete?(id: string): Promise<boolean>;

  /**
   * Text the backend wants prepended to every prompt (identity /
   * always-injected state). Backends with no concept of persistent
   * identity omit this. The returned string is concatenated into the
   * system prompt by the agent loop.
   */
  prelude?(context: PreludeContext): Promise<string>;

  /**
   * Paginated list for admin/UI inspection. Backends that can't
   * enumerate (some hosted memory services) omit this; the Memory
   * dashboard renders a degraded view when absent.
   */
  list?(query: ListQuery): Promise<MemoryFragment[]>;

  /** Fetch a specific record by id, for admin/UI inspection. */
  get?(id: string): Promise<MemoryFragment | null>;

  /** Count for pagination UI. Typically implemented alongside list. */
  count?(query?: ListQuery): Promise<number>;

  // ─── Lifecycle ────────────────────────────────────────────────
  /** Called on runtime shutdown or backend swap. */
  close?(): Promise<void>;
}
