---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

World state: typed records agents, people and plugins share.

Agents coordinated through transcripts, and the structured data that existed
was scattered across fixed tables nothing announced changes to. World state is
one layer for it:

- `state.types` declares a type: a JSON Schema checked on every write, a default
  scope, a title field, and who may read and write it.
- Agents get one tool, `state` (types, get, query, put, patch, delete), offered
  only once a type exists. A failed write comes back as a correction naming the
  field.
- Every record carries a scope (`global`, `agent:`, `room:`, `project:`), a
  version, and who changed it through what. An agent sees its own scope, its
  rooms, the project and global; deletes are tombstones that history keeps.
- Every change emits `state.changed`, so `hooks.on` and plugins can react.
- The store is replaceable: `state.backend` selects a registered provider (the
  built-in `sqlite` registers like any plugin), and a single type can name its
  own. Plugins register providers and types through `ctx.stateProviders` and
  `ctx.stateTypes`.
- `GET /api/state/types`, `/api/state/:type`, `/:type/:id` and `/:type/:id/history`.
