---
"@tailored-ai/core": patch
---

Injected memory is scoped to the agent recalling it.

Auto-injection was scoped by project and global only, so any agent with
`injectMemory` read every other agent's notes and reported them as its own
recollection. Pinned notes were the expensive case: those inject regardless of
relevance, so one agent's pinned preference landed in every agent's prompt on
every turn. The symptom reads as a persona bug and is very hard to trace back to
scoping.

Nothing needed inventing. `scope` on the `MemoryBackend` contract was already
`string | string[]`, the SQLite backend's `parseScope` already understood an
`agent:<name>` token, and `notes` already had an `agent` column with a filter
behind it. The injection path simply never sent one.

An agent now recalls its own notes plus notes nobody claimed. That second half
matters: notes predating authorship, or written by an unnamed session, have a
null `agent`, and a strict match would have hidden every one of them from
everybody — a worse failure than the one being fixed.

A session with no agent name sends no token and keeps the cross-agent view it
had before, so nothing that cannot identify itself silently starts recalling
less.

Facts remain unscoped: the `facts` table has no `agent` column, only a free-text
`source`. That needs a migration and is tracked separately.
