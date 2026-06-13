# Agent Loop & Providers

How the loop trims history, validates tool args, retries transient errors, and which providers are wired up.

## History Compaction

The agent loop trims conversation history before each LLM call to stay within `config.agent.maxHistoryTokens` (default 2000). Token count is estimated at ~4 chars per token. Trimming drops the oldest messages first, but always skips past orphaned `tool` messages so tool-call/response groups stay intact. See `estimateTokens()` and `trimHistory()` in `packages/core/src/agent/loop.ts`.

Opt-in summarization: set `summarizeOnTrim: true` in an agent to replace silent trimming with a summary. When enabled, `trimHistoryWithSummary()` calls the LLM to summarize dropped messages into a `[Earlier conversation summary: ...]` system message. The summary is cached across loop rounds to avoid re-summarization. Falls back to silent trimming if summarization fails.

## Config Validation

`validateConfig()` in `packages/core/src/config.ts` checks for common configuration errors at startup:

- Agent tool references pointing to non-existent tools
- Hook tool references pointing to non-existent tools
- Cron job agent references pointing to non-existent agents
- Invalid default provider

Warnings are printed at CLI startup via `[config] Warning: ...`. Exported from `@tailored-ai/core`.

## Tool Parameter Validation

`validateToolArgs()` in `packages/core/src/agent/loop.ts` validates tool call arguments before execution:

- Checks required parameters are present
- Basic type matching (string, number, boolean, array)
- Returns clear errors with expected parameter list to the LLM

## Retry Utility

`packages/core/src/tools/retry.ts` provides `withRetry()` and `isTransientError()` for exponential backoff on external API calls:

- Default: 2 retries with 500ms → 1s → 2s delays
- `isTransientError()` detects fetch failures, connection errors, 429/502/503 status codes
- Applied to `web_fetch` and `web_search` tools
- Exported from `@tailored-ai/core`

## Tool Execution Timing

Tools taking >= 100ms have `[completed in Xms]` appended to their output, giving the LLM visibility into slow operations.

## Providers

One provider is built in — set `agent.defaultProvider` in config:

- **OpenAI-compatible** (`packages/core/src/providers/openai.ts`, `id: "openai_compatible"`) — generic `POST /v1/chat/completions` client for any OpenAI-wire-format server: **vLLM**, **Ollama** (`/v1` endpoint), **LM Studio**, **llama.cpp server**, **text-generation-webui**. `apiKey` is optional — when omitted no `Authorization` header is sent. Configure under `providers.openai_compatible` with required `baseUrl` (must include `/v1`) and `defaultModel`. Optional `name` controls the label shown in logs/UI.

Hosted vendors register their ids from plugin packages (#236): `@tailored-ai/provider-openai` (`openai`), `provider-anthropic` (`anthropic`), `provider-openrouter` (`openrouter`), `provider-bedrock` (`bedrock`). The `OpenAIProvider` class stays exported from core — `openai_compatible` uses it and gateway plugins (openrouter) wrap it. An unknown `defaultProvider` id fails with a hint to install the plugin that registers it.

**Multiple OpenAI-compatible endpoints (#253)**: `openai_compatible` is just the default id for the built-in `OpenAIProvider` — it isn't the only one. To run several OpenAI-wire endpoints at once (a local vLLM gateway *and* DeepSeek, Groq, Together, …), give each its own id and set `type: openai_compatible`; `agent.defaultProvider` selects among them. No per-vendor plugin needed.

```yaml
providers:
  local:    { type: openai_compatible, baseUrl: http://127.0.0.1:8000/v1, defaultModel: qwen3.6-27b }
  deepseek: { type: openai_compatible, baseUrl: https://api.deepseek.com, apiKey: ${DEEPSEEK_API_KEY}, defaultModel: deepseek-v4-flash }
agent:
  defaultProvider: local
```

A registered factory id (a plugin's, or the literal `openai_compatible`) always wins over an inline `type`. `createProvider()` does the resolution; the shared builder is exported as `buildOpenAICompatibleProvider` and the opt-in predicate as `isInlineOpenAICompatible`. Today this picks the one *default* provider — per-agent concurrent instances (different agents on different providers in one process) is a separate follow-up.

**Back-compat**: configs that still use `providers.ollama` (the removed native `/api/chat` provider) are auto-migrated to `providers.openai_compatible` at load time by appending `/v1` to the base URL. A deprecation warning is printed.

## Streaming (chatStream)

Providers may implement the optional `chatStream(params): AsyncIterable<ChatStreamEvent>` alongside the required `chat()`. The contract (`packages/core/src/providers/interface.ts`):

- `{ type: "delta", content }` — incremental assistant text, in order.
- `{ type: "reasoning", content }` — incremental reasoning/thinking trace (#254), a separate channel from `delta`. Emitted before text; concatenated reasoning equals `done.response.reasoning`.
- `{ type: "done", response }` — exactly one, last; carries the complete `ChatResponse` (tool calls, usage, finishReason, reasoning). Concatenated deltas equal `done.response.content`.
- Tool calls are never streamed partially — providers accumulate fragments internally and surface them complete on `done`.

Consumption: `AgentLoopOptions.onTextDelta` is the sink. When set and the active provider implements `chatStream`, the loop streams; otherwise it falls back to blocking `chat()` silently. The chat SSE route (`POST /api/chat`) wires `onTextDelta` to a `delta` event and the web UI renders the text live; the final `response` event always supersedes streamed text, so consumers stay correct when streaming is unavailable.

Retry semantics (`chatOnce` in `loop.ts`): a failure before any delta retries the stream; a failure after deltas were emitted retries with non-streaming `chat()` so consumers never see replayed text.

Both `OpenAIProvider` (`stream: true` + `stream_options.include_usage`; servers that omit usage produce zeros) and `AnthropicProvider` (`/v1/messages` stream events) implement it. Provider plugins should too (#226 adds a contract-test suite for the invariants).

## Reasoning (#254)

Reasoning models emit a thinking trace and accept an effort knob. The loop handles both ends uniformly.

**Capture.** `ChatResponse.reasoning` and a streamed `reasoning` event carry the trace. The loop persists `reasoning` on the assistant `Message` (a nullable `messages.reasoning` column) and the chat SSE route forwards `reasoning` deltas + includes the final trace on the `response` event. It is **display-only**: every message→wire converter ignores `Message.reasoning`, so it is never re-sent (some APIs 400 on a re-sent reasoning-only assistant turn), and `estimateTokens` excludes it from the history budget. The web UI renders it as a collapsible "Thinking" disclosure, collapsed by default.

**Control.** `ChatParams.thinking: "off" | "auto" | "low" | "medium" | "high"` is provider-agnostic; each provider maps it to its wire format. Set a per-provider default (`providers.<id>.thinking`) and/or a per-agent override (`agents.<name>.thinking`); the per-agent level wins per call (`params.thinking ?? defaultThinking`). Core ships the seam — `OpenAIProvider`'s `thinkingMap` option plus the generic exported mappers `reasoningEffortThinkingMap` and `enableThinkingTemplateMap` — and the `openai_compatible` provider exposes a `thinkingDialect` (`openai` | `vllm` | `none`) to pick one. Vendor budget/effort policy lives in each provider plugin, so core never learns a plugin's name.

| Level | OpenAI (`reasoning_effort`) | DeepSeek (`thinking`) | vLLM (`enable_thinking`) | Anthropic / Bedrock (`budget_tokens`) |
|---|---|---|---|---|
| `off` | omit | `disabled` | `false` | omit (disabled) |
| `auto` | omit (model default) | omit (native default) | omit (server default) | enabled @ 4096 |
| `low` | `low` | `enabled` | `true` | 1024 |
| `medium` | `medium` | `enabled` | `true` | 4096 |
| `high` | `high` | `enabled` | `true` | 16000 |

Note the `auto` asymmetry: effort-style APIs have no explicit "auto", so it omits the field; Anthropic/Bedrock have no `auto`, so it enables thinking at a moderate budget. Anthropic/Bedrock also bump `max_tokens` past the budget and drop `temperature` (rejected with thinking on), and Bedrock gates `reasoning_config` to Anthropic-family model ids (Nova/Llama/Mistral reject it).

### Provider capabilities and utilities

- **Model discovery**: providers may implement the optional `listModels?(): Promise<string[]>` (`providers/interface.ts`). Both built-ins do (`GET {baseUrl}/models` for the OpenAI family, `GET /v1/models` for Anthropic); the wizard/editor can offer real model ids instead of free text.
- **Contract-test suite**: `runProviderContractSuite` in `@tailored-ai/core/testing` (`testing/provider-contract.ts`) proves an `AIProvider` against the contract with a stubbed transport — response shape, mixed-history tolerance, tools param, streaming invariants (when `chatStream` is implemented), `listModels` shape. Provider plugins get contract coverage in ~10 LOC; `assertValidChatResponse` is exported for bespoke tests. Both built-ins dogfood the suite in `__tests__/provider-contract.test.ts`.
