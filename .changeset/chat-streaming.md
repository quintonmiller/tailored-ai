---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Streaming chat end to end: `ChatStreamEvent` contract (delta/done) replaces the dead `ChatDelta`, `OpenAIProvider` + `AnthropicProvider` implement `chatStream`, the agent loop streams to a new `onTextDelta` sink (falling back to blocking `chat()`), and `POST /api/chat` emits SSE `delta` events the bundled UI renders live.
