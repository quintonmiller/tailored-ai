---
"@tailored-ai/core": patch
---

tasks: `task_query` requires `assignee`, and "unassigned" becomes a real answer

The old default was everyone. That reads as harmless until an agent is asked
what it is working on: it runs the widest query available and reports whatever
comes back. In one deployment the only two `in_progress` rows were the owner's
reading list — a novel and an audiobook, both unassigned — and three agents
claimed them as work in flight. The claim then lived in each agent's own
session, so later status updates repeated it with no tool call at all, and
`REAMDE` drifted into "generating a README in Neal Stephenson's style".

`assignee` now takes `"me"`, `"all"`, `"unassigned"`, an agent name, or a list.
Omitting it is an error that names the options. No default is right — "everyone"
is wrong for an agent reporting on itself and "me" is wrong for a planner
surveying the board — so the caller says which it means. `mine: true` still
works; it is the old spelling of `assignee: "me"`.

`TaskFilter.assignee` gains `null` for "assigned to nobody", distinct from
`undefined` for "no opinion". Conflating them is what made an unowned task look
available, and therefore look like yours. Backends that cannot express the wider
filter natively push down what they can and narrow the result in memory.
