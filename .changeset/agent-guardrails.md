---
"@tailored-ai/core": patch
---

Guardrails: a mechanical check an agent's room post has to pass.

Instructions are advice, and a busy prompt dilutes them — an agent told plainly
to keep a certain kind of reply short will still write four paragraphs. A
guardrail is what you reach for once you know the rule, the rule is mechanical,
and telling the agent has already failed.

A failing message is not delivered. The reason is handed back as the turn's
correction round, so the agent gets one attempt to say the thing properly,
rather than the message being silently swallowed and the turn lost.

- `guardrails: [{ use, surfaces?, options? }]` on an agent — an open selector
  and an opaque options bag, so a plugin's guardrail validates exactly as well
  as a built-in one.
- Core ships one domain-free guardrail, `text`: `when`, `maxChars`, `maxWords`,
  `deny`, `limit`, `caseSensitive`. `when` is what makes the caps usable — a
  blanket length cap is nearly always wrong, but one scoped to a kind of
  message is not.
- `registerGuardrail` for plugins; `check` may be async.
- Checked on every way an agent posts to a room. A direct reply in a channel
  conversation, the web UI or the CLI is not checked yet.
- Fails open. Unlike hooks, nothing downstream depends on a guardrail having
  run, and an agent silenced by a bug in a quality check is worse than the
  drift it was watching for.
