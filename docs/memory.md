# Tiered Memory

Design: [memory-tiers.md](./memory-tiers.md). This doc captures the implementation surface (M1–M7 complete: schema, write surface, keyword retrieval, loop injection, end-of-session summarization, embeddings + semantic search, ref-count-driven promotion + daily sweep, HTTP/UI surface).

## Core APIs

- `packages/core/src/tools/recall.ts` — `RecallTool` with `query` / `note` / `list` / `promote` / `keep` / `archive` (alias `forget`) / `unarchive` actions
- `packages/core/src/tools/recall-query.ts` — `recallQuery()` ranks notes (short-term) and facts (long-term) by term coverage with small bonuses for tag/key/entity matches. Scores are a ranking signal, not capped at 1.0
- `packages/core/src/db/note-queries.ts` — `createNote`, `getNote`, `listNotes`, `deleteNote`, `archiveNote`, `unarchiveNote`, `keepNote`, `sweepExpiredNotes`
- `packages/core/src/db/fact-queries.ts` — `upsertFact`, `findFact`, `listFacts`, `archiveFact`, `unarchiveFact`, `deleteFact`
- Note IDs: `note_<8-char-uuid>` format
- Tags stored as JSON arrays, filtered via SQLite `json_each()`
- TTLs stored as ISO 8601; compared via `datetime(ttl_at) > datetime('now')` to normalize formats
- Default TTL: 14 days. Kept notes, and notes with `importance >= 0.8`, survive sweeps
- Daily sweep schedule: `autopilot.memorySweepCron` (default `"14 3 * * *"`; empty string disables)
- Project-scoped by default: `recall` reads and writes the session's active project (plus global notes, when reading) unless told otherwise; pass `project_id: "global"` for cross-project notes. It used to fall back to global when `project_id` was left out
- `query` action accepts `tier: any|short|long` to scope retrieval to one tier

## Archive

Notes and facts can be archived: hidden, not deleted. An archived note or fact
stays out of everything that loads context or searches — the pinned and
relevance tiers of injection, `recall` `query` and `list`, semantic search,
the `facts` tool's `list` and `search`, the briefing, the session summarizer's
`recent_summary`, an exploratory agent's tick notes, auto-promotion, and the
HTTP lists and counts. `unarchive` brings it back exactly as it was.

- **What agents remove, they archive.** `recall action="forget"` archives the
  note (reason `forgotten`, stamped with the agent's name) and tells the agent
  it can be restored. `facts action="forget"` archives the fact; setting the
  same key again restores it with the new value.
- **The sweep archives.** Expired, low-importance notes are archived with
  `archived_by: "sweep"` and reason `expired`, not deleted. Kept notes are
  never touched.
- **A person's delete stays a delete.** `DELETE /api/memory/notes/:id` and the
  Memory page's Delete remove the note for good, and now take its search
  chunks with them (they used to be left behind, still searchable).
- **Chunks follow their note.** A chunk promoted from a note surfaces only
  while that note exists and is live: archive the note and its chunks drop out
  of semantic search; restore it and they're back. The rule is a join on the
  note, so it can't drift. KB chunks are unaffected. An archived note is never
  auto-promoted, and `promote` refuses one.
- **Asking for archived.** `includeArchived: true` on `listNotes`,
  `listPinnedNotes`, `listFacts`, `semanticSearch`, `countChunks`, the recall
  tool's `query` and `list`, the facts tool's `list` and `search`, and
  `?includeArchived=1` on the HTTP lists bring archived items back, marked
  with `archived_at`, `archived_by` and `archive_reason`. Fetching one item by
  id — `getNote`, `GET /api/memory/notes/:id`, `facts get`,
  `GET /api/facts/:category/:entity/:key` — works on an archived item and says
  it's archived.

Storage: `archived_at` (NULL means live), `archived_by` and `archive_reason`
on `notes` and `facts`, the same three columns rooms use. Partial indexes over
live rows (`idx_notes_live`, `idx_facts_live`) serve the default reads.

**`keep` is not `archive`.** `recall action="keep"` (reason required) marks a
note kept: the sweep never archives it. Before this, that action was called
`archive` and set `notes.archival = 1`, which nothing read — a "kept" note was
swept like any other. The column still holds the flag (exposed as `Note.kept`),
and any old row with `archival = 1` reads as kept, never as hidden.

Core memory and the markdown memory files have no archive: core memory is
small, always loaded and edited in place.

## Injection & loop integration

- Loop injection: set `agents.<name>.injectMemory: true` (default false) to prepend a `[Relevant memory]` block to the system prompt. Memory is searched by `recallQuery` against the current user message and capped at `memoryInjectBudgetTokens` (default 800). See `packages/core/src/agent/memory-inject.ts`.
- `ToolContext.workingMemory: Map<string,string>` — per-loop scratch shared across tool calls within a single agent run. Cleared when the loop ends. Use for "stash so the next tool call can pick it up" patterns.
- `ToolContext.projectId` — mirrors `session.projectId`, available to tools that need project scope without poking at the db.

### Whose memory an agent reads

Notes are private to the agent that wrote them. An agent reads its own notes plus notes nobody claimed (`agent IS NULL` — written before authorship was recorded, or by an unnamed session), and never another agent's, by every path it has:

- prompt injection, both the pinned and the relevance tier;
- the `recall` tool's `query` and `list`, which pass the calling agent (`ToolContext.agentName`) the same way;
- semantic search: a chunk promoted from a note follows that note's owner (a join on the note, so it can't drift), so promoting a note into the index doesn't make it public. KB chunks stay shared.

The scope travels as an open token string, `global agent:planner` or `project:x agent:planner`, built by `memoryScope()` in `packages/core/src/memory/scope.ts`. The SQLite backend's `parseScope` understands `agent:` for `query` and `list` alike.

A session with no agent name sends no `agent:` token and so keeps the cross-agent view. That is deliberate: a session that cannot say whose it is should not silently recall less. The Memory page and `/api/memory/*` are a person's view and see everything.

**Session summaries belong to the session's agent** when it's known: the one named agent whose model calls the session recorded (`sessionAgent(db, sessionId)`, read from `token_usage`). The session summarizer and the summary written before `DELETE /api/sessions/:id` both pass it. A session no named agent ran, or more than one did, gets an unowned summary, and summaries written before this stay unowned.

**Facts stay shared.** The `facts` table has no `agent` column — the authoring agent is recorded only as free-text `source` — and that's on purpose: a fact is about the world (a birthday, a tyre size), and every agent should get the same answer. If an agent's finding should reach others, it writes a fact or a doc; nothing leaks through recall.

Why it matters: any agent with `recall` or `injectMemory` used to read every other agent's notes and narrate them as its own recollection. Pinned notes were the expensive case, since those inject regardless of relevance and so landed in every agent's prompt on every turn. The symptom reads as a persona bug and is very hard to trace back to scoping. If your agents relied on reading each other's notes, have them write facts instead, or leave the note unowned by writing it from an unnamed session or the Memory page.

## Session summarization

- `packages/core/src/agent/summarize-session.ts` — `summarizeSession(db, sessionId, provider, model, opts)` writes a note tagged `session-summary` capturing the transcript. Idempotent (skipped if a summary already exists, archived ones included; `force: true` overrides). Importance scales with message count + tool calls. Default TTL 30 days. `opts.agent` makes it that agent's note; the default is unowned.
- `sweepIdleSessions(db, provider, model, opts)` — batch helper finds sessions where `updated_at <= now - idleMinutes` and runs `summarizeSession` on each. Supports `keyPrefixes` to target specific session kinds (e.g. `["autopilot:", "cron:"]`), and `agentFor: (id) => sessionAgent(db, id)` to give each summary to the agent that ran its session.
- `deleteSession(db, sessionId)` — removes the session row + all its messages.
- HTTP: `DELETE /api/sessions/:id` summarizes (unless `?summarize=0`), as the session's agent, then deletes. Pass `?force=1` to re-summarize.

### `builtin:session-summarizer` plugin (cross-channel continuity, opt-in)

Sessions are hermetic per-channel silos (`discord:<user>`, `web:<key>`). Out of the box nothing summarizes an idle session, so a new session on a different channel starts cold — the agent has no idea what it just discussed elsewhere. This plugin closes that gap.

It ships **installed but disabled** (`DEFAULT_DISABLED_PLUGIN_MODULES` in `config.ts`). It autonomously calls the LLM and writes memory, so it's opt-in: enable it deliberately. No behavior change for anyone who leaves it off.

On a timer it sweeps idle sessions (`sweepIdleSessions`), then refreshes the `recent_summary` **core-memory** section — the always-injected identity layer keyed by `(agent, project_id)`, read on every turn (`agent/loop.ts`). `recent_summary` is what carries continuity: the next session on any channel sees a compact "here's what recently happened" block. The section is composed from the most recent summaries (newest first) and hard-capped (~600 bytes) so the always-injected layer stays small for local models. The section is keyed by the `default` agent (the same fallback the loop uses for anonymous chat) plus the session's `project_id`, and composed from the `default` agent's summaries and unowned ones only. Each summary the plugin writes belongs to the agent that ran the session, so another named agent's conversations stay out of it.

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
- `runMemorySweep(db, opts)` — daily hygiene pass: extends TTL on referenced-but-expiring notes (`ref_count >= 3`, ttl ≤ now+1d → +7 days), then archives expired low-importance notes that aren't kept. Returns `{archivedExpired, extendedTtl, remainingNotes, totalChunks}`; `remainingNotes` counts live notes and `totalChunks` the chunks that can still surface. (It used to delete, and report `deletedExpired`.)
- A promoted note that expires is archived like any other, and its chunks go with it. Mark it `keep` if it should stay.
- AutopilotWorker schedules the sweep from `autopilot.memorySweepCron` (default daily at 03:14, via croner). Started/stopped with the worker.

## HTTP & UI

HTTP API (M7) — under `/api/memory/`:
- `GET /notes?project=&tag=&search=&limit=&includeArchived=1` — list live (non-expired) notes. With no `project`, every project's notes plus global ones; `project=global` for global only; a project id for that project plus global. (No `project` used to return global notes only.)
- `GET /notes/:id` — single note, archived or not; an archived one carries `archived_at`, `archived_by`, `archive_reason`
- `POST /notes/:id/archive` (body: `{ reason?: string }`) / `POST /notes/:id/unarchive` — hide or restore; stamped `archived_by: "owner"`. `501` when the memory backend can't archive
- `DELETE /notes/:id` — delete for good, with the note's chunks
- `POST /notes/:id/promote` (body: `{ force?: boolean }`) — manual semantic promotion; `409` for an archived note
- `GET /recall?q=&project=&tier=&limit=&includeArchived=1` — ranked search, formatted output included
- `GET /stats?project=` — `{ counts, topReferenced, embeddingsEnabled, embeddingModel }`; counts are of live records, with `archivedNotes` and `archivedFacts` beside them
- `POST /sweep` — runs `runMemorySweep` on demand

Facts, under `/api/facts`: `GET ?includeArchived=1` lists archived facts too; `POST /:id/archive` (body `{ reason? }`) and `POST /:id/unarchive`; `DELETE /:id` stays a delete.

UI (M7): `#/memory` page with stats tiles, recall search, most-referenced panel, full note list with pin, archive and delete actions, and the facts list with archive and delete. "Show archived" lists archived notes (in their own section) and facts, each marked with when, by whom and why, with Restore in place of Archive. Dashboard gains a `Memory` section showing the same stats + top-referenced links to `#/memory`. See `packages/ui/src/pages/Memory.tsx`.

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
