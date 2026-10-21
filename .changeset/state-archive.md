---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/ui": patch
---

World state: archive a record instead of deleting it.

An archived record keeps its data and history, but everything that lists or
loads records leaves it out: `state` tool queries, pinned state, lists and
tables on interfaces, the 3D world, and the State page. Fetching it by id
still works and says it is archived, when, by whom and why. `unarchive`
brings it back.

- The `state` tool gains `archive` (with an optional `reason`) and
  `unarchive`, and `includeArchived` on `query`. Its `delete` stays a delete.
- HTTP: `POST /api/state/:type/:id/archive` (`{reason?, expectedVersion?}`)
  and `/unarchive`, `409` on a version mismatch; `GET /api/state/:type?includeArchived=1`.
- The State page has a **Show archived** toggle, **Archive** and **Restore**,
  and marks archived rows with when, who and why.
- A card bound to an archived record says so in its first line.
- The 3D world draws an archived room, model, body or whereabouts record as
  gone until it is restored. An agent's home room is the exception: an agent
  always has one.

What changes for existing code:

- `StateService.get` (and `GET /api/state/:type/:id`) now returns an
  archived record too, with `archivedAt` set. Code that reads a record by id
  and treats it as current should check `archivedAt`, as the built-in places
  plugin does; `query` already leaves archived records out.
- A `patch` to an archived record is refused with a message that says to
  unarchive it first. A `put` replaces it and brings it back.
- Archiving is announced as `state.changed` with `op: "update"`, so existing
  hooks and subscribers keep working; the new `lifecycle` field
  (`"archived"` or `"unarchived"`) tells them apart. A consumer that keeps
  its own copy of a type's live records must drop a record on
  `lifecycle: "archived"` and add it back on `"unarchived"`; otherwise an
  archive looks like an edit.
- Provider contract: `StateRecord` gains `archivedAt`, `archivedBy` and
  `archiveReason`; `StateQuery` gains `includeArchived`; `StateChange` gains
  `lifecycle` and `archiveReason`; `StateProvider` gains optional `archive`
  and `unarchive`. A provider without them keeps working, and archiving in it
  is refused rather than reported as done. A provider's `put` must write the
  record live: one that comes back archived fails loudly. The built-in SQLite
  and memory providers implement both, and the SQLite provider adds its new
  columns to an existing database on start, reading every older record as
  live.
