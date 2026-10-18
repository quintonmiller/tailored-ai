---
"@tailored-ai/server": patch
---

World state gets its UI half: a **State** page in the web UI to browse types and records, read a record's history, and edit or delete it, updating live as agents change things. The server adds `GET /api/state/events` (a server-sent stream of every `state.changed`, which keeps flowing across config reloads) and write routes: `POST /api/state/:type`, `PUT` and `PATCH /api/state/:type/:id` with an optional `expectedVersion`, and `DELETE`. A conflicting write answers `409`.
