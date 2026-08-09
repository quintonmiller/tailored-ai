---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Describe TAI as model-agnostic rather than local-first

The package descriptions and the core README said "optimized for local LLMs",
which is the positioning npm shows on the package page and which stopped being
true a while ago: core ships an OpenAI-compatible client that talks to a local
server or a hosted one with equal footing, and OpenAI, Anthropic, OpenRouter,
Bedrock and DeepSeek are all first-class provider plugins. The reference
deployment runs a hosted model by choice.

Local support is unchanged and still first-class — it is no longer stated as
the framework's identity. The `local-llm`, `ollama` and `vllm` keywords stay,
because those are discovery tags for a capability TAI really has.
