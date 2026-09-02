/**
 * `POST {baseUrl}/audio/speech` — OpenAI's TTS wire format.
 *
 * One implementation covers both ends of the cost range, which is why it is
 * the first and for a while the only one:
 *
 *   - OpenAI itself (`gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`)
 *   - a local Kokoro behind Kokoro-FastAPI, which serves the same route and
 *     the same body, on CPU, for nothing
 *
 * Switching between them is a `baseUrl` and a `model`. Nothing else in the
 * stack has to know which one answered.
 */
import { AUDIO_MIME, type SpeechProvider, SpeechProviderError, type SynthesizeRequest } from "../provider.js";

export interface OpenAICompatibleOptions {
  /** Includes the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Used for any utterance that does not name its own. */
  voice?: string;
  /** 0.25–4.0 on OpenAI; passed through untouched. */
  speed?: number;
  timeoutMs?: number;
}

const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  timeoutMs: 120_000,
};

export class OpenAICompatibleSpeech implements SpeechProvider {
  readonly id = "openai_compatible";
  /**
   * One voice per request. A dialogue is rendered turn by turn and joined by
   * the caller. Kokoro-FastAPI does accept inline `[voice:name]` switching,
   * but that is its extension and not the OpenAI contract, so relying on it
   * here would silently produce one narrator reading both parts against
   * OpenAI itself.
   */
  readonly nativeMultiVoice = false;

  constructor(private readonly opts: OpenAICompatibleOptions = {}) {}

  async synthesize(req: SynthesizeRequest) {
    if (req.utterances.length !== 1) {
      throw new SpeechProviderError(
        this.id,
        undefined,
        `expects exactly one utterance per request (got ${req.utterances.length}); ` +
          `the caller renders a multi-voice script turn by turn`,
      );
    }
    const [utterance] = req.utterances;
    const baseUrl = (this.opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, "");
    const timeoutMs = this.opts.timeoutMs ?? DEFAULTS.timeoutMs;

    // Own timeout, linked to the caller's signal. Synthesis of a long turn is
    // slow enough that the default fetch behaviour — wait forever — would
    // hang a turn rather than fail it.
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timer]) : timer;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // A local server usually wants no key; sending an empty bearer is
          // worse than sending nothing, so only set it when there is one.
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model ?? DEFAULTS.model,
          input: utterance.text,
          voice: utterance.voice ?? this.opts.voice ?? DEFAULTS.voice,
          response_format: req.format,
          ...(this.opts.speed !== undefined ? { speed: this.opts.speed } : {}),
        }),
        signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new SpeechProviderError(this.id, undefined, `no audio after ${timeoutMs}ms (${baseUrl})`);
      }
      throw new SpeechProviderError(this.id, undefined, `could not reach ${baseUrl}: ${e.message}`);
    }

    if (!res.ok) {
      // Pass the provider's own words through. "400 Bad Request" is useless;
      // "voice 'af_bella' not found" tells the agent what to fix.
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new SpeechProviderError(this.id, res.status, `${res.status} from ${baseUrl}${detail ? `: ${detail}` : ""}`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new SpeechProviderError(this.id, res.status, "returned 200 with an empty body");
    }
    return { bytes, mimeType: AUDIO_MIME[req.format] };
  }
}
