---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/ui": patch
---

Archive notes and facts instead of losing them, and keep each agent's notes its own.

**`recall action="archive"` used to mean "keep", and it never worked.** It set
a flag nothing read, so a note an agent "archived" to keep forever was swept
like any other. Now `archive` hides a note (with an optional `reason`),
`unarchive` brings it back, and `keep` takes the old meaning: a kept note is
never swept, and the sweep honours it. If a prompt of yours tells an agent to
`archive` notes it wants to keep, change it to `keep`. If it uses `archive` to
retire notes, it now does what you meant.

**What agents forget can be restored.** `recall action="forget"` and `facts
action="forget"` archive instead of delete, and say so. Setting a forgotten
fact's key again restores it with the new value. With a memory backend plugin
that can't archive, `forget` still deletes, and says the delete was for good.

**The nightly sweep archives instead of deleting.** Expired, low-importance
notes are archived with `archived_by: "sweep"` and reason `expired`. Its report
is now `{ archivedExpired, extendedTtl, remainingNotes, totalChunks }`
(`deletedExpired` is gone), and `remainingNotes` / `totalChunks` count only
what agents can still see.

**Archived memory is hidden everywhere it used to load:** prompt injection
(pinned and relevant), `recall` `query` and `list`, semantic search, the
`facts` tool's `list` and `search`, the briefing, the session summarizer, an
exploratory agent's tick notes, auto-promotion and the HTTP lists and counts.
`includeArchived` brings it back, marked with when, by whom and why. A chunk
promoted from a note follows the note, so archiving a note hides what was
promoted from it, and a chunk whose note was deleted no longer surfaces.

**A person's delete stays a delete**, and deleting a note now deletes its
search chunks too.

HTTP: `?includeArchived=1` on `GET /api/memory/notes`, `/api/memory/recall`
and `/api/facts`; `POST /api/memory/notes/:id/archive` (body `{ reason? }`) and
`/unarchive`, and the same for `/api/facts/:id`. `GET /api/memory/notes` with
no `project` now lists every project's notes, as its comment always said; it
used to return global notes only. `/api/memory/stats` adds `archivedNotes` and
`archivedFacts`.

The Memory page gets a "Show archived" toggle, Archive and Restore beside
Delete for notes and facts, and archived rows marked with when and why.

For memory backend authors: `MemoryBackend` gains optional `archive(id, { by,
reason })` and `unarchive(id)`, `QueryContext` and `ListQuery` gain
`includeArchived`, archived fragments carry `metadata.archived_at`, and
`ListQuery.scope` accepts `project:*` for every project. A backend that ignores
all of it keeps working. See `docs/memory-storage-registry.md`.

**Agents no longer read each other's notes.** The `recall` tool's `query` and
`list` now return the calling agent's own notes plus unowned ones, the scope
prompt injection already used, and semantic search follows each chunk's
source note, so promoting a note doesn't make it public. If your agents relied
on reading each other's notes, have them write facts instead (facts stay
shared), or write the note unowned. A session with no agent name, and the
Memory page, still see everything.

`recall` now defaults to the session's active project, as its `project_id`
description always said; it used to fall back to global. Notes written in a
project session land in that project.

Session summaries belong to the agent that ran the session, when one named
agent did: the session summarizer and the summary written before
`DELETE /api/sessions/:id` both pass it (`sessionAgent(db, sessionId)`). Older
summaries stay unowned. The summarizer's `recent_summary` for the `default`
agent is composed from its own summaries and unowned ones only.
