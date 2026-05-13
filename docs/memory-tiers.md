# Tiered Memory — Design

Status: **design only**, not yet implemented. Tracking task: `ptask_memory_tiers`.
Blocks `ptask_always_on_agents`.

## Why

Today's memory surface is functional but flat:

- **`memory` tool** — markdown files in three scopes (global, agent profile,
  knowledge base). list / read / write / append / case-insensitive substring
  search. Every loaded context file goes into the system prompt eagerly.
- **`facts` tool** — `facts` SQLite table. Structured `(category, entity, key) → value`
  with asof / source / confidence. Project-scoped.
- **History compaction** — `trimHistory()` drops oldest messages; opt-in
  `trimHistoryWithSummary()` replaces the dropped chunk with an LLM summary,
  cached per-loop. Nothing persists past the session.

The gap: agents have no persistent learning across runs. Every cron tick,
autopilot claim, or chat reload starts from the same hand-curated context
files. A bean filed at 10am is not visible to an agent run at 10pm unless
someone added it to a context file by hand. There's no shared scratchpad
inside a single loop, and no way to surface "the relevant 3 things" out
of a 50-file knowledge base without grep.

## Three tiers

```
┌───────────────────────────────────────────────────────────────────────────┐
│  WORKING            Per-loop scratch. Evicted at end of run.              │
│  (~1k tokens)       Holds: agent-authored notes for this turn,            │
│                     intermediate tool outputs the agent wants to keep,    │
│                     plan stubs. Not persisted.                            │
├───────────────────────────────────────────────────────────────────────────┤
│  SHORT-TERM         Per-session/per-project rolling notes.                │
│  (~10k tokens       Holds: end-of-session summary, recent decisions,      │
│   per session)      half-baked observations. TTL-bounded.                 │
│                     Auto-summarized when over budget.                     │
├───────────────────────────────────────────────────────────────────────────┤
│  LONG-TERM          Durable cross-session knowledge.                      │
│  (unbounded,        Holds: facts (structured), document chunks (prose,    │
│   retrieved by      embedded), and the existing KB files.                 │
│   relevance)        Loaded lazily via semantic + keyword search, not      │
│                     bulk-injected into prompts.                           │
└───────────────────────────────────────────────────────────────────────────┘
```

Each tier maps to a clear caller intent:

| Intent                                      | Tier         | Today's surface  |
|---------------------------------------------|--------------|------------------|
| "Remember this until I finish this round."  | working      | (none)           |
| "I learned something about this session."   | short-term   | (none)           |
| "Alice's birthday is March 12."             | long-term    | `facts`          |
| "The auth migration uses approach X."       | long-term    | KB / context md  |
| "Find what we said about caching."          | long-term    | `memory search`  |

## Storage

| Tier        | Backing store                        | Lifetime               |
|-------------|--------------------------------------|------------------------|
| working     | In-process `Map` keyed by sessionId  | until loop ends        |
| short-term  | `notes` table (new)                  | TTL or session-bounded |
| long-term   | `facts` (today) + `memory_chunks`    | until forgotten        |
|             | (new) + KB filesystem (today)        |                        |

### New `notes` table

```sql
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,        -- note_<uuid8>
  session_id  TEXT,                    -- nullable: agent-level notes have no session
  project_id  TEXT,                    -- null = global
  agent       TEXT,                    -- author agent name (denormalized for filter)
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  importance  REAL,                    -- 0..1; influences promotion + retention
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ttl_at      TEXT                     -- absolute expiry; null = no auto-evict
);
CREATE INDEX idx_notes_session ON notes(session_id, created_at);
CREATE INDEX idx_notes_project ON notes(project_id, created_at);
```

### New `memory_chunks` table (long-term prose)

```sql
CREATE TABLE memory_chunks (
  id          TEXT PRIMARY KEY,        -- mc_<uuid8>
  project_id  TEXT,                    -- null = global
  source      TEXT NOT NULL,           -- e.g. "session:abc", "note:def", "kb:notes.md"
  content     TEXT NOT NULL,
  embedding   BLOB,                    -- f32[] (provider-native dim)
  embed_model TEXT,                    -- "openai-text-embedding-3-small" etc
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chunks_project ON memory_chunks(project_id);
CREATE INDEX idx_chunks_source ON memory_chunks(source);
```

Embeddings stored as raw `Float32Array` in BLOB. Cosine similarity computed
in JS (acceptable up to ~10k chunks; ~1ms per 1k vectors at 1536d on a
modern laptop). When that ceiling is hit, swap in `sqlite-vss` or move to
LanceDB — interface stays the same.

Schema migration is additive — existing `facts` + KB filesystem are
untouched.

## Retrieval surface

### Open question (from the bean): one tool with tier param, or three tools?

**Decision: one unified `recall` tool**, plus the existing `facts` and `memory`
tools kept as-is for structured writes and KB management.

Reasoning:
- LLMs (especially local ones, per CLAUDE.md) struggle with large tool sets.
  Three tiered tools is three slots in the agent's tool list that all answer
  "where did I put that thing?".
- Most retrieval is "what do I know about X?" — the agent shouldn't have to
  pre-decide which tier to ask. The tool ranks across all three.
- Writes are tier-shaped: `facts` for atoms, `notes` action on `recall` for
  prose, `memory` for filesystem KB. Writes stay tier-specific.

### `recall` tool

```yaml
recall:
  description: "Search across notes, facts, and knowledge for content relevant to a query."
  parameters:
    query: { type: string, required: true }
    tier:  { type: string, enum: [any, short, long], default: any }
    limit: { type: number, default: 5 }
    scope: { type: string, enum: [project, agent, global], default: project }
```

Returns a ranked list of hits, each tagged with its tier and source. The
agent calls `recall` once per topic instead of grepping three places.

Implementation: union the tier sources by relevance score. Score = max of:
- `facts` exact / substring match on category|entity|key|value
- `notes` substring match
- `memory_chunks` cosine similarity

Top-K from the union after normalizing scores. Cheap rerank; no LLM call
in the hot path.

### Write surface

Notes get a dedicated lightweight action — small enough to keep on the
`recall` tool rather than a new tool:

```yaml
recall:
  action: note
  content: "..."
  tags: ["..."]
  importance: 0.7
  ttl_days: 14
```

`facts` and `memory` stay as today — structured writes go through `facts`,
durable docs through `memory write scope=knowledge`. The `recall` tool is
the read/notes surface.

## Promotion path

Open question: "agent decides, or rule-based?" Answer: **both**, layered.

### Automatic
- High-confidence facts (`confidence >= 0.9`) are durable by definition;
  no promotion needed.
- A note referenced (i.e. surfaced in a `recall` result the agent acted
  on) `n >= 3` times across sessions gets cloned into `memory_chunks` so
  semantic search finds it.
- End-of-session summarization (see Loop integration) writes a single
  short-term note. Notes older than their `ttl_at` are swept by a daily
  cron job; high-importance / referenced notes get extended TTL on hit.

### Explicit
- `recall` action `promote` takes a note ID and writes it into
  `memory_chunks` (embedding generated at promotion time).
- `facts` is the explicit promotion path for anything K/V-shaped.

Cleanup sweep:
- Daily cron deletes `notes` past `ttl_at` unless `importance >= 0.8`.
- `memory_chunks` are never auto-deleted (agent can `recall forget id=...`).

## Compatibility with existing surfaces

| Existing             | Role going forward                                          |
|----------------------|-------------------------------------------------------------|
| `facts` tool         | **Structured-write surface**, unchanged. Reads also through `recall`. |
| `memory` tool        | **Filesystem KB management** (list / read / write / append on .md files in `kbDir`). Drop the substring-search action; redirect to `recall`. |
| KB files (`data/kb`) | **Long-term, indexed.** Background job chunks + embeds each KB file into `memory_chunks` on add/change (watch via S8 KB registry). |
| Context files        | **Long-term, indexed**, same as KB but treated as "always pinned" — top-of-prompt inject continues for static-instructions style files (`goals.md` etc) since those are tiny and intentional. |
| `trimHistoryWithSummary` | **Short-term writer.** On session end (or compaction event), the summary lands as a `note` instead of being thrown away. |

Net effect: existing data keeps working unchanged; the new tiers are
additive and lazily populated. A user with no KB and no facts loses
nothing.

## Loop integration

Three new hooks on the agent loop:

1. **Pre-loop injection.** Before `runAgentLoop` builds the prompt, call
   `recall({ query: userMessage, limit: K, scope: project })` and inject
   results into the system prompt under a `[Relevant memory]` header,
   capped at `agent.memoryInjectBudget` tokens (default 800). Replaces
   today's blunt "concat every context file" behavior.

2. **Working memory.** New `AgentLoopOptions.workingMemory: Map<string,string>`
   threaded through `ToolContext`. Tools can stash arbitrary keys during
   a loop iteration; cleared in the `finally` block of `runAgentLoop`.
   First consumer: the `delegate` tool stashing parent context for the
   child to inherit selectively.

3. **End-of-session summarization.** When a session is closed (via API
   `DELETE /api/sessions/:id`, or after N minutes of inactivity for
   autopilot/cron), run `summarizeMessages()` over the full transcript
   and write the result as a `note` with `session_id` set and
   `importance` proportional to message count + tool usage. The note
   captures decisions / open threads without retaining every message.

This is the path that gives `always_on_agents` a way to learn: an
autonomous exploratory worker writes notes during its run; the next
worker tick recalls them.

## Scopes

| Scope     | Default for       | When to override                              |
|-----------|-------------------|-----------------------------------------------|
| `project` | All tiers         | Default for everything. Matches today's `facts`. |
| `agent`   | Working only      | Sub-agents (via `delegate`) that should not share notes back with the parent. |
| `global`  | Long-term opt-in  | Cross-project facts ("my birthday", "the office network is X"). Today's `global` `memory` scope continues to map here. |

`project_id` on `notes` and `memory_chunks` matches the column already
on `facts` — nullable, where null means "global". The runtime's active
project (S7) is the default at write time.

## Embedding provider

- New `EmbeddingProvider` interface in `packages/core/src/providers/`
  alongside `AIProvider`. Implementations:
  - `OpenAICompatibleEmbeddingProvider` — calls `/v1/embeddings` (works
    for vLLM, Ollama, LM Studio, hosted OpenAI). Default.
  - `LocalEmbeddingProvider` — wraps `@xenova/transformers` for an offline
    fallback. Heavier dep; gated behind `embeddings.provider: local`.
- Config:
  ```yaml
  memory:
    embeddings:
      provider: openai_compatible   # or "local" or "none"
      model: text-embedding-3-small
      dim: 1536
    notes:
      defaultTtlDays: 14
      injectBudgetTokens: 800
    chunks:
      maxChunkChars: 1500
      overlap: 100
  ```
- `provider: none` is valid — disables semantic search; `recall` falls
  back to keyword-only. Important for users with no embedding endpoint.

## Slice plan (implementation order, for later filing)

Each is intentionally a few-day slice; none is a one-shot.

1. **M1 — schema + writes**
   - Add `notes` and `memory_chunks` tables.
   - `recall` tool with `action: note` + `action: forget` only.
   - No retrieval yet.
   - Wire `recall` into builtins + factories.

2. **M2 — keyword retrieval**
   - `recall` query implementation across notes + facts (no embeddings).
   - Score normalization across sources.
   - Return ranked results.

3. **M3 — loop injection**
   - Pre-loop `recall` call in `runAgentLoop`.
   - `[Relevant memory]` block in system prompt, capped.
   - Working memory map on `ToolContext`.

4. **M4 — end-of-session summarization → notes**
   - Hook on session close to write summary as a note.
   - Idle-timeout close for autopilot/cron sessions.

5. **M5 — embeddings + chunks**
   - `EmbeddingProvider` interface + OpenAI-compatible impl.
   - Background indexer: watch KB + new notes, write chunks.
   - `recall` semantic search path; score-merged with keyword.

6. **M6 — promotion + sweep**
   - Reference-count tracking on notes.
   - Auto-promote at threshold.
   - Daily TTL sweep cron job.
   - `recall action: promote`.

7. **M7 — observability + UI**
   - `GET /api/memory` endpoints (list / search / forget).
   - Dashboard panel: most-recalled notes, recent summaries.
   - Per-session "memory used this turn" affordance in chat.

## Risks / open items

- **Embedding cost.** Indexing a large KB on startup is non-trivial. Mitigation:
  index lazily on first `recall`, persist embeddings, skip unchanged files.
- **Stale notes pollute retrieval.** Daily TTL sweep + low default
  importance should keep this bounded; revisit after M5 in real usage.
- **Multi-agent contention on the same project.** Notes from agent A might
  confuse agent B. Tag notes with `agent`; `recall` defaults to "any agent"
  but can filter. Not a blocker but worth marking.
- **No reranking model in M5.** Score blending across keyword + semantic
  is a heuristic. If results are noisy, M7 can add a cheap LLM rerank pass.
- **Sub-agent isolation** (`scope: agent`) requires a parent-child note
  visibility rule that doesn't exist today. Likely a small `notes.parent_agent`
  column added in M3.

## What this enables (next bean)

`ptask_always_on_agents` consumes this design: an exploratory worker
agent writes observations as notes, recalls them on the next tick, and
periodically promotes recurring observations into facts. Without the
short-term tier it would have no memory between ticks. With it, the
"online" mode becomes a closed loop instead of an amnesiac one.
