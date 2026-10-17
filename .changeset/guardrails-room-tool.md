---
"@tailored-ai/core": patch
---

Apply an agent's guardrails to a message it posts through the room tool.

Guardrails were checked on the reply an agent returns from its turn, which the
room watcher posts on its behalf. An agent that posts by calling the room tool
instead — the only way to address someone with `to` — sent text that never
passed through that check, so a deployment whose agents post that way had
guardrails that parsed, resolved, and never ran.

The tool now refuses such a post as a tool failure rather than dropping it: the
agent is still mid-turn there and can say it again within the rule, which is
what a guardrail is for.

Two smaller fixes alongside it:

- A guardrail that fires and is then satisfied on the retry now logs a line.
  Only the still-failing drop logged before, so "no guardrail lines in the log"
  equally meant "no guardrail ever fired" and "every firing was corrected",
  with no way to tell which.
- `deliverReply` no longer judges trailing prose that nothing was going to
  send. An agent that already posted through the tool, or that passed, still
  returns text; checking it there logged "did not pass its guardrails, so it
  was not posted" about a message that was never going to be posted, and named
  a correction round that had not happened.
