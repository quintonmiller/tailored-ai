/**
 * The seam between "some text and a voice" and "some bytes".
 *
 * This is a registry rather than a function because `web_search` is the
 * cautionary tale in this repo: it hardcoded one vendor and there is now an
 * open issue to retrofit the seam (#617). The vendors here differ more than
 * search vendors do — OpenAI takes one voice per request, ElevenLabs has its
 * own wire format, Gemini renders two speakers in a single call — so the
 * abstraction has to exist before the second implementation, not after.
 */

/** One rendered piece of audio. */
export interface Utterance {
  /** What to say. */
  text: string;
  /**
   * Provider-specific voice id. Left opaque on purpose: `af_bella`, `nova`
   * and a 20-character ElevenLabs id have nothing in common but being a
   * string, and a normalising layer over them would be fiction.
   */
  voice?: string;
}

export type AudioFormat = "mp3" | "wav" | "opus" | "flac" | "aac" | "pcm";

export const AUDIO_MIME: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  pcm: "audio/pcm",
};

export interface SynthesizeRequest {
  /**
   * The turns to render, in order. A single-speaker call is one utterance;
   * a dialogue is several. Providers that cannot render more than one voice
   * per request say so through `nativeMultiVoice`, and the caller renders
   * each turn separately and joins the results.
   */
  utterances: Utterance[];
  /** Container to ask the provider for. */
  format: AudioFormat;
  /** Abort the underlying request. */
  signal?: AbortSignal;
}

export interface SynthesizeResult {
  bytes: Buffer;
  /**
   * What the bytes actually are. Returned rather than inferred because
   * core's sniffer does not recognise mp3 at all (#596) and would fall back
   * to whatever the caller declared — so the declaration had better come
   * from whoever made the bytes.
   */
  mimeType: string;
}

export interface SpeechProvider {
  /** Registry id, e.g. `openai_compatible`. */
  readonly id: string;
  /**
   * True when the provider renders several voices in one request. When
   * false the caller splits the script and joins the audio itself, which
   * only works for formats that can be concatenated — see `wav.ts`.
   */
  readonly nativeMultiVoice: boolean;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
}

/**
 * Anything a provider needs from config. Opaque on purpose: the selector is
 * an open string and the settings are the provider's business, which is the
 * shape core uses for every other pluggable subsystem.
 */
export type SpeechProviderOptions = Record<string, unknown>;

export type SpeechProviderFactory = (opts: SpeechProviderOptions) => SpeechProvider;

const registry = new Map<string, SpeechProviderFactory>();

export function registerSpeechProvider(id: string, factory: SpeechProviderFactory): () => void {
  registry.set(id, factory);
  return () => {
    if (registry.get(id) === factory) registry.delete(id);
  };
}

export function resolveSpeechProvider(id: string, opts: SpeechProviderOptions): SpeechProvider | undefined {
  return registry.get(id)?.(opts);
}

export function listSpeechProviders(): string[] {
  return [...registry.keys()].sort();
}

/** Raised when the provider answered and the answer was a refusal. */
export class SpeechProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SpeechProviderError";
  }
}
