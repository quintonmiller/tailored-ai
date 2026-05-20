# Tiered Memory

Design: [memory-tiers.md](./memory-tiers.md). This doc captures the implementation surface (M1–M7 complete: schema, write surface, keyword retrieval, loop injection, end-of-session summarization, embeddings + semantic search, ref-count-driven promotion + daily sweep, HTTP/UI surface).

## Core APIs

- `packages/core/src/tools/recall.ts` — `RecallTool` with `query` / `note` / `forget` / `list` actions
- `packages/core/src/tools/recall-query.ts` — `recallQuery()` ranks notes (short-term) and facts (long-term) by term coverage with small bonuses for tag/key/entity matches. Scores are a ranking signal, not capped at 1.0
- `packages/core/src/db/note-queries.ts` — `createNote`, `getNote`, `listNotes`, `deleteNote`, `sweepExpiredNotes`
- Note IDs: `note_<8-char-uuid>` format
- Tags stored as JSON arrays, filtered via SQLite `json_each()`
- TTLs stored as ISO 8601; compared via `datetime(ttl_at) > datetime('now')` to normalize formats
- Default TTL: 14 days. Notes with `importance >= 0.8` survive sweeps
- Project-scoped by default: pass `project_id: "global"` for cross-project notes
- `query` action accepts `tier: any|short|long` to scope retrieval to one tier

## Injection & loop integration

- Loop injection: set `agents.<name>.injectMemory: true` (default false) to prepend a `[Relevant memory]` block to the system prompt. Memory is searched by `recallQuery` against the current user message and capped at `memoryInjectBudgetTokens` (default 800). See `packages/core/src/agent/memory-inject.ts`.
- `ToolContext.workingMemory: Map<string,string>` — per-loop scratch shared across tool calls within a single agent run. Cleared when the loop ends. Use for "stash so the next tool call can pick it up" patterns.
- `ToolContext.projectId` — mirrors `session.projectId`, available to tools that need project scope without poking at the db.

## Session summarization

- `packages/core/src/agent/summarize-session.ts` — `summarizeSession(db, sessionId, provider, model, opts)` writes a note tagged `session-summary` capturing the transcript. Idempotent (skipped if a summary already exists; `force: true` overrides). Importance scales with message count + tool calls. Default TTL 30 days.
- `sweepIdleSessions(db, provider, model, opts)` — batch helper finds sessions where `updated_at <= now - idleMinutes` and runs `summarizeSession` on each. Supports `keyPrefixes` to target specific session kinds (e.g. `["autopilot:", "cron:"]`).
- `deleteSession(db, sessionId)` — removes the session row + all its messages.
- HTTP: `DELETE /api/sessions/:id` summarizes (unless `?summarize=0`) then deletes. Pass `?force=1` to re-summarize.

## Embeddings & semantic search

- `EmbeddingProvider` (`packages/core/src/providers/embedding.ts`) — small interface mirroring `AIProvider` but producing dense float vectors. `OpenAICompatibleEmbeddingProvider` hits `/v1/embeddings` for vLLM/Ollama/LM Studio/hosted OpenAI.
- Config: `memory.embeddings.{enabled, baseUrl, apiKey, model, dim}` (default off — opt in per project/runtime). `memory.chunks.{maxChunkChars, overlap}` for indexer parameters.
- `runtime.getEmbedder()` exposes the configured provider; `createEmbedder(config)` is the factory.
- Vector storage: `memory_chunks.embedding` is a SQLite BLOB; encoded via `vectorToBlob` / decoded via `blobToVector`. Float32Array round-trips losslessly.
- `chunk-queries.ts`: `createChunk`, `listChunksBySource`, `deleteChunksBySource`, `semanticSearch(db, queryVec, {projectId, limit, minScore})`. Brute-force cosine; acceptable up to ~10k chunks before needing sqlite-vss.
- `agent/memory-index.ts`: `chunkText(text, {maxChunkChars, overlap})` sliding-window splitter; `indexNote(db, embedder, note)` is idempotent (replaces prior chunks); `indexKbDir(db, embedder, kbDir, {projectId})` backfills KB.
- `recallQueryAsync(db, opts)` is the async sibling of `recallQuery` that merges semantic + keyword hits by source. Falls back to keyword-only when the embedder throws.
- `RecallTool.query` action automatically uses semantic when the runtime has an embedder configured.

## Promotion & sweep

- `notes.ref_count` (M6): every note surfaced by `recall query` increments this counter. Auto-promotion (`recallQuery({trackRefs:true, autoPromote:true, embedder})`) clones a note into `memory_chunks` once `ref_count >= 3` so semantic search finds it. Idempotent: existing chunks short-circuit the promotion.
- `recall action: promote` — manual promotion of a specific note id. Requires an embedder. Pass `force: true` to re-index.
- `promoteNote(db, embedder, noteId, opts)` — programmatic API. `recordNoteHit(db, noteId, {embedder, threshold, onPromote})` — ref-tracker + fire-and-forget promotion.
- `runMemorySweep(db, opts)` — daily hygiene pass: extends TTL on referenced-but-expiring notes (`ref_count >= 3`, ttl ≤ now+1d → +7 days), then deletes expired low-importance notes. Returns `{deletedExpired, extendedTtl, remainingNotes, totalChunks}`.
- AutopilotWorker schedules the sweep daily at 03:14 (via croner). Started/stopped with the worker.

## HTTP & UI

HTTP API (M7) — under `/api/memory/`:
- `GET /notes?project=&tag=&search=&limit=` — list live (non-expired) notes
- `GET /notes/:id` — single note
- `DELETE /notes/:id` — delete
- `POST /notes/:id/promote` (body: `{ force?: boolean }`) — manual semantic promotion
- `GET /recall?q=&project=&tier=&limit=` — ranked search, formatted output included
- `GET /stats?project=` — `{ counts, topReferenced, embeddingsEnabled, embeddingModel }`
- `POST /sweep` — runs `runMemorySweep` on demand

UI (M7): `#/memory` page with stats tiles, recall search, most-referenced panel, full note list with delete/promote actions. Dashboard gains a `Memory` section showing the same stats + top-referenced links to `#/memory`. See `packages/ui/src/pages/Memory.tsx`.
