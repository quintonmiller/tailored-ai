---
"@tailored-ai/core": patch
---

A new interface kind, `list`: the world-state records a query matches, as a checklist that stays current. An agent sends it once with `bind: {type, where?, limit?}`; with `check: {field, on?, off?}`, ticking an item flips that field on the record as the person who ticked, with no model turn. It shows only what the agent could read, oldest first so a tick never moves an item, and redraws in the web UI and on Discord whenever a record of its type changes. Discord draws one ☑/☐ button per item (up to 20). Also: a click on an expired component now finishes its Discord message.
