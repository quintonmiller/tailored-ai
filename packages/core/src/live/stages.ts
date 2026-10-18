/**
 * The speech stages of a live session: hearing and speaking.
 *
 * Each is a registry with a local default, so a deployment can swap one (a
 * different speech-to-text server, a cloud voice) without touching the rest.
 * Core ships one of each, speaking the OpenAI audio API that local servers
 * (faster-whisper wrappers, Kokoro-FastAPI, whisper.cpp, LocalAI) and hosted
 * ones share; anything else registers the same way a plugin would.
 */
import { type Disposer, Registry } from "../registry.js";

export interface Transcript {
  text: string;
  /** Length of the audio heard, when the server reports it. */
  durationMs?: number;
}

export interface SpeechToText {
  transcribe(audio: Buffer, opts: { mimeType: string; language?: string; signal?: AbortSignal }): Promise<Transcript>;
}

export interface SpokenAudio {
  bytes: Buffer;
  mimeType: string;
}

export interface TextToSpeech {
  synthesize(text: string, opts: { voice?: string; signal?: AbortSignal }): Promise<SpokenAudio>;
}

/** A stage's own options, from `live.stt.options` / `live.tts.options`. Opaque to core. */
export type SpeechToTextFactory = (options: Record<string, unknown>) => SpeechToText;
export type TextToSpeechFactory = (options: Record<string, unknown>) => TextToSpeech;

export const speechToTextRegistry = new Registry<SpeechToTextFactory>("speech-to-text");
export const textToSpeechRegistry = new Registry<TextToSpeechFactory>("text-to-speech");

export function registerSpeechToText(id: string, factory: SpeechToTextFactory): Disposer {
  return speechToTextRegistry.register(id, factory);
}

export function registerTextToSpeech(id: string, factory: TextToSpeechFactory): Disposer {
  return textToSpeechRegistry.register(id, factory);
}

function baseUrlOf(options: Record<string, unknown>, stage: string): string {
  const url = typeof options.baseUrl === "string" ? options.baseUrl.trim() : "";
  if (!url) throw new Error(`live.${stage}.options.baseUrl is not set, so there is no ${stage} server to call.`);
  return url.replace(/\/+$/, "");
}

function headersOf(options: Record<string, unknown>): Record<string, string> {
  return typeof options.apiKey === "string" && options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};

/** `POST {baseUrl}/audio/transcriptions`, multipart, as the OpenAI audio API takes it. */
export function openAICompatibleSpeechToText(options: Record<string, unknown>): SpeechToText {
  const baseUrl = baseUrlOf(options, "stt");
  const model = typeof options.model === "string" && options.model ? options.model : "whisper-1";
  return {
    async transcribe(audio, opts) {
      const type = opts.mimeType.split(";")[0].trim();
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type }), `speech.${EXTENSIONS[type] ?? "webm"}`);
      form.append("model", model);
      const language = opts.language ?? (typeof options.language === "string" ? options.language : undefined);
      if (language) form.append("language", language);
      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: headersOf(options),
        body: form,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as { text?: unknown; duration?: unknown; error?: unknown };
      if (!res.ok) {
        const reason = typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? res.statusText);
        throw new Error(`speech-to-text failed (${res.status}): ${reason}`);
      }
      return {
        text: typeof body.text === "string" ? body.text.trim() : "",
        ...(typeof body.duration === "number" ? { durationMs: Math.round(body.duration * 1000) } : {}),
      };
    },
  };
}

/** `POST {baseUrl}/audio/speech`, as the OpenAI audio API takes it. */
export function openAICompatibleTextToSpeech(options: Record<string, unknown>): TextToSpeech {
  const baseUrl = baseUrlOf(options, "tts");
  const model = typeof options.model === "string" && options.model ? options.model : "tts-1";
  const format = typeof options.format === "string" && options.format ? options.format : "mp3";
  const fallbackVoice = typeof options.voice === "string" && options.voice ? options.voice : "alloy";
  return {
    async synthesize(text, opts) {
      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headersOf(options) },
        body: JSON.stringify({ model, input: text, voice: opts.voice ?? fallbackVoice, response_format: format }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) throw new Error(`text-to-speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      return {
        bytes,
        mimeType: res.headers.get("content-type")?.split(";")[0] || `audio/${format === "mp3" ? "mpeg" : format}`,
      };
    },
  };
}

if (!speechToTextRegistry.has("openai_compatible")) {
  speechToTextRegistry.register("openai_compatible", openAICompatibleSpeechToText);
}
if (!textToSpeechRegistry.has("openai_compatible")) {
  textToSpeechRegistry.register("openai_compatible", openAICompatibleTextToSpeech);
}
