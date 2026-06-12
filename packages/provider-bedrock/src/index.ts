/**
 * @tailored-ai/provider-bedrock
 *
 * Packaged as a `register(ctx)` plugin. The host invokes the default export
 * with a {@link PluginContext} during runtime construction; the plugin
 * registers the "bedrock" provider factory. Select it with
 * `agent.defaultProvider: bedrock` (or per-agent `provider: bedrock`).
 *
 * Add to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/provider-bedrock"
 *     providers:
 *       bedrock:
 *         defaultModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
 *         region: us-west-2          # optional — falls back to AWS_REGION / profile config
 *         profile: my-profile        # optional — falls back to the default credential chain
 *     agent:
 *       defaultProvider: bedrock
 *
 * Auth comes from the standard AWS credential chain (env vars, ~/.aws
 * profiles, SSO, IMDS) — no keys in config.yaml. The config shape is owned
 * here: core's `providers` config is an open map and knows nothing about
 * the `bedrock` id.
 */
import type { AgentConfig, Plugin, PluginMeta } from "@tailored-ai/core";
import { BedrockProvider } from "./provider.js";

export { BedrockProvider, type BedrockProviderOptions } from "./provider.js";

/** Config bag read from `providers.bedrock` — owned by this plugin. */
export interface BedrockConfig {
  defaultModel?: string;
  region?: string;
  profile?: string;
}

export const meta: PluginMeta = {
  name: "AWS Bedrock provider",
  description:
    "Bedrock-hosted models (Anthropic, Nova, Meta, Mistral, …) via the Converse API. AWS credential chain auth.",
  registers: [{ kind: "provider", id: "bedrock", configKey: "providers.bedrock" }],
};

/** Plugin-owned config checks — the shape lives here, not in core (#229). */
export function validateConfig(config: AgentConfig): string[] {
  const cfg = config.providers.bedrock as BedrockConfig | undefined;
  if (!cfg) return [];
  const warnings: string[] = [];
  if (!cfg.defaultModel) {
    warnings.push(
      'providers.bedrock is configured but defaultModel is missing — set a Bedrock model or inference-profile id, e.g. "us.anthropic.claude-haiku-4-5-20251001-v1:0"',
    );
  }
  return warnings;
}

const plugin: Plugin = (ctx) => {
  ctx.providers.register("bedrock", (config) => {
    const cfg = config.providers.bedrock as BedrockConfig | undefined;
    if (!cfg) throw new Error("providers.bedrock not configured");
    if (!cfg.defaultModel) {
      throw new Error(
        'providers.bedrock requires a defaultModel — a Bedrock model or inference-profile id, e.g. "us.anthropic.claude-haiku-4-5-20251001-v1:0"',
      );
    }
    return {
      provider: new BedrockProvider({ region: cfg.region, profile: cfg.profile }),
      model: cfg.defaultModel,
    };
  });
};

export default plugin;
