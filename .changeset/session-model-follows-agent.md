---
"@tailored-ai/core": patch
---

Send the agent's model, not the one stamped on its session.

The loop sends `session.model`. Every server route creates the session before
it knows which agent will handle the turn —
`findOrCreateSession(db, key, runtime.getModel(), config.agent.defaultProvider)`
— so the row carries the deployment defaults. The runtime's own paths resolve
the agent first and were unaffected, which is why this only ever showed up
through the HTTP API.

Harmless while every agent shared one provider. The moment an agent could
select its own, it became a mismatch in the worst direction: the request went
to the agent's provider carrying the *global* model name, so a correctly
configured agent failed with `qwen3.6-27b-vllm is not a valid model ID` from
OpenRouter.

`buildLoopOptions` now reconciles the session against the resolved agent — the
single place that knows both — and updates the row so the transcript records
the model that actually answered.
