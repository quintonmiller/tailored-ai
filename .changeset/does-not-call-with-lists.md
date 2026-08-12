---
"@tailored-ai/core": patch
---

Benchmark: `does_not_call_with` accepts a list on either side, and the
tool-pressure scenario that used it now measures lookups rather than any
contact with a memory tool.

`does-not-search-memory-for-what-it-was-just-told` asserted
`does_not_call: [recall, facts, memory, core_memory]`, which also forbids
*writing*. The base prompt tells every agent to save durable facts, so an agent
that answered correctly from the conversation and then filed what it learned
scored as a failure for following its instructions. At n=12 the scenario sat at
6/12 and read as a bimodal capability gap; it was one assertion counting two
different acts.

Spelling the lookup-only version one tool/action pair at a time is twenty
entries, so `does_not_call_with` now takes a list for `tool` and for any `where`
value, meaning "any of these".

Re-measured at n=12: 10/12, and both remaining failures are real lookups
(`recall(action=query)`, `facts(action=get)`) rather than saves.
