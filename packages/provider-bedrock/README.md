# @tailored-ai/provider-bedrock

AWS Bedrock model provider for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents. One provider id (`bedrock`) gives your agents every model your AWS account can invoke: Anthropic Claude, Amazon Nova, Meta Llama, Mistral, and the rest of the Bedrock catalog, all through Bedrock's [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) with full tool-calling support.

## Install

```bash
tai plugin install @tailored-ai/provider-bedrock
```

## Configure

```yaml
plugins:
  - "@tailored-ai/provider-bedrock"

providers:
  bedrock:
    defaultModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    region: us-west-2        # optional: falls back to AWS_REGION / profile config
    profile: my-profile      # optional: falls back to the default credential chain

agent:
  defaultProvider: bedrock
```

You can also select it per agent instead of globally:

```yaml
agents:
  researcher:
    provider: bedrock
    model: "us.amazon.nova-pro-v1:0"
```

## Credentials

No keys go in `config.yaml`. The provider uses the standard AWS credential chain: environment variables (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), `~/.aws/credentials` and `~/.aws/config` profiles, SSO sessions, and instance roles. Set `profile` to pin a named profile; otherwise the default chain applies.

The IAM principal needs `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the models you use — the provider streams responses (ConverseStream) whenever the consumer asks for it, falling back to blocking Converse otherwise. Verify access from the same machine with:

```bash
aws sts get-caller-identity
aws bedrock list-foundation-models --region us-west-2
```

## Model ids and inference profiles

Most current models on Bedrock require a **cross-region inference profile** id rather than the bare model id. If you see `Invocation of model ID ... with on-demand throughput isn't supported`, prefix the id with your region group:

| Bare model id | Use instead |
|---|---|
| `anthropic.claude-haiku-4-5-20251001-v1:0` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `amazon.nova-pro-v1:0` | `us.amazon.nova-pro-v1:0` |

(`eu.` / `apac.` for accounts homed in those region groups.) List what your account can invoke:

```bash
aws bedrock list-inference-profiles --region us-west-2 \
  --query 'inferenceProfileSummaries[].inferenceProfileId'
```

## Extra request fields

`ChatParams.extra` (for example an agent's `providerExtra` settings) passes through as Converse's `additionalModelRequestFields`, so model-family-specific knobs like Anthropic's `top_k` reach the model unchanged.

## Development

```bash
pnpm --filter @tailored-ai/provider-bedrock run build
pnpm --filter @tailored-ai/provider-bedrock run test
```

The package is a `register(ctx)` plugin: the default export registers the `bedrock` provider factory on `ctx.providers`. The `providers.bedrock` config shape is owned here; core treats it as an opaque bag.

## License

MIT
