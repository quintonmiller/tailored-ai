---
"@tailored-ai/core": patch
"@tailored-ai/ui": patch
---

World state records can say which agent a plugin wrote them for. A plugin that
writes for an agent through a caller with more reach than the agent's (so the
plugin stays the actor and its access applies) can set `source.onBehalfOf` to
the agent's name. Subscriptions then treat the change as that agent's own, so
`includeOwn: false` (the default) no longer wakes an agent for a change a
plugin made at its request. Event lines, the `state` tool and the State page
name the agent: "commitment/x updated by plugin directory for planner".

Nothing changes for existing records or writers that don't set it, and a
store that drops the field only loses the naming.
