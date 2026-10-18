---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Interface cards can now show a world-state record and change it. A card sent with `bind: {type, id}` shows the record (its title field as the title, the rest as lines), read as the agent so it can only show what the agent could read. A card button with `effect: "state"` and a `patch` writes to the record as the person who clicked, with no model turn, and the card stays open for the next click. In the web UI a bound card follows its record live; on Discord a click redraws it. `respondToComponent` is now async and takes the state service for state buttons; `POST /api/interfaces/:id/respond` can answer `{effect: "state", record}`.
