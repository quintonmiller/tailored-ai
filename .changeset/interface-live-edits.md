---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Posted interface components now stay current. Discord remembers each message it posted a component as, and edits it when the component changes: an agent's `update` redraws the message instead of posting a copy, an answer given anywhere shows on every copy, a close shows "Closed", and a bound card follows its record (a burst of changes becomes one edit). The web UI redraws components already on screen through the new `GET /api/interfaces/events` stream. The interface store gains `onChange`, `addPost`/`posts` and `boundTo`.
