---
"@tailored-ai/core": patch
---

Make `models[]` the fallback chain its docstring always claimed it was.

`AgentDefinition.models[]` and `agent.models[]` were documented as an "ordered
priority list of provider+model combinations, first available is used" and read
by nothing except the `/context` window display. An operator could configure a
local-then-cloud chain, watch it validate and round-trip through the UI, and get
no failover at all — with no request-time failover anywhere else in core either,
a provider outage simply failed the turn.

The chain is now resolved (`resolveAgent` returns `models`, always non-empty) and
walked at call time (`chatWithFallback`). Each rung gets one attempt and any
throw advances to the next; the last rung keeps the transient retry, so a
deployment that declares no `models[]` gets a one-entry chain and behaves exactly
as before. Rungs whose provider cannot be built — the plugin is not installed —
are dropped with a one-time warning rather than taking the agent down, and the
chain is rebuilt every loop iteration so a reload takes effect mid-run.

Precedence is most-specific-first: an agent's own `models[]`, then its
`model`/`provider` pin, then `agent.models[]`, then the deployment default. A pin
does *not* opt an agent into the deployment chain, and a per-call model override
never falls back — both exist to send one call somewhere specific, and silently
answering from elsewhere would undo them.

Also: `runtime.tryBuildProvider` splits provider construction from the
degrade-to-default policy, so a chain rung can be skipped where a declared
provider still falls back.
