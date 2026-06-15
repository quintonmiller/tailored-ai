---
"@tailored-ai/core": patch
---

Strip orphaned `tool` messages from trimmed history so strict providers don't
400. Front-trimming (and the summarize-on-trim path) could leave a `role: "tool"`
result whose `assistant` + `tool_calls` parent was dropped. Lenient providers
(vLLM/qwen) ignore it, but OpenAI / Anthropic / Bedrock / DeepSeek reject it with
"Messages with role 'tool' must be a response to a preceding message with
'tool_calls'". `trimHistory`/`trimHistoryWithSummary` now run a
`stripOrphanedToolMessages` pass (exported) that keeps a tool message only when a
preceding assistant turn opened a matching `tool_call` id.
