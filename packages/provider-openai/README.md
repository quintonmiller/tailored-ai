# @tailored-ai/provider-openai

OpenAI model provider for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents — GPT and o-series models with the request shaping current OpenAI models require.

This plugin provides the `openai` provider id ([#236](https://github.com/quintonmiller/tailored-ai/issues/236) moved it out of core). Existing `providers.openai` config keeps working, and gains:

- **Reasoning-model handling** — o-series and gpt-5 family models reject `temperature` and the deprecated `max_tokens`; the plugin omits temperature for them and always uses `max_completion_tokens`. The built-in sends both, which errors on these models.
- **Org/project headers** — `OpenAI-Organization` and `OpenAI-Project` for multi-org accounts and usage attribution.
- **`params.extra` passthrough** — e.g. `reasoning_effort`.
- **Responses API** — reasoning and tool calls in the same turn, for the models chat completions refuses ([below](#which-endpoint)).
- Streaming (`chatStream`) and model discovery (`listModels`).

## Which endpoint

`/v1/chat/completions` refuses function tools alongside any reasoning effort on
`gpt-5.4`, `gpt-5.5` and the `gpt-5.6` family, and does not serve
`gpt-5.3-codex` at all. TAI always sends tools, so on those models reasoning and
tool use are mutually exclusive there. `/v1/responses` has no such restriction.
Measured 2026-08-05, tools present:

| model | `/v1/chat/completions` | `/v1/responses` |
|---|---|---|
| `gpt-5.4`, `gpt-5.5`, `gpt-5.6-*` | reasoning impossible | every effort accepted |
| `gpt-5.3-codex` | not served | accepted |
| `gpt-5-mini`, `o4-mini` | rejects `none` | rejects `none` |
| `gpt-5.3-chat-latest` | only `medium` | only `medium` |

`api: auto` (the default) sends the first two rows to `/v1/responses` and
everything else to chat completions, so nothing moves that was already working.
It only auto-routes against `api.openai.com` — a `baseUrl` pointing at Azure, a
proxy or a local gateway stays on chat completions unless you set
`api: responses` explicitly.

Per-model reasoning quirks are learned from the API's own refusals rather than
hardcoded: an effort a model rejects is replaced with the nearest one it accepts
(so `off` on `gpt-5-mini` becomes `minimal`, not `high`), remembered for the
process, and reported once.

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
| `api` | no | `auto` (default), `chat`, or `responses`. See [which endpoint](#which-endpoint). |
| `responsesModels` | no | Extra model-id prefixes to route to `/v1/responses` under `api: auto`. |
| `reasoningSummary` | no | `auto` (default), `concise`, `detailed`, `off`. The readable reasoning trace TAI captures. Orgs not verified for summaries are detected and downgraded automatically. |
| `store` | no | Let OpenAI retain responses server-side. Default `false`, matching chat completions. |

## Development

```bash
pnpm --filter @tailored-ai/provider-openai run build
pnpm --filter @tailored-ai/provider-openai run test
```

## License

MIT
