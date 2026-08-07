---
"@tailored-ai/core": patch
---

Use the summariser prompt that actually measured best.

The default shipped in the previous change was the worst of four variants when
run against the 1,432-message history it was written for. Scored on named
specifics and quoted phrasing:

| prompt | chars | names | quoted |
|---|---|---|---|
| "…the people, the specifics, and where things stand" | 1574 | 32 | 3 |
| "…key facts, decisions, and pending tasks" | 1428 | 38 | 3 |
| "in detail." alone | 1420 | 20 | 0 |
| **the shipped default, enumerating what to preserve** | **707** | **1** | 1 |

Enumerating what to keep appears to read as a checklist to satisfy briefly
rather than an invitation to write — the third time a more prescriptive version
of this prompt lost to a plainer one. The new default names a few neutral
categories, which beat naming none, and avoids the work-flavoured nouns that
made a companion's history read like a standup report.
