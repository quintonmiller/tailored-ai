# @tailored-ai/provider-anthropic

Anthropic Messages API provider for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents — Claude models with prompt caching, beta headers, streaming, and model discovery.

This plugin provides the `anthropic` provider id ([#236](https://github.com/quintonmiller/tailored-ai/issues/236) moved it out of core). Existing `providers.anthropic` config keeps working, and gains the features below. On older cores that still ship a minimal built-in, the plugin supersedes it — the one-line "Replacing existing entry" notice at startup is expected.

## Install

```bash
tai plugin install @tailored-ai/provider-anthropic
```

## Configure

```yaml
plugins:
  - "@tailored-ai/provider-anthropic"

providers:
  anthropic:
    apiKey: "${ANTHROPIC_API_KEY}"     # https://console.anthropic.com
    defaultModel: "claude-haiku-4-5"

agent:
  defaultProvider: anthropic
```

| Field | Required | Notes |
|---|---|---|
| `apiKey` | yes | Use `${ANTHROPIC_API_KEY}` to read from the environment. |
| `defaultModel` | yes | A Claude model id, e.g. `claude-haiku-4-5`. `tai edit` lists them via `listModels`. |
| `promptCaching` | no | Adds ephemeral cache breakpoints to the system prompt, the tool definitions and the message history. An agent loop re-sends all three on every round, so cache hits cut input cost (cached reads are ~10% of base price) and latency. Default `true`; set `false` to send no breakpoints. |
| `defaultMaxTokens` | no | `max_tokens` when the agent doesn't set one (the API requires it). Default `4096`. |
| `version` | no | `anthropic-version` header. Default `2023-06-01`. |
| `betas` | no | List of beta flags, sent as the `anthropic-beta` header (e.g. `context-1m-2025-08-07`). |
| `baseUrl` | no | Default `https://api.anthropic.com`. Override for proxies. |

## Extra request fields

Anthropic-specific parameters the TAI contract doesn't model (extended thinking, `top_k`, …) flow through `ChatParams.extra` straight into the request body. Surfaces that expose a `providerExtra` config bag (briefing, suggestions) can use it today; the main agent loop doesn't set `extra` per agent yet.

## Usage accounting

Cache writes and reads are summed into `usage.input`, so token counts reflect what the API actually processed rather than silently excluding cached tokens.

## Development

```bash
pnpm --filter @tailored-ai/provider-anthropic run build
pnpm --filter @tailored-ai/provider-anthropic run test
```

## License

MIT
