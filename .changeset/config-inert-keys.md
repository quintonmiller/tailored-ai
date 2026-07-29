---
"@tailored-ai/core": patch
---

config: stop agent settings from parsing, persisting, and doing nothing

Three fixes for the same disease — config that looks installed and is never read.

- **`validateConfig` now checks keys inside an agent block**, with a "did you
  mean" for near misses. Only top-level keys were checked (#252), on the grounds
  that nested bags are open — but an agent block is a typed record, not a bag.
  Four agents in one deployment carried their entire persona under
  `system_prompt:` instead of `instructions:`. It parsed, it round-tripped into
  their manifests, and it reached nothing: they ran with an empty instructions
  layer for weeks, and the only symptom was vague answers.
- **`parseAgentData` no longer drops fields it forgot to list.** It copied an
  allowlist while its own docstring promised that unknown fields pass through.
  `fileBoundary`, `roomSessionScope`, `injectMemory`, `budgetWarnings`,
  `thinking` and the memory-injection budgets were all discarded between the
  manifest and the loop. Concretely: three agents holding `write` and `edit` ran
  with a declared filesystem boundary that did nothing, and thirteen agents that
  set `injectMemory: true` never received an injected memory. Known fields now
  pass through; unknown ones warn.
- **The `<context>` layer warns when it gets large.** It is the only uncapped
  part of the system prompt, and nothing truncates it — it comes out of the
  history budget instead, so the symptom is an agent that forgets rather than an
  agent with a big prompt. Warned once per agent per process rather than
  truncated: cutting a context file mid-sentence is a silent loss, and which
  file to drop is not a judgement this code can make.
