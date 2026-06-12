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

Three providers are supported — set `agent.defaultProvider` in config:

- **OpenAI-compatible** (`packages/core/src/providers/openai.ts`, `id: "openai_compatible"`) — generic `POST /v1/chat/completions` client for any OpenAI-wire-format server: **vLLM**, **Ollama** (`/v1` endpoint), **LM Studio**, **llama.cpp server**, **text-generation-webui**. `apiKey` is optional — when omitted no `Authorization` header is sent. Configure under `providers.openai_compatible` with required `baseUrl` (must include `/v1`) and `defaultModel`. Optional `name` controls the label shown in logs/UI.
- **OpenAI** (`packages/core/src/providers/openai.ts`, `id: "openai"`) — hosted OpenAI; requires `apiKey`. Same wire format as openai_compatible but always sends auth.
- **Anthropic** (`packages/core/src/providers/anthropic.ts`) — Anthropic Messages API.

Both `openai_compatible` and `openai` share `OpenAIProvider`; the only differences are auth-header behavior and the `id`/`name` reported on the instance.

**Back-compat**: configs that still use `providers.ollama` (the removed native `/api/chat` provider) are auto-migrated to `providers.openai_compatible` at load time by appending `/v1` to the base URL. A deprecation warning is printed.

## Streaming (chatStream)

Providers may implement the optional `chatStream(params): AsyncIterable<ChatStreamEvent>` alongside the required `chat()`. The contract (`packages/core/src/providers/interface.ts`):

- `{ type: "delta", content }` — incremental assistant text, in order.
- `{ type: "done", response }` — exactly one, last; carries the complete `ChatResponse` (tool calls, usage, finishReason). Concatenated deltas equal `done.response.content`.
- Tool calls are never streamed partially — providers accumulate fragments internally and surface them complete on `done`.

Consumption: `AgentLoopOptions.onTextDelta` is the sink. When set and the active provider implements `chatStream`, the loop streams; otherwise it falls back to blocking `chat()` silently. The chat SSE route (`POST /api/chat`) wires `onTextDelta` to a `delta` event and the web UI renders the text live; the final `response` event always supersedes streamed text, so consumers stay correct when streaming is unavailable.

Retry semantics (`chatOnce` in `loop.ts`): a failure before any delta retries the stream; a failure after deltas were emitted retries with non-streaming `chat()` so consumers never see replayed text.

Both `OpenAIProvider` (`stream: true` + `stream_options.include_usage`; servers that omit usage produce zeros) and `AnthropicProvider` (`/v1/messages` stream events) implement it. Provider plugins should too (#226 adds a contract-test suite for the invariants).
