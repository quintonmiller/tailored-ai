---
"@tailored-ai/core": patch
---

Tolerate an agent's `tools` / `skills` written as a JSON string.

An agent that creates another agent writes JSON, because that is what models
emit — `tools: '["read", "memory"]'`. A string is iterable, so nothing rejected
it and `resolveAgent` walked it character by character, failing with
`unknown tool "["`. The agent looked created, passed every check, and only broke
the first time something tried to invoke it.

`loadConfig` now parses a JSON-array string into a real list (and says so), and
`validateConfig` reports any `agents.<name>.tools` that still isn't a list, by
name, at startup rather than at first use.
