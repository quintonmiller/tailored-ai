---
"@tailored-ai/core": patch
---

Inline images on the OpenAI-compatible provider, so tool-returned media reaches
a model that can see.

The provider declared `toolResultMedia: { supported: true, mode: "follow-up" }`,
and `adaptForCapabilities` honoured it by moving a tool result's image onto a
following user turn — which `toOpenAIMessages` then flattened to a text
placeholder along with everything else. Every layer reported success and no
image ever reached a model on the default provider, the one every local gateway
speaks. A request carrying a 960×720 screenshot billed 244 prompt tokens.

`toOpenAIMessages` now takes the hydrated `ChatParams.media` map and emits
`image_url` parts on user and assistant turns. A `tool` message stays a flat
string, which is not an oversight: vLLM rejects an image part there
(vllm-project/vllm#43203) even for a vision model that accepts the identical
part on a user turn. A ref whose bytes are missing still degrades to its
placeholder, and a text-only request is unchanged.
