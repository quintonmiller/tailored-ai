# @tailored-ai/provider-openai

OpenAI model provider for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents — GPT and o-series models with the request shaping current OpenAI models require.

This plugin provides the `openai` provider id ([#236](https://github.com/quintonmiller/tailored-ai/issues/236) moved it out of core). Existing `providers.openai` config keeps working, and gains:

- **Reasoning-model handling** — o-series and gpt-5 family models reject `temperature` and the deprecated `max_tokens`; the plugin omits temperature for them and always uses `max_completion_tokens`. The built-in sends both, which errors on these models.
- **Org/project headers** — `OpenAI-Organization` and `OpenAI-Project` for multi-org accounts and usage attribution.
- **`params.extra` passthrough** — e.g. `reasoning_effort`.
- Streaming (`chatStream`) and model discovery (`listModels`).

## Install

```bash
tai plugin install @tailored-ai/provider-openai
```

## Configure

```yaml
plugins:
  - "@tailored-ai/provider-openai"

providers:
  openai:
    apiKey: "${OPENAI_API_KEY}"        # https://platform.openai.com/api-keys
    defaultModel: "gpt-5-mini"

agent:
  defaultProvider: openai
```

| Field | Required | Notes |
|---|---|---|
| `apiKey` | yes | Use `${OPENAI_API_KEY}` to read from the environment. |
| `defaultModel` | yes | Any chat-completions model id. `tai edit` lists them via `listModels`. |
| `organization` | no | `OpenAI-Organization` header. |
| `project` | no | `OpenAI-Project` header. |
| `reasoningModels` | no | Extra model-id prefixes to treat as reasoning models (built-in heuristic covers `o*` and `gpt-5*`). |
| `baseUrl` | no | Default `https://api.openai.com/v1`. Override for proxies. |

## Development

```bash
pnpm --filter @tailored-ai/provider-openai run build
pnpm --filter @tailored-ai/provider-openai run test
```

## License

MIT
