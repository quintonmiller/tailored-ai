---
# autonomous-agent-lfab
title: DUX9 — Pinned-memory tier
status: completed
type: task
priority: high
created_at: 2026-05-14T07:32:47Z
updated_at: 2026-05-14T07:39:06Z
parent: autonomous-agent-p0ae
---

# DUX9 — Pinned-memory tier

Preferences ("always use TypeScript", "skip explanations") should
always inject into the system prompt regardless of relevance, but
without unbounded growth. Add a second injection lane with its own
budget so total context stays capped.

## Convention

- Note tagged `pinned` (or `importance >= 0.95`) → always-inject tier.
- Note tagged `preference` (without `pinned`) → relevance-ranked tier
  with high TTL survival via `importance >= 0.8`.

## Changes

### Query
`packages/core/src/db/note-queries.ts` — `listPinnedNotes(db, opts)`
returns notes tagged `pinned` OR `importance >= 0.95`, ordered by
`importance DESC, ref_count DESC, created_at DESC`, capped at limit.

### Injection
`packages/core/src/agent/memory-inject.ts` — split the block into two
sub-sections, each with own budget:

- `[Pinned preferences]` — pinned notes, default 200-token cap, max 4.
- `[Relevant memory]` — existing relevance ranking, remaining budget.
  Dedupes against pinned so the same note doesn't show twice.

`MemoryInjectResult` gains `pinned: RecallHit[]` field separately.

### Loop / SSE / UI
`onMemoryRecalled` payload extended with `pinned: string[]`. UI's
`RecalledChip` shows pinned count separately. Memory page gets a pin
toggle (PATCH `/api/memory/notes/:id` accepts `tags`/`importance`).

### Agent instructions
Default chat agents get a clause:

> When the user states a durable preference, working style, or
> recurring instruction (e.g. "always X", "from now on", "I prefer Y",
> "first do A before B"), immediately save it with `recall(action:
> "note", content: "<their wording>", tags: ["preference"], importance:
> 0.85)`. For rules that apply globally regardless of topic, also tag
> `"pinned"` and use importance 0.95. Don't save one-off task
> instructions or factual answers — only durable preferences.

## Constraints

- Total inject budget capped at the same `memoryInjectBudgetTokens` (default
  800). Pinned takes from it, not on top.
- Pinned budget defaults to 200 tokens; never exceeds 50% of total.
- Notes that are both pinned and relevant only appear once (pinned slot wins).
