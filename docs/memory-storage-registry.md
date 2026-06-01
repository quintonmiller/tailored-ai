# Memory Storage Backend Registry — Design

> Status: design — pending review. Tracks GitHub issue #8. Follow-up to the
> UI provider registry (#7) and the embedding registry that shipped in
> modularity wave 3.

## Goal

Make the memory storage layer swappable so plugins can replace SQLite with
pgvector, Chroma, Pinecone, Postgres, or a hosted memory service —
*without forking core*.

Today the embedding **provider** is already a plugin contract
(`EmbeddingRegistry`), but the **storage** layer that holds facts, notes,
chunks, and core memory is hardcoded as a set of SQLite query modules under
`packages/core/src/db/`. The agent loop, tools, server routes, and CLI
commands all call into those modules directly.

This doc proposes the interface, the migration path, and the parts we are
*not* going to abstract.

## Surface area as it stands

Four logical concerns, all SQLite-backed, all sync:

| Concern | Module | Tables | Callers |
|---|---|---|---|
| Typed facts | `db/fact-queries.ts` | `facts` | `tools/facts.ts`, `/api/facts*`, agent loop |
| Notes (short-term memory, TTL, pinned) | `db/note-queries.ts` | `notes` | `tools/recall.ts`, `/api/memory/notes*`, exploratory worker |
| Embedded chunks (semantic search) | `db/chunk-queries.ts` | `chunks` (BLOB vector + metadata) | `tools/recall.ts`, `agent/memory-index.ts`, `/api/memory/stats` |
| Core memory (always-injected identity) | `db/core-memory-queries.ts` | `core_memory` | agent loop system prompt, `tools/core-memory.ts`, exploratory tick-context |

Higher-level memory logic that sits on top of those four:

- `agent/memory-inject.ts` — `buildMemoryBlock`, `buildMemoryBlockWithMeta`. Pulls from notes + chunks, ranks, renders.
- `agent/memory-index.ts` — `indexNote`, `indexKbDir`. Calls the embedding provider, writes chunks.
- `agent/memory-promotion.ts` — `promoteNote`, `recordNoteHit`, `runMemorySweep`. TTL/ref-count lifecycle.
- `tools/recall-query.ts` — `recallQuery`, `recallQueryAsync`. Hybrid keyword + semantic ranking.

The higher-level modules don't open SQL themselves; they call the four
storage modules. They *do* live in the agent layer, not the storage layer
— important for the layering below.

SQL features the storage layer actually uses:
- JSON1 (`json_each` for tag filtering, `json_insert` for archival flag) — replaceable by typed query fields in the interface.
- Triggers (`trg_facts_updated_at`, audit append-only) — strictly behind the backend.
- Float32 blobs for embeddings + in-process cosine sweep — see below.
- `ON DELETE CASCADE` on `notes → sessions` and `chunks → projects` — semantic, not just optimisation. The interface needs an explicit "remove for session/project" affordance.

What is **not** in scope and stays in core/SQLite forever:

- Sessions and messages (chat history) — not memory.
- Approvals, projects, project tasks, autopilot state, cron, workflows, audit log — operational.
- `workflows/analytics.ts` (the one leaky place where non-storage modules run multi-table SQL) — analytics over operational tables, unrelated to memory.

The boundary we're drawing is: anything an agent recalls about itself, the
user, or prior context goes through the registry. Operational state stays
in SQLite forever.

## The interface

Four sub-interfaces, one composite `MemoryStorageBackend`. Sub-interfaces
matter: a plugin should be able to swap *only* chunks (e.g. pgvector while
keeping facts/notes in SQLite) by composing the built-in SQLite backend
with a pgvector chunk store.

```ts
// packages/core/src/memory/interface.ts

export interface FactStore {
  upsert(input: FactInput): Promise<Fact>;
  get(id: string): Promise<Fact | null>;
  find(category: string, entity: string, key: string, projectId: string | null): Promise<Fact | null>;
  list(query: FactQuery): Promise<Fact[]>;
  delete(id: string): Promise<boolean>;
  forget(category: string, entity: string, key: string, projectId: string | null): Promise<boolean>;
}

export interface NoteStore {
  create(input: NoteInput): Promise<Note>;
  get(id: string): Promise<Note | null>;
  list(query: NoteQuery): Promise<Note[]>;
  listPinned(query: PinnedNotesQuery): Promise<Note[]>;
  update(id: string, patch: NotePatch): Promise<Note | null>;
  delete(id: string): Promise<boolean>;
  incrementRef(id: string): Promise<number | null>;
  extendTtl(id: string, extraDays: number): Promise<string | null>;
  sweepExpired(keepImportance: number): Promise<number>;
}

export interface ChunkStore {
  create(input: MemoryChunkInput): Promise<MemoryChunk>;
  get(id: string): Promise<MemoryChunk | null>;
  listBySource(source: string): Promise<MemoryChunk[]>;
  deleteBySource(source: string): Promise<number>;
  count(projectId?: string | null): Promise<number>;
  /**
   * Semantic search. Backends that own a vector index (pgvector,
   * Chroma) run cosine server-side. The built-in SQLite backend sweeps
   * all chunks and computes cosine in-process — fine for <100k chunks.
   */
  semanticSearch(query: Float32Array, opts: ChunkSearchOptions): Promise<ChunkSearchHit[]>;
}

export interface CoreMemoryStore {
  get(scope: CoreMemoryScope): Promise<CoreMemoryRow[]>;
  getSection(scope: CoreMemoryScope, section: string): Promise<CoreMemoryRow | null>;
  set(input: SetCoreMemoryInput): Promise<CoreMemoryRow>;
  append(input: AppendCoreMemoryInput): Promise<CoreMemoryRow>;
  removeLine(scope: CoreMemoryScope, section: string, match: string, opts?: RemoveLineOptions): Promise<CoreMemoryRow | null>;
  clearSection(scope: CoreMemoryScope, section: string): Promise<boolean>;
}

export interface MemoryStorageBackend {
  id: string;
  facts: FactStore;
  notes: NoteStore;
  chunks: ChunkStore;
  coreMemory: CoreMemoryStore;
  /** Closes any open connections or workers. Called on runtime shutdown. */
  close?(): Promise<void>;
}
```

### Two non-obvious shape decisions

**Async everywhere.** Today SQLite calls are sync. Going async is the
single biggest source of code churn in this refactor, but it's
non-negotiable — a remote backend has no other choice. We pay it once,
upfront. The built-in SQLite backend wraps sync calls in resolved
promises; perf cost is negligible.

**`Float32Array` at the boundary.** Embeddings are produced by the
embedding provider (already a registry) and passed into the chunk store.
We keep the interface vector-typed, not text-typed: the *embedding* is
the contract between provider and storage. A backend that owns its own
embedder (Pinecone-style) can still satisfy this — it just embeds again
internally and accepts a small redundancy. The alternative — passing
text and letting the backend embed — couples storage to embedding choice
and breaks the existing `EmbeddingRegistry` separation.

## The registry

```ts
// packages/core/src/memory/registry.ts

export type MemoryStorageFactory = (
  runtime: AgentRuntime,
  config: Record<string, unknown>,
) => Promise<MemoryStorageBackend> | MemoryStorageBackend;

export const memoryStorageFactoryRegistry = new Registry<MemoryStorageFactory>("memory-storage");
export function registerMemoryStorageFactory(id: string, factory: MemoryStorageFactory): void;
export async function resolveMemoryStorage(runtime: AgentRuntime): Promise<MemoryStorageBackend>;
```

Same shape as ChannelRegistry / UiProviderRegistry. Config field
`memory.storage.provider` defaults to `"builtin"`; per-provider config
slice at `memory.storage.<id>`. The built-in factory is registered by
core on module import and reads `runtime.db` directly.

## Migration path

Three phases. Each phase is a self-contained PR that leaves the codebase
shippable.

### Phase 1 — Wrap, don't rewrite

Introduce the interface, the registry, and a `SqliteMemoryStorageBackend`
that delegates to the existing `db/*-queries.ts` functions verbatim. No
call sites change yet: `runtime.db` and the `db/*-queries.ts` exports
stay public. The backend is exposed via `runtime.getMemoryStorage()` for
new code, but old code keeps using the sync SQL helpers.

This phase ships the contract and the built-in implementation. Plugin
authors can already register an alternative backend and use it via the
runtime accessor, but they won't be exercised by the agent loop yet.

### Phase 2 — Route the high-level memory modules through the backend

Switch `agent/memory-inject.ts`, `agent/memory-index.ts`,
`agent/memory-promotion.ts`, and `tools/recall-query.ts` to call
`runtime.getMemoryStorage()` instead of `db/*-queries.ts` directly. These
modules already mediate between agent code and storage; they're the
natural choke point.

This phase forces the agent loop async at the memory boundary.
`buildMemoryBlockWithMeta` becomes async (it already is, partially —
semantic search is async-aware). Several `await`s land in `agent/loop.ts`
and `tools/recall.ts`.

After this phase a third-party backend actually gets exercised when the
agent recalls or writes memory. Tools and server routes still call SQL
directly — that's fine, they're CRUD surfaces, not hot paths.

### Phase 3 — Route the leaf tools and server routes through the backend

Switch `tools/facts.ts`, `tools/recall.ts`, `tools/core-memory.ts`, and
the `/api/memory/*` and `/api/facts*` server routes from `db/*-queries`
to the registry-resolved backend. After this phase the SQLite query
modules are an internal detail of the built-in backend, not a public
API.

Old exports stay (`upsertFact`, `createNote`, etc.) but become thin
re-exports of the SQLite backend's methods — for back-compat. We can
deprecate them in a later major.

## Editor

Drops `allowCustom={false}` on the Memory row in `packages/cli/src/editor/App.tsx`.
The flow mirrors the UI provider path that shipped in #7: pick "Use
custom package…", resolve URI, append to `plugins:[]`, write
`memory.storage.provider: <manifestId>` to `config.yaml`.

`setup.ts` gains a `hydrateMemoryStorage(doc)` / `applyMemoryStorageSlot(doc, slot)`
pair matching the UI helpers already there.

## What we're explicitly not doing

- **Splitting SQLite further.** Sessions, messages, projects, tasks,
  approvals, autopilot, cron, workflows, audit log stay in the
  hardcoded SQLite layer. Not negotiable for v1 — those are operational
  tables, not memory.
- **A query DSL.** `NoteQuery`, `FactQuery`, etc. stay as typed objects.
  No SQL-like expression trees. If a backend can't satisfy the typed
  query, it errors — same contract the SQLite backend has today.
- **Multi-backend composition out of the box.** Plugins *can* hand-roll
  a backend that mixes SQLite for facts/notes/coreMemory and pgvector
  for chunks (the sub-interface split makes this feasible), but core
  doesn't ship a composition helper. Cross-table consistency is the
  composer's problem.
- **Transactional writes across stores.** The agent loop already doesn't
  rely on cross-store transactions. We document that and move on.
- **Backfill / migration tools between backends.** A user switching from
  SQLite to pgvector has to migrate their data themselves. Tooling can
  come later if the use case shows up.

## Open questions

1. **Do we need a streaming variant of `semanticSearch` for large remote backends?** Probably yes eventually, but not for v1 — current call sites consume the full result list.
2. **Should `runtime.db` stay on the runtime?** Yes, for operational tables. The new accessor is `runtime.getMemoryStorage()`; the two coexist.
3. **Where does the embedding provider get plumbed?** `agent/memory-index.ts` already pulls it from the runtime. No change.
4. **Does the registry need a "default-with-fallback" mode for tests?** No — tests can register their own factory or use the SQLite backend in-memory (`:memory:`).

## Estimate

- Phase 1: ~600–800 lines (interface, registry, SQLite backend wrapper, tests, runtime accessor, registration). 1 PR.
- Phase 2: ~400–600 lines plus a wave of `await`s through the agent loop. Mostly mechanical. 1 PR.
- Phase 3: ~300–500 lines, mostly call-site swaps in tools and server routes. 1 PR.

Phase 1 unblocks plugin authors to start prototyping backends. Phase 2
makes the contract real. Phase 3 finishes the cleanup.
