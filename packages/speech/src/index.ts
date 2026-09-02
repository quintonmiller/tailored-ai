/**
 * @tailored-ai/speech
 *
 * Gives agents a voice: text in, an audio attachment out, on whatever
 * surface the turn is already talking to.
 *
 * Packaged as a `register(ctx)` plugin. Core is untouched — the tool puts
 * its bytes in `ToolContext.mediaStore` and returns a media part, which is
 * the same path a screenshot takes, so Discord, Slack, the web UI and the
 * CLI all carry the result without knowing this package exists.
 *
 * Add to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/speech"
 *     tools:
 *       speak:
 *         enabled: true
 *         provider: openai_compatible
 *         baseUrl: http://127.0.0.1:8880/v1   # a local Kokoro
 *         model: kokoro
 *         voice: af_bella
 *         voices:                              # per-speaker, for dialogues
 *           host: af_bella
 *           guest: am_adam
 *
 * Pointing it at OpenAI instead is `baseUrl`, `model` and `apiKey`; nothing
 * else in the config or the agent changes.
 */
import type { AgentConfig, Plugin, PluginMeta } from "@tailored-ai/core";
import { AUDIO_MIME, listSpeechProviders, registerSpeechProvider } from "./provider.js";
import { OpenAICompatibleSpeech } from "./providers/openai-compatible.js";
import { SpeakTool, type SpeakToolConfig } from "./speak.js";

export { SpeakTool, type SpeakToolConfig };
export { OpenAICompatibleSpeech };
export { AUDIO_MIME, listSpeechProviders, registerSpeechProvider };
export {
  type AudioFormat,
  resolveSpeechProvider,
  type SpeechProvider,
  SpeechProviderError,
  type SpeechProviderFactory,
  type SynthesizeRequest,
  type SynthesizeResult,
  type Utterance,
} from "./provider.js";
export { concatWav, isWav, wavDurationMs } from "./wav.js";

const plugin: Plugin = (ctx) => {
  const disposers: Array<() => void> = [];

  disposers.push(registerSpeechProvider("openai_compatible", (opts) => new OpenAICompatibleSpeech(opts)));

  disposers.push(
    ctx.tools.register("speak", (config) => {
      const cfg = config.tools.speak as SpeakToolConfig | undefined;
      if (!cfg?.enabled) return [];
      return [new SpeakTool(cfg)];
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
};

export const meta: PluginMeta = {
  name: "Speech synthesis",
  description: "A `speak` tool that turns text — or a multi-speaker script — into an audio attachment.",
  registers: [{ kind: "tool", id: "speak", configKey: "tools.speak" }],
};

/**
 * Core's `validateConfig` knows nothing about this block by design, so the
 * checks that would otherwise be discovered at the first call live here.
 *
 * Every one of these is a way to be configured, start cleanly, and do
 * nothing — the failure mode this repo keeps rediscovering.
 */
export function validateConfig(config: AgentConfig): string[] {
  const cfg = config.tools?.speak as SpeakToolConfig | undefined;
  if (!cfg?.enabled) return [];

  const warnings: string[] = [];
  const providerId = cfg.provider ?? "openai_compatible";
  const known = listSpeechProviders();
  if (!known.includes(providerId)) {
    warnings.push(
      `tools.speak.provider "${providerId}" is not registered (have: ${known.join(", ") || "none"}); ` +
        `the tool will refuse every call`,
    );
  }

  if (providerId === "openai_compatible") {
    const baseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl : undefined;
    // Absent baseUrl means OpenAI itself, which will 401 without a key. A
    // local server needs no key, so the check is only meaningful for the
    // remote default.
    const remote = !baseUrl || /(^|\.)api\.openai\.com/.test(baseUrl);
    if (remote && !cfg.apiKey) {
      warnings.push(
        "tools.speak is enabled against the OpenAI endpoint but apiKey is empty " +
          "(unresolved ${ENV_VAR}?); every call will fail with 401",
      );
    }
  }

  if (cfg.format && !(cfg.format in AUDIO_MIME)) {
    warnings.push(
      `tools.speak.format "${cfg.format}" is not a known container (use ${Object.keys(AUDIO_MIME).join(", ")})`,
    );
  }

  if (!cfg.voice && !cfg.voices) {
    warnings.push(
      "tools.speak sets neither voice nor voices; single-voice calls fall back to the provider default " +
        "and multi-speaker scripts will be refused",
    );
  }

  return warnings;
}

export default plugin;
