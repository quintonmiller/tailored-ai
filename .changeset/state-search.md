---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

World state: find records by what they say.

A type opts in by naming the fields that say what a record is about:
`search: { fields: [title, summary, updates.text] }`. Agents and people can
then search it by meaning when embeddings are on (`memory.embeddings`, the
same embedder `recall` uses), and by words when they aren't. A search shows
exactly what a `query` would show the same caller: types it can read, scopes
it can see, and archived records only when asked.

- The `state` tool gains `search`: `text`, and optionally `type` (one,
  several comma-separated, or none for every searchable type). It answers
  one line per record, closest first, saying how each matched and when and
  by whom it last changed. Its `types` action lists the fields each type is
  searchable by.
- HTTP: `GET /api/state/search?q=&types=a,b&scope=&limit=&includeArchived=1`,
  as a person, who sees every scope.
- In code: `StateService.search(caller, { text, types?, scope?, limit?, includeArchived? })`
  returns `{ record, score, how: "meaning" | "words" }[]`, default 8.

What a deployment will notice:

- Nothing, until a type sets `search`. Types without it are never indexed or
  searched.
- With embeddings on and a searchable type, TAI embeds each searchable
  record in the background: on every write whose searched text changed, and
  at start and after each reload for records that have no current vector
  (all of them, after the embedding model changes). That is an embedding
  call per 16 records, at most one a second. A write never waits for it,
  and a failing embedder never fails a write: the record is found by words
  until its vector exists.
- The runtime database gains a `state_search` table (type and id, scope,
  embed model, vector, and a hash of the indexed text). It is created on
  start; existing records are indexed by the background backfill, with
  nothing to run. It never decides what anyone sees: search reads its
  candidates through the store, scoped as a query is, and takes only their
  vectors from the table, so it works with any state provider.
- A type named `search` can't be listed over HTTP, as with `types` and
  `events`.

Contract: `StateTypeDef` gains optional `search: { fields: string[] }`
(settable in `state.types` config, with warnings for an empty list or a
field the schema doesn't have). `StateService` gains `search`,
`backfillSearch` and `whenIndexed`, and `StateServiceOptions` gains
`getEmbedder`, which the runtime passes. The `StateProvider` contract is
unchanged.
