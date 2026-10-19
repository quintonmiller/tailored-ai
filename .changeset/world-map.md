---
"@tailored-ai/core": patch
---

`builtin:places` now answers for the whole world: `GET /api/ext/builtin:places/map` lists every agent's home, the shared places and the rooms agents talk in, with who is in each, and `GET /api/ext/builtin:places/scene/:id` shows any of them. A room of conversation is a meeting room with a seat for each member.
