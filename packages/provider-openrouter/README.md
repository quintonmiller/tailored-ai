# @tailored-ai/provider-openrouter

OpenRouter model provider for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents — one API key for hundreds of models across vendors.

OpenRouter speaks the OpenAI wire format, so this plugin is a thin configuration of core's `OpenAIProvider`: chat, streaming, tool calling, and model discovery (`listModels` returns OpenRouter's full catalog) all work out of the box.

## Install

```bash
tai plugin install @tailored-ai/provider-openrouter
```

## Configure

```yaml
plugins:
  - "@tailored-ai/provider-openrouter"

providers:
  openrouter:
    apiKey: "${OPENROUTER_API_KEY}"          # https://openrouter.ai/keys
    defaultModel: "anthropic/claude-haiku-4.5"

agent:
  defaultProvider: openrouter
```

Per-agent override:

```yaml
agents:
  researcher:
    provider: openrouter
    model: "google/gemini-2.5-flash"
```

| Field | Required | Notes |
|---|---|---|
| `apiKey` | yes | Use `${OPENROUTER_API_KEY}` to read from the environment. |
| `defaultModel` | yes | An OpenRouter model id (`vendor/model`), e.g. `anthropic/claude-haiku-4.5`. |
| `baseUrl` | no | Defaults to `https://openrouter.ai/api/v1`. Override for proxies. |

## Model ids

OpenRouter ids are `vendor/model` (optionally with a `:variant` suffix like `:free` or `:nitro`). Browse at [openrouter.ai/models](https://openrouter.ai/models), or let the `tai edit` model picker list them via `listModels`.

## Not yet

Attribution headers (`HTTP-Referer` / `X-Title`, used for OpenRouter's app rankings) and provider-routing preferences need a small core seam — tracked in [#234](https://github.com/quintonmiller/tailored-ai/issues/234).

## Development

```bash
pnpm --filter @tailored-ai/provider-openrouter run build
pnpm --filter @tailored-ai/provider-openrouter run test
```

## License

MIT
