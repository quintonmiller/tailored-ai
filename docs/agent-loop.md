# Agent Loop & Providers

How the loop trims history, validates tool args, retries transient errors, and which providers are wired up.

## History Compaction

The agent loop trims conversation history before each LLM call to stay within `config.agent.maxHistoryTokens` (default 2000). Token count is estimated at ~4 chars per token. Trimming drops the oldest messages first, but always skips past orphaned `tool` messages so tool-call/response groups stay intact. See `estimateTokens()` and `trimHistory()` in `packages/core/src/agent/loop.ts`.

The budget covers the whole request, not just the messages:

```
historyBudget = maxHistoryTokens - systemPromptTokens - tailTokens - toolSchemaTokens
```

Tool definitions travel in their own request field rather than as a message, which is why they went unmeasured for so long — everything that estimated size walked the message list. The model reads them either way, and they are not small: 42 tools serialise to roughly 10,857 tokens, so a budget that ignored them overshot by about 10% on every request. `estimateToolSchemaTokens()` is recomputed per round, because `getTools()` re-resolves per round and a turn can gain or lose tools mid-flight.

The same subtraction applies when a fallback rung re-fits history to its own `maxContextTokens`, where it matters more: the schemas sent are identical, and the window is usually tighter.

Opt-in summarization: set `summarizeOnTrim: true` in an agent to replace silent trimming with a summary. When enabled, `trimHistoryWithSummary()` calls the LLM to summarize dropped messages into a `[Earlier conversation summary: ...]` system message. The summary is cached across loop rounds to avoid re-summarization. Falls back to silent trimming if summarization fails.

### Compaction is reversible

`compactSession()` replaces a whole session with a summary of it. Trimming is per-request and touches nothing on disk; compaction is a deliberate, persisted rewrite, so it follows the same rule `rewind` does — **nothing is deleted**.

Compacted rows keep their place and gain a `compacted_batch` number, `getSessionMessages()` skips them, and the summary row is stamped with `compaction_summary_for` so undoing removes it rather than leaving a summary of the conversation beside the conversation.

| Function | Does |
|---|---|
| `compactSession(db, id, provider, model, opts)` | save durable facts, summarize, hide the originals, return the batch |
| `undoCompaction(db, id, batch?)` | restore one compaction, most recent by default |
| `listSessionCompactions(db, id)` | what is currently folded away |

`opts` decides the shape of the result, and every field is a deployment's call rather than core's:

| option | effect |
|---|---|
| `keepRecent` | leave the newest N messages visible; fold away only what precedes them |
| `prompt` | what the summariser is asked for |
| `maxTokens` | cap the summary; unset lets the provider choose |
| `memory: { agent }` | write durable facts as notes before anything is hidden |

**Why the wording is configurable.** The built-in text used to ask for a summary "concisely", of "key facts, decisions, and pending tasks" — a project-status framing living in core. Measured against a real 1,432-message companion history that produced **88 tokens**; the same line with "in detail" produced **475**, with six times the named specifics and quoted phrasing the short one had none of. One word was discarding most of the history, and the noun list was making a companion's five days read like a standup report. A deployment knows what its conversations are for; core does not.

**Why the memory checkpoint exists.** A summary is one block every later turn carries whether or not it is relevant. A note is retrieved when it matches what is being discussed. For a long conversation the second is the better shape — the history that comes back is the history that applies — so the summary can stay short without the details being gone. Notes are written under the agent losing the history, so they are not pooled across agents.

The order matters and is tested: **facts first, summarize second, hide third.** A provider that throws leaves the session exactly as it was rather than hidden behind a summary that never arrived.

Why it changed: compaction used to `DELETE FROM messages`, keeping no archive, no tombstone and emitting no event, so a summary that dropped the one fact that mattered dropped it permanently. That also made it unsafe to trigger automatically — a destructive, lossy, model-authored rewrite is one thing to run deliberately and another to fire on a threshold. `session.compacted` is emitted on the bus so a subscriber can archive, notify or audit.

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

## Model fallback chain

The provider call walks an ordered chain of provider+model pairs
(`chatWithFallback` in `agent/loop.ts`) rather than calling one provider. The
chain comes from `ResolvedAgent.models`, is rebuilt every iteration through
`AgentLoopOptions.getModelChain` so a config reload takes effect mid-run, and is
never empty — a deployment that declares no `models[]` gets a one-entry chain and
behaves exactly as it always did.

- Each rung gets **one** attempt; the last also gets the transient retry below.
  A model that just refused is not worth a second call while a working one waits.
- **Any** throw advances to the next rung, including 4xx. A provider error
  arrives as an `Error` whose status is only in its message, and "this model
  refuses this request" is when a different model is worth trying.
- Building a rung can fail (its plugin is not installed); those are dropped by
  `runtime.resolveModelChain` with a one-time warning rather than surfacing.
- When every rung fails, the **first** error is thrown: the primary's failure is
  the one that explains the outage.
- Deltas already streamed by a failed rung are not withdrawn. The consumer
  contract is that the final response supersedes streamed deltas, so crossing
  models mid-turn shows as a flicker rather than corrupting the transcript.

Configuration, precedence and the two things this deliberately does not do
(quality-based escalation, per-rung context budgets) are in
[model-fallbacks.md](./model-fallbacks.md).

## Retry Utility

`packages/core/src/tools/retry.ts` provides `withRetry()` and `isTransientError()` for exponential backoff on external API calls:

- Default: 2 retries with 500ms → 1s → 2s delays
- `isTransientError()` detects fetch failures, connection errors, 429/502/503 status codes
- Applied to `web_fetch` and `web_search` tools
- Exported from `@tailored-ai/core`

## Tool Output Cap

A single tool result is bounded before it reaches the conversation. `capToolOutput()` in `packages/core/src/agent/tool-output.ts` runs at the one place a `ToolResult` becomes the string that enters history (`executeToolCall`), so builtin, custom, plugin and MCP tools are all covered by one check — and it sits upstream of `onToolResult`, the `tool` Message, `saveMessage()` and the repeat detector.

| Setting | Default | Meaning |
|---|---|---|
| `agent.maxToolOutputChars` | 32000 | Chars of one result that reach history. `0` disables. |
| `tools.<id>.maxOutputChars` | — | Per-tool override, by resolved tool name. |

MCP tools aren't keyed in `tools:` by discovery — they arrive as `mcp_<server>_<tool>`. Because the lookup is by resolved name and `tools:` is an open map, naming one there works:

```yaml
tools:
  mcp_notion_API-post-search:
    maxOutputChars: 8000
```

Over the limit, the result becomes a head+tail summary led by a marker naming the tool, the real size, and a path to the full output (kept under `$TAI_HOME/tool-outputs/<session>/`). The marker says explicitly that repeating the call returns the same truncated string — the obvious move for a model handed a partial answer is to run it again.

Two properties worth preserving if you touch this:

- **The output is deterministic for a given input.** The scratch file is named by content hash, not timestamp. The loop's stuck-model detector compares consecutive tool results verbatim, so a unique path in the marker would make two identical results compare unequal and silently disable the guard that catches a model re-issuing the truncated call. (`exec`'s own older truncation names its file by timestamp and *does* have this bug.)
- **A persistence failure still truncates.** Returning the full string because the scratch write failed would reinstate the blowup this exists to prevent.

Why it exists: one `mcp_notion_API-post-search` with `page_size: 50` returned 70,485 chars / 27,187 real tokens against an 18,800-token budget. `trimHistory` evicted from the front until it fit — which meant evicting the user's question — and `ensureUserMessagePresent` spliced the *first* user message back in, so the agent answered a welcome message from an hour earlier and introduced itself. Three times in forty minutes. The symptom reads as amnesia, never as a large tool result.

`exec` keeps its own stricter truncation (4000 bytes, line-based) tuned for test-runner output; this cap is the outer bound for everything else.

## Tool Execution Timing

Tools taking >= 100ms have `[completed in Xms]` appended to their output, giving the LLM visibility into slow operations.

## Ending a turn from inside a tool (`endsTurn`)

A tool can stop the loop by returning `endsTurn: true` on its `ToolResult`. The loop honours it after the round's results are written to history and before the repeated-call detector, and reports `LoopStop { kind: "tool-ended", tool, reason }`. That is **not** a stall — `isStallStop()` returns false for it.

`endsTurnReason` becomes the loop's return value. Unset, the loop falls back to whatever text the model produced alongside the call, which for a tool meaning "nothing to say" is normally empty.

Why it exists: telling a model to stop *in the tool result* does not work on small models. Measured on a 27B local model, `room(action="pass")` — whose entire meaning is "I am saying nothing" — was called three times per check-in, re-sending a ~56k prompt each time, and the turn exited through the repeated-call detector. Three round-trips for one decision, reported as a stall, for what was in fact the intended outcome.

Set it on the result rather than declaring it on the tool, because a multi-action tool ends the turn on some actions and not others: `room` post and read continue, `room` pass does not. A tool that *failed* can still end the turn — success and intent-to-stop are separate questions. Where several calls in one round set it, the first wins.

Current users: `sleep` (concludes an exploratory tick, supplying `[Sleep] <reason>`) and `room(action="pass")` (no reason). Any tool can use it, including plugin and MCP tools — it replaced a private `workingMemory["tick_done"]` convention that only core tools could discover.

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

## Sampling controls core does not model (`providerExtra`)

The generation call sends `temperature` and `max_tokens`, plus the mapped `thinking` fragment. Everything else a
provider offers — vLLM's `repetition_penalty`, `top_k`, `min_p`, whatever a plugin invents — reaches the wire through
one opaque bag.

```yaml
agents:
  lila:
    model: omega-evolution-27b
    providerExtra:
      repetition_penalty: 1.15
      top_k: 20
```

Resolution mirrors `maxTokens`: `models[].providerExtra` (per rung) → `agents.<name>.providerExtra` → `agent.providerExtra`.
It lands on `ChatParams.extra`, which `OpenAIProvider.buildBody` merges onto the request body **last** — so a key here
also overrides one core would otherwise set, which is the escape hatch when core's mapping is wrong for a given server.

Two deliberate choices:

- **Core never validates or interprets the keys.** A provider plugin can expose its own controls without a core change,
  and a key the provider does not recognise is that provider's error to raise, not core's to whitelist. Same shape as
  `tasks.options`.
- **A more specific level replaces the bag rather than merging into it.** Every other override here means "unset
  inherits", and merging would read the same way — but the bag is *provider-shaped*, and a chain routinely mixes
  providers. Inheriting a vLLM `repetition_penalty` into an Anthropic fallback would send a field that provider has
  never heard of. Set it per rung, in full, or leave it unset.

**Why this exists.** It is not a convenience knob. `omega-evolution-27b` re-sends its own previous message nearly
verbatim — measured 15/16, word-trigram overlap 0.90 against the agent's own prior reply — and nothing core could
already send fixes it. Temperature does not (1.0 → 15/16). Prompt wording does not; an explicit "do not repeat"
instruction measured 20/20, worse than saying nothing. The model's own `generation_config.json` ships
`presence_penalty: 1.5` and that does not either (15/16), because presence/frequency penalties are additive on token
counts while the failure is re-emitting a whole prior message. `repetition_penalty: 1.15` takes it to 4/16, and with
the repo's recommended `top_k`/`top_p` to 3/16 — at parity with the model it replaced. A deployment that cannot send
that field has no way to run the model.

Prefer setting it here over baking it into a model server's launch flags: config survives a model swap, applies per
agent, and reaches metered cloud providers too.

### Provider capabilities and utilities

- **Model discovery**: providers may implement the optional `listModels?(): Promise<string[]>` (`providers/interface.ts`). Both built-ins do (`GET {baseUrl}/models` for the OpenAI family, `GET /v1/models` for Anthropic); the wizard/editor can offer real model ids instead of free text.
- **Contract-test suite**: `runProviderContractSuite` in `@tailored-ai/core/testing` (`testing/provider-contract.ts`) proves an `AIProvider` against the contract with a stubbed transport — response shape, mixed-history tolerance, tools param, streaming invariants (when `chatStream` is implemented), `listModels` shape. Provider plugins get contract coverage in ~10 LOC; `assertValidChatResponse` is exported for bespoke tests. Both built-ins dogfood the suite in `__tests__/provider-contract.test.ts`.
