---
"@tailored-ai/core": patch
---

Say when `maxHistoryTokens` leaves no room for the conversation at all

The history budget is `maxHistoryTokens - systemPrompt - tail - toolSchemas`, and since tool schemas started counting against it the schemas are the dominant term: 24 tools measure ~5,500 tokens, a 41-tool deployment ~10,900. `maxHistoryTokens` defaults to 2,000.

A deployment that never tuned it therefore has a budget of zero: every message is dropped on every turn, and the symptom is an agent that cannot remember what was said a moment ago — indistinguishable, from the outside, from a bad model.

Warns once per agent, naming the three numbers and the floor to clear. Warned rather than silently raised: building a bigger request than the model's context accepts would trade one quiet failure for another, and the right number depends on the model.
