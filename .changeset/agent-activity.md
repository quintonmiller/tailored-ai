---
"@tailored-ai/core": patch
---

Each agent with a body now has a live `activity` record: thinking, working with a tool, talking to another agent, waiting on you, stuck, idle or asleep, with a few words for a status line and a prop the page can draw. Kept from the event bus by the new built-in `builtin:activity` plugin, in memory, with tool looks a deployment can extend in plugin config.
