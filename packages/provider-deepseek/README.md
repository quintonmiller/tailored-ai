# @tailored-ai/provider-deepseek

DeepSeek model provider for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents — DeepSeek's V4 hybrid models, low-cost and strong.

DeepSeek speaks the OpenAI wire format, so chat, streaming, tool calling, and model discovery (`listModels`) come straight from core's `OpenAIProvider`. On top of that this plugin exposes DeepSeek's one non-standard knob — the per-request **thinking** toggle.

## Install

```bash
tai plugin install @tailored-ai/provider-deepseek
```

## Configure

```yaml
plugins:
  - "@tailored-ai/provider-deepseek"

providers:
  deepseek:
    apiKey: "${DEEPSEEK_API_KEY}"          # https://platform.deepseek.com/api_keys
    defaultModel: "deepseek-v4-flash"
    thinking: false                        # non-thinking: fast, reliable tool calls

agent:
  defaultProvider: deepseek
```

Per-agent override — keep a local model for everyday work, reach for DeepSeek where it helps:

```yaml
agents:
  researcher:
    provider: deepseek
    model: "deepseek-v4-pro"
```

| Field | Required | Notes |
|---|---|---|
| `apiKey` | yes | Use `${DEEPSEEK_API_KEY}` to read from the environment. |
| `defaultModel` | yes | `deepseek-v4-flash` or `deepseek-v4-pro`. |
| `thinking` | no | `false` = non-thinking, `true` = thinking. Omit to use the model's native default (the V4 models think by default). |
| `baseUrl` | no | Defaults to `https://api.deepseek.com`. Override for proxies. |

## Models

| Model | What it is | Tool calling |
|---|---|---|
| `deepseek-v4-flash` | V4 hybrid, lower-latency tier. The right default for an agent. | Yes |
| `deepseek-v4-pro` | V4 hybrid, most capable. For hard problems. | Yes |

Both are hybrids: a single model that either answers directly (**non-thinking**) or reasons first (**thinking**), selected per request by `thinking`.

- **`thinking: false`** — snappy, no reasoning tokens, reliable tool calls. This is the durable version of the old `deepseek-chat` behavior. The right default for tool-driven agent work.
- **`thinking: true`** — reasons before answering; stronger on hard problems, but slower and token-hungrier. Give it a generous `maxTokens` — a small budget gets eaten by the reasoning pass and the reply comes back empty with `finish_reason: length`.

The loop can still override the mode per call by passing `extra: { thinking: { type: "enabled" } }`.

### A note on `deepseek-chat` / `deepseek-reasoner`

Those two model names are the non-thinking and thinking aliases of `deepseek-v4-flash`. **DeepSeek deprecates them on 2026-07-24.** Use `deepseek-v4-flash` with `thinking` instead — same model, no deprecation.

## Not yet

In thinking mode the chain-of-thought (`reasoning_content`) isn't surfaced — only the final answer comes through. Streaming and tool calling work; the reasoning trace is dropped.

## Development

```bash
pnpm --filter @tailored-ai/provider-deepseek run build
pnpm --filter @tailored-ai/provider-deepseek run test
```

## License

MIT
