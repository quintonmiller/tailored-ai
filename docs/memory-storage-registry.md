# Memory Storage Backend Registry — Design

> Status: design — pending review. Tracks GitHub issue #8. Follow-up to the
> UI provider registry (#7) and the embedding registry that shipped in
> modularity wave 3.

## Goal

Make the memory layer swappable so plugins can replace SQLite with
pgvector, Chroma, Pinecone, Postgres, a hosted memory service, or any of
the agent-memory libraries on the market — *without forking core, and
without forcing those backends to pretend they share our mental model.*

Today the embedding **provider** is already a plugin contract
(`EmbeddingRegistry`), but the **storage** layer that holds facts, notes,
chunks, and core memory is hardcoded as a set of SQLite query modules
under `packages/core/src/db/`. The agent loop, tools, server routes, and
CLI commands all call into those modules directly.

This doc proposes the interface, the migration path, and the parts we are
*not* going to abstract.

## Design principle: don't make backends speak our vocabulary

Our SQLite layer thinks in `notes`, `facts`, `chunks`, `core_memory`,
each with their own SQL surface (`upsertFact`, `incrementNoteRef`,
`extendNoteTtl`, `setCoreMemory`, etc.). It is *one* way of modelling
agent memory — but it is not the only way, or even the dominant way.

A survey of production memory libraries shows that almost none of them
share our shape:

- **[Letta](https://docs.letta.com/guides/core-concepts/memory/memory-blocks/)** models memory as "blocks" — labelled persistent strings — plus archival storage in a vector DB. Edits are full-replace; no append/section ops in the API.
- **[Mem0 v3](https://docs.mem0.ai/migration/platform-v2-to-v3)** uses an add-only pipeline that preserves contradictions with temporal context. The agent never sends UPDATE or DELETE during normal operation; reconciliation is the backend's job. Per-memory delete was explicitly removed at the processing layer because it was lossy.
- **[Zep](https://help.getzep.com/deleting-data-from-the-graph)** is a temporal knowledge graph: edges (facts) get marked *invalid* when later episodes contradict them; nothing is deleted on the hot path.
- **[LangMem](https://langchain-ai.github.io/langmem/reference/tools/)** exposes a single `manage_memory_tool` with `action: create | update | delete`; the LLM picks.

The pattern across all four: a tiny verb set (write something, read what's
relevant) plus an explicit `delete(id)` for human-initiated cleanup. None
of them expose `incrementRefCount`, `extendTtl`, `pin`, or anything like
our four-bucket split as backend operations. Lifecycle is private to the
backend; the agent just calls write and read.

If we want third-party backends to actually plug in, the contract has to
match this shape — not ours.

## Surface area as it stands

Four logical concerns, all SQLite-backed, all sync:

| Concern | Module | Tables | Callers |
|---|---|---|---|
| Typed facts | `db/fact-queries.ts` | `facts` | `tools/facts.ts`, `/api/facts*`, agent loop |
| Notes (short-term memory, TTL, pinned) | `db/note-queries.ts` | `notes` | `tools/recall.ts`, `/api/memory/notes*`, exploratory worker |
| Embedded chunks (semantic search) | `db/chunk-queries.ts` | `chunks` (BLOB vector + metadata) | `tools/recall.ts`, `agent/memory-index.ts`, `/api/memory/stats` |
| Core memory (always-injected identity) | `db/core-memory-queries.ts` | `core_memory` | agent loop system prompt, `tools/core-memory.ts`, exploratory tick-context |

Higher-level memory logic on top:

- `agent/memory-inject.ts` — `buildMemoryBlock`, `buildMemoryBlockWithMeta`. Pulls from notes + chunks, ranks, renders.
- `agent/memory-index.ts` — `indexNote`, `indexKbDir`. Calls the embedding provider, writes chunks.
- `agent/memory-promotion.ts` — `promoteNote`, `recordNoteHit`, `runMemorySweep`. TTL/ref-count lifecycle.
- `tools/recall-query.ts` — `recallQuery`, `recallQueryAsync`. Hybrid keyword + semantic ranking.

These higher-level modules don't open SQL themselves; they call the four
storage modules. They live in the *agent layer*, not the storage layer —
important for the design below.

SQL features the SQLite layer actually uses:
- JSON1 (`json_each` for tag filtering, `json_insert` for archival flag).
- Triggers (`trg_facts_updated_at`, audit append-only).
- Float32 blobs for embeddings + in-process cosine sweep.
- `ON DELETE CASCADE` on `notes → sessions` and `chunks → projects`.

What is **not** in scope and stays in core/SQLite forever:

- Sessions and messages (chat history) — not memory.
- Approvals, projects, project tasks, autopilot state, cron, workflows, audit log — operational.
- `workflows/analytics.ts` — analytics over operational tables, unrelated to memory.

The boundary: anything an agent recalls about itself, the user, or prior
context goes through the registry. Operational state stays in SQLite.

## The interface

Two required verbs. Six optional methods. One lifecycle hook. Flat — no
sub-objects.

```ts
// packages/core/src/memory/interface.ts

export interface MemoryBackend {
  id: string;

  // ─── Required ────────────────────────────────────────────────
  /** Persist a piece of memory. Backend owns ranking, dedup, lifecycle. */
  write(content: MemoryContent, hint?: MemoryHint): Promise<{ id: string }>;

  /** Return whatever the backend thinks is relevant to the given context. */
  query(context: QueryContext): Promise<MemoryFragment[]>;

  // ─── Optional ────────────────────────────────────────────────
  /** Explicit delete by id. Universal across real memory libraries
   *  (Letta, Zep, LangMem, Mem0 entity-level) for human/admin-initiated
   *  cleanup. Optional in the type system so backends that genuinely
   *  can't expose deletion (rare) aren't forced to lie. */
  delete?(id: string): Promise<boolean>;

  /** Text the backend wants prepended to every prompt (identity / always-
   *  injected state). Backends with no concept of persistent identity
   *  omit this. */
  prelude?(context: PreludeContext): Promise<string>;

  /** Inspection — paginated list, by-id fetch, count. The dashboard
   *  Memory page declares this as a required capability and degrades
   *  gracefully when it's missing (some hosted backends don't expose
   *  enumeration). */
  list?(query: ListQuery): Promise<MemoryFragment[]>;
  get?(id: string): Promise<MemoryFragment | null>;
  count?(query?: ListQuery): Promise<number>;

  // ─── Lifecycle ───────────────────────────────────────────────
  close?(): Promise<void>;
}
```

Supporting shapes — intentionally thin:

```ts
export interface MemoryContent {
  text: string;
  structured?: unknown;  // facts and the like — opaque to the backend
}

export interface MemoryHint {
  // All fields advisory. The backend may use or ignore any of them.
  tags?: string[];
  kind?: string;                          // "fact" | "note" | "prelude" | string
  scope?: string;                         // "project:abc" | "agent:foo" | …
  sourceUri?: string;                     // provenance
  suggestedImportance?: number;           // 0–10ish; backend may compute its own
  suggestedTtl?: string | null;           // ISO; backend may ignore
  vector?: Float32Array;                  // precomputed embedding
  /** Structural supersession. Set when this write replaces or invalidates
   *  a prior record. Backend decides interpretation: replace in place
   *  (Letta-style), append with invalid flag (Mem0/Zep-style), or any
   *  other reconciliation policy. */
  supersedes?: string;
}

export interface QueryContext {
  freeText?: string;                                  // for hybrid keyword/semantic
  vector?: Float32Array;                              // explicit query vector, overrides text-derived
  recentMessages?: { role: string; content: string }[];
  scope?: string | string[];
  tags?: string[];                                    // AND filter
  wantStructured?: Record<string, unknown>;           // exact-match hint (e.g. fact lookup)
  minImportance?: number;
  includePrelude?: boolean;                           // include always-injected items in results
  limit?: number;
}

export interface MemoryFragment {
  text: string;
  id?: string;                                        // backend's id; optional
  metadata?: Record<string, unknown>;                 // backend may surface anything (score, tags, invalidated_at, source, …)
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
```

### Why this shape and not the noun-based one

We started with a four-sub-interface design (`FactStore`, `NoteStore`,
`ChunkStore`, `CoreMemoryStore`) that mirrored our SQLite tables.
Rejected because it forces every backend to speak our specific
vocabulary — a Letta block, a Mem0 fact, and a SQLite note all have to
be jammed into separate interfaces even though those backends don't see
them as separate concerns.

We then drafted a slightly thinner version with `pinned`, `importance`,
`ttlAt`, `refCount`, `promote()`, `decay()`, `getIdentity()`, etc. on the
interface. Rejected because every one of those is a SQLite-backend
*opinion* about how to manage lifecycle. None of the real memory
libraries expose any of them as API verbs.

The verb-based design above is what we landed on. The trade is real:

**What it loses.** The agent layer no longer gets typed CRUD per
bucket. Code like `upsertFact(category, entity, key)` becomes a *helper*
in `tools/facts.ts` that calls `write({ structured: { category, entity, key, value } }, { kind: "fact" })`. If the backend can't index structured payloads, the helper filters returned fragments client-side after `query({ wantStructured: ... })`. Slower than today's `WHERE category = ?`, but only for backends that don't speak structured lookup natively — and the helper still works.

**What it gains.** Backends with a different model (Letta blocks, Mem0
fact graph, pgvector, a flat doc store) map without lying. Lifecycle
stays private. The contract is small enough that a plugin author can
implement a backend in an afternoon.

## How current code composes onto the contract

| Today | Becomes |
|---|---|
| `upsertFact(category, entity, key, value)` | `write({ text: value, structured: { category, entity, key } }, { kind: "fact" })` |
| `findFact(category, entity, key)` | `query({ wantStructured: { category, entity, key }, limit: 1 })` and filter |
| `createNote({...})` | `write({ text }, { tags, scope, suggestedImportance, suggestedTtl })` |
| `recallQuery(text)` | `query({ freeText: text, includePrelude: true })` |
| `buildMemoryBlock()` | `query({ freeText: lastUserMsg, includePrelude: true, limit: N })` + render |
| `indexNote()` (embed + store) | `write({ text }, { vector, kind: "note" })` |
| `setCoreMemory(scope, section, content)` | Compose: `query({ wantStructured: { section } })` to find prior, then `write({ text: content }, { kind: "prelude", scope, supersedes: priorId })` |
| `incrementNoteRef(id)`, `extendNoteTtl(id)` | **Gone from the contract.** Backends with refCount/TTL semantics maintain them privately based on `query()` traffic. |
| `runMemorySweep()` | **Gone from the contract.** Backends sweep on their own schedule (cron, on-write, never — backend's choice). |
| `forgetFact(category, entity, key)`, `deleteNote(id)` | `delete(id)` for explicit removal, or `write({ supersedes: priorId })` for semantic supersession |
| `listNotes(query)` (for dashboard) | `list?(query)` — capability-gated |

The typed helpers (`upsertFact`, `findFact`, `createNote`, etc.) stay in
`packages/core/src/agent/` and `packages/core/src/tools/` as composition
sugar over the verbs. The backend contract knows only verbs.

## The registry

Same shape as ChannelRegistry / UiProviderRegistry / TaskBackendRegistry:

```ts
// packages/core/src/memory/registry.ts

export type MemoryBackendFactory = (
  runtime: AgentRuntime,
  config: Record<string, unknown>,
) => Promise<MemoryBackend> | MemoryBackend;

export const memoryBackendFactoryRegistry = new Registry<MemoryBackendFactory>("memory-backend");
export function registerMemoryBackendFactory(id: string, factory: MemoryBackendFactory): void;
export async function resolveMemoryBackend(runtime: AgentRuntime): Promise<MemoryBackend>;
```

Config field `memory.backend.provider` defaults to `"builtin"`. Per-provider
config slice at `memory.backend.<id>`. The built-in factory is registered
by core on module import and reads `runtime.db` directly. Plugin
providers register on plugin import.

## Migration path

Three phases. Each phase is a self-contained PR that leaves the codebase
shippable.

### Phase 1 — Wrap the SQLite layer behind the verb interface

Introduce `MemoryBackend`, the registry, and `SqliteMemoryBackend` — a
verb-shaped adapter over the existing `db/*-queries.ts` modules. The
adapter is async-wrapped but delegates to the existing sync SQL calls.

No call sites change yet. `runtime.db` and the `db/*-queries.ts` exports
stay public. The backend is exposed via `runtime.getMemoryBackend()` for
new code, but old code keeps using the sync SQL helpers.

After Phase 1, plugin authors can register an alternative backend and
exercise it from new code. The agent loop isn't routed through the
backend yet, so existing behaviour is untouched.

### Phase 2 — Route the agent-layer modules through the backend

Switch `agent/memory-inject.ts`, `agent/memory-index.ts`,
`agent/memory-promotion.ts`, and `tools/recall-query.ts` to call
`runtime.getMemoryBackend()` instead of `db/*-queries.ts` directly.
These modules are the natural choke point — they already mediate between
agent code and storage.

This phase forces the agent loop async at the memory boundary.
`buildMemoryBlockWithMeta` becomes fully async (it's partially async
today); several `await`s land in `agent/loop.ts` and `tools/recall.ts`.

After Phase 2 a third-party backend actually gets exercised when the
agent recalls or writes memory. Tools and server routes still call SQL
directly — fine, they're CRUD surfaces, not hot paths.

### Phase 3 — Route the leaf tools and server routes through the backend

Switch `tools/facts.ts`, `tools/recall.ts`, `tools/core-memory.ts`, and
the `/api/memory/*` and `/api/facts*` server routes from
`db/*-queries.ts` to the registry-resolved backend. After this phase the
SQLite query modules are an internal detail of `SqliteMemoryBackend`,
not a public API.

Old exports stay (`upsertFact`, `createNote`, etc.) but become thin
wrappers — for back-compat. Deprecation can come in a later major.

## Editor

Drops `allowCustom={false}` on the Memory row in
`packages/cli/src/editor/App.tsx`. The flow mirrors the UI provider path
that shipped in #7: pick "Use custom package…", resolve URI, append to
`plugins:[]`, write `memory.backend.provider: <manifestId>` to
`config.yaml`.

`setup.ts` gains `hydrateMemoryBackend(doc)` / `applyMemoryBackendSlot(doc, slot)`
matching the UI helpers already there.

## What we're explicitly not doing

- **A query DSL.** Typed query objects only. Backends that can't
  satisfy a query reject it.
- **Cross-store transactions.** The agent loop already doesn't rely on
  them. Documented and moved on.
- **A composition helper for "SQLite for facts + pgvector for chunks."**
  Plugins can write one by hand if they want; core doesn't ship it.
- **Backfill / migration tooling between backends.** A user switching
  from SQLite to Pinecone migrates their own data.
- **An "invalidate without delete" verb.** Backends that work that way
  (Zep) handle invalidation internally based on `supersedes` in the
  hint; the contract doesn't need a separate verb.
- **Splitting SQLite further.** Sessions, messages, projects, tasks,
  approvals, autopilot, cron, workflows, audit log all stay hardcoded.

## Open questions

1. **`MemoryHint.vector?: Float32Array` — keep on the hint, or always force the runtime embedder?** Keeping it lets backends that own their embedding (Pinecone) skip the round-trip; removing it forces a single embedding source. Lean keep, since it's just a hint backends may ignore.
2. **`wantStructured` exact match vs. partial match.** Right now I'm assuming exact key-value match. Could grow to a `{ op: "eq" | "in" | "contains", value }` shape if real backends need it — but real libraries don't expose this granularity, so probably YAGNI.
3. **Should `count` be required if `list` is implemented?** The dashboard uses both for pagination UI. A backend that can `list` can almost certainly `count`. Probably yes, but not enforced in TS — documented as a coupling.

## Estimate

- Phase 1: ~500–700 lines (interface, registry, SqliteMemoryBackend wrapper, tests, runtime accessor, registration). 1 PR.
- Phase 2: ~400–600 lines plus a wave of `await`s through the agent loop. Mostly mechanical. 1 PR.
- Phase 3: ~300–500 lines, mostly call-site swaps in tools and server routes. 1 PR.

Phase 1 unblocks plugin authors to start prototyping. Phase 2 makes the
contract real for the agent loop. Phase 3 finishes the cleanup.
