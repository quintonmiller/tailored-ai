---
"@tailored-ai/core": patch
---

collections: add an agent-writable `collections` tool and open the `type` to a free,
normalized label (was a hard-coded enum). An agent can now `add`/`list`/`stats`/`remove`
collection items (restaurants, books, board games, …) and surface them on the Board with
a config-only `list`/`collections` widget — no new endpoint or renderer. `getCollectionStats`
now returns a generic `{ byType, total }` shape, and a guarded migration rebuilds older
DBs that still carry the legacy `CHECK(type IN …)` constraint, preserving rows.
