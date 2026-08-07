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
- Daily sweep schedule: `autopilot.memorySweepCron` (default `"14 3 * * *"`; empty string disables)
- Project-scoped by default: pass `project_id: "global"` for cross-project notes
- `query` action accepts `tier: any|short|long` to scope retrieval to one tier

## Injection & loop integration

- Loop injection: set `agents.<name>.injectMemory: true` (default false) to prepend a `[Relevant memory]` block to the system prompt. Memory is searched by `recallQuery` against the current user message and capped at `memoryInjectBudgetTokens` (default 800). See `packages/core/src/agent/memory-inject.ts`.
- `ToolContext.workingMemory: Map<string,string>` — per-loop scratch shared across tool calls within a single agent run. Cleared when the loop ends. Use for "stash so the next tool call can pick it up" patterns.
- `ToolContext.projectId` — mirrors `session.projectId`, available to tools that need project scope without poking at the db.

### Whose memory gets injected

Injection is scoped by **agent**, not just project. An agent recalls its own notes plus notes nobody claimed (`agent IS NULL` — written before authorship was recorded, or by an unnamed session). It does not recall another agent's.

The scope travels as an open token string, `global agent:coder` or `project:x agent:coder`, built by `memoryScope()` in `packages/core/src/memory/scope.ts`. No `MemoryBackend` contract change was needed: `scope` was already `string | string[]`, and the SQLite backend's `parseScope` already understood `agent:` — the injection path simply never sent it.

A session with no agent name sends no `agent:` token and so keeps the cross-agent view, which is the behaviour that predates scoping. That is deliberate: a session that cannot say whose it is should not silently recall less.

**Facts are still not agent-scoped.** The `facts` table has no `agent` column at all — the authoring agent is recorded only as free-text `source` — so a fact remains visible to every agent. Fixing that needs a migration and is tracked separately.

Why it matters: before this, any agent with `injectMemory` read every other agent's notes and narrated them as its own recollection. Pinned notes were the expensive case, since those inject regardless of relevance and so landed in every agent's prompt on every turn. The symptom reads as a persona bug and is very hard to trace back to scoping.

## Session summarization

- `packages/core/src/agent/summarize-session.ts` — `summarizeSession(db, sessionId, provider, model, opts)` writes a note tagged `session-summary` capturing the transcript. Idempotent (skipped if a summary already exists; `force: true` overrides). Importance scales with message count + tool calls. Default TTL 30 days.
- `sweepIdleSessions(db, provider, model, opts)` — batch helper finds sessions where `updated_at <= now - idleMinutes` and runs `summarizeSession` on each. Supports `keyPrefixes` to target specific session kinds (e.g. `["autopilot:", "cron:"]`).
- `deleteSession(db, sessionId)` — removes the session row + all its messages.
- HTTP: `DELETE /api/sessions/:id` summarizes (unless `?summarize=0`) then deletes. Pass `?force=1` to re-summarize.

### `builtin:session-summarizer` plugin (cross-channel continuity, opt-in)

Sessions are hermetic per-channel silos (`discord:<user>`, `web:<key>`). Out of the box nothing summarizes an idle session, so a new session on a different channel starts cold — the agent has no idea what it just discussed elsewhere. This plugin closes that gap.

It ships **installed but disabled** (`DEFAULT_DISABLED_PLUGIN_MODULES` in `config.ts`). It autonomously calls the LLM and writes memory, so it's opt-in: enable it deliberately. No behavior change for anyone who leaves it off.

On a timer it sweeps idle sessions (`sweepIdleSessions`), then refreshes the `recent_summary` **core-memory** section — the always-injected identity layer keyed by `(agent, project_id)`, read on every turn (`agent/loop.ts`). `recent_summary` is what carries continuity: the next session on any channel sees a compact "here's what recently happened" block. The section is composed from the most recent summaries (newest first) and hard-capped (~600 bytes) so the always-injected layer stays small for local models. Sessions don't store an agent, so the section is keyed by the `default` agent (the same fallback the loop uses for anonymous chat) plus the session's `project_id`.

Idempotence comes for free: `summarizeSession` skips sessions that already have a `session-summary` note (the plugin never passes `force`), so a steady-state sweep makes no LLM calls and the log line is silent.

Enable it by flipping the seeded entry in `config.yaml`:

```yaml
plugins:
  - module: builtin:session-summarizer
    enabled: true
    config:
      intervalMinutes: 30          # sweep cadence (default 30)
      idleMinutes: 120             # only sessions idle this long (default 120)
      maxPerSweep: 5               # cap sessions summarized per sweep — bounds LLM cost (default 5)
      keyPrefixes: ["discord:", "web:"]  # optional; omit = all sessions
      updateRecentSummary: true    # refresh recent_summary after a sweep (default true)
      recentSummaryCount: 3        # how many recent summaries to compose (default 3)
      recentSummaryMaxBytes: 600   # byte cap on the composed section (default 600)
```

For a personal install with Discord + web sessions, `keyPrefixes: ["discord:", "web:"]` scopes the sweep to real user conversations and leaves autopilot/cron sessions alone.

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
- AutopilotWorker schedules the sweep from `autopilot.memorySweepCron` (default daily at 03:14, via croner). Started/stopped with the worker.

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

## `/memory` — core memory from Discord

Note that everything above is about *notes*. Core memory is the other store: per-agent, section-based, and injected into the system prompt on every turn (see [Injection & loop integration](#injection--loop-integration)).

```
/memory show   agent:iris [section:persona]
/memory set    agent:iris section:persona content:…
/memory append agent:iris section:persona content:…
/memory clear  agent:iris section:persona
```

Sections are the fixed set in `CORE_MEMORY_SECTIONS`: `persona`, `active_threads`, `recent_summary`, `open_questions`, `user_state`.

Why it exists: until this, the only writer was the agent itself through the `core_memory` tool, and there was no reader outside the database. An agent could write itself a persona that shaped every later answer, and nobody could see it — let alone correct it. Sessions could already be reset and rewound; core memory could only be changed by asking the agent nicely.

Three properties worth keeping if you touch it:

- **`set` and `clear` return the text they destroyed.** There is no history table for core memory, so without that an overwrite is unrecoverable. Same reason `/room rewind` hides rather than deletes.
- **Replies are ephemeral.** A persona is usually written in the first person; a channel is the wrong place to print it.
- **`updated_by` records the person, not the agent.** Almost every existing row is self-authored, so "who wrote this" is the first thing you want when a persona looks wrong.

An unknown agent or section is refused before any write — a typo would otherwise create core memory nothing ever reads.

Core memory is keyed by agent name and does not travel: `/clone-agent from:iris to:juno` copies a configuration and leaves the persona behind, so the clone starts empty. See [Agents & Delegation](./agents-and-hooks.md#clone-agent--copy-a-configuration-and-nothing-else).
