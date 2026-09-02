/**
 * `speak` — text in, audio out, as a media part the surfaces already know
 * how to carry.
 *
 * Deliberately one tool with two input shapes rather than two tools or an
 * action enum: `text` is one voice, `script` is several, and the shape is
 * already the discriminant. An agent that has learned the single-speaker
 * form learns the dialogue form by adding a field.
 */
import type { Tool, ToolContext, ToolResult } from "@tailored-ai/core";
import { mediaPart, textPart } from "./content.js";
import {
  AUDIO_MIME,
  type AudioFormat,
  resolveSpeechProvider,
  type SpeechProvider,
  SpeechProviderError,
  type Utterance,
} from "./provider.js";
import { concatWav, isWav, wavDurationMs } from "./wav.js";

export interface SpeakToolConfig {
  enabled?: boolean;
  /** Registry id of the provider. Open string — see provider.ts. */
  provider?: string;
  /** Everything else in the block is handed to the provider untouched. */
  [key: string]: unknown;
  /** Voice used when neither the call nor the speaker map names one. */
  voice?: string;
  /** Container. `wav` is forced for multi-voice scripts — see below. */
  format?: AudioFormat;
  /**
   * Ceiling on characters per call. The guard that matters: at ElevenLabs
   * rates a runaway script is real money, and at any provider a 90-minute
   * render is a turn that never returns.
   */
  maxChars?: number;
  /** Named voices a script's speakers resolve through. */
  voices?: Record<string, string>;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_FORMAT: AudioFormat = "mp3";

interface ScriptTurn {
  speaker: string;
  text: string;
}

export class SpeakTool implements Tool {
  name = "speak";
  description =
    "Turn text into audio and attach it. Pass `text` for one voice, or `script` (a list of {speaker, text}) for a dialogue such as a podcast.";
  parameters = {
    type: "object",
    properties: {
      text: { type: "string", description: "What to say, for a single-voice recording." },
      script: {
        type: "array",
        description:
          "Turns of a dialogue, in order. Use instead of `text`. Each speaker keeps one voice for the whole recording.",
        items: {
          type: "object",
          properties: {
            speaker: { type: "string", description: "Who is talking, e.g. `host`. Any label; reused across turns." },
            text: { type: "string", description: "What they say." },
          },
          required: ["speaker", "text"],
        },
      },
      voice: { type: "string", description: "Voice id for `text`. Defaults to the configured voice." },
      voices: {
        type: "object",
        description:
          'Voice id per speaker for `script`, e.g. {"host": "af_bella"}. Speakers not named here fall back to the configured voices.',
      },
    },
  };

  constructor(private readonly cfg: SpeakToolConfig) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Audio with nowhere to live is not a degraded result, it is no result:
    // there is no text projection of a recording worth returning. Say so
    // rather than inventing one.
    const store = context.mediaStore;
    if (!store) {
      return fail("this deployment has no media store, so generated audio has nowhere to go.");
    }

    const providerId = this.cfg.provider ?? "openai_compatible";
    const provider = resolveSpeechProvider(providerId, this.cfg);
    if (!provider) {
      return fail(`no speech provider registered as "${providerId}".`);
    }

    let turns: Utterance[];
    let label: string;
    try {
      ({ turns, label } = this.plan(args));
    } catch (err) {
      return fail((err as Error).message);
    }

    const total = turns.reduce((n, t) => n + t.text.length, 0);
    const maxChars = this.cfg.maxChars ?? DEFAULT_MAX_CHARS;
    if (total > maxChars) {
      // Refused, not truncated. Half a podcast is worse than none: it sounds
      // finished, and the missing half is only discoverable by listening.
      return fail(
        `that is ${total.toLocaleString()} characters and the limit is ${maxChars.toLocaleString()}. ` +
          `Shorten it, or split it into several recordings.`,
      );
    }

    const format = this.formatFor(turns.length, provider);
    let bytes: Buffer;
    let mimeType: string;
    try {
      ({ bytes, mimeType } = await this.render(provider, turns, format));
    } catch (err) {
      if (err instanceof SpeechProviderError) return fail(`speech provider ${err.provider}: ${err.message}`);
      return fail(`synthesis failed: ${(err as Error).message}`);
    }

    try {
      const ref = await store.put(bytes, {
        mimeType,
        name: `${label}.${format}`,
        sessionId: context.sessionId,
      });
      return {
        success: true,
        output: { parts: [textPart(summarize(label, turns, bytes)), mediaPart(ref)] },
      };
    } catch (err) {
      return fail(`audio was generated but could not be stored: ${(err as Error).message}`);
    }
  }

  /** Resolve the two input shapes into one ordered list of utterances. */
  private plan(args: Record<string, unknown>): { turns: Utterance[]; label: string } {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const rawScript = Array.isArray(args.script) ? (args.script as unknown[]) : undefined;

    if (text && rawScript?.length) {
      throw new Error("pass `text` or `script`, not both.");
    }

    if (text) {
      const voice = pickString(args.voice) ?? this.cfg.voice;
      return { turns: [{ text, voice }], label: "speech" };
    }

    if (!rawScript?.length) {
      throw new Error("nothing to say — pass `text`, or `script` with at least one turn.");
    }

    const callVoices = isRecord(args.voices) ? (args.voices as Record<string, unknown>) : {};
    const script: ScriptTurn[] = rawScript.map((raw, i) => {
      if (!isRecord(raw)) throw new Error(`script[${i}] is not an object with {speaker, text}.`);
      const speaker = pickString(raw.speaker);
      const line = pickString(raw.text);
      if (!speaker) throw new Error(`script[${i}] is missing a speaker.`);
      if (!line) throw new Error(`script[${i}] (${speaker}) has no text.`);
      return { speaker, text: line };
    });

    const cast = new Set(script.map((t) => t.speaker));

    // A named speaker resolves ONLY through a per-speaker map. The single
    // `voice` is a fallback for one voice, and letting it cover a cast is how
    // a dialogue renders with one narrator reading every part — audio that
    // succeeds, and is useless, and is discoverable only by listening.
    //
    // This is not hypothetical: the first version fell back to `voice`, and
    // against the ordinary config (a default `voice` plus a `voices` map) a
    // model that invented its own speaker names got a monologue and a success.
    const voiceFor = (speaker: string): string | undefined =>
      pickString(callVoices[speaker]) ?? this.cfg.voices?.[speaker];

    if (cast.size > 1) {
      const unmapped = [...cast].filter((s) => !voiceFor(s));
      if (unmapped.length > 0) {
        const known = Object.keys(this.cfg.voices ?? {});
        throw new Error(
          `no voice for ${unmapped.map((s) => `"${s}"`).join(", ")}, and a ${cast.size}-speaker script ` +
            `needs one each or everybody sounds the same. ` +
            (known.length
              ? `Either name these speakers in \`voices\` (e.g. {"${unmapped[0]}": "<a voice id>"}), ` +
                `or reuse the configured speakers: ${known.join(", ")}.`
              : `Pass \`voices\`, e.g. {"${unmapped[0]}": "<a voice id>"}.`),
        );
      }
    }

    const turns = script.map((t) => ({
      text: t.text,
      // One speaker: the single `voice` is the right fallback, since there is
      // nobody to be confused with.
      voice: cast.size > 1 ? voiceFor(t.speaker) : (voiceFor(t.speaker) ?? this.cfg.voice),
    }));

    return { turns, label: "dialogue" };
  }

  /**
   * `wav` for anything joined locally. mp3 frames can often be concatenated
   * and play, but the result has a wrong duration in most players and
   * garbage at the seams in some; wav can be joined exactly.
   */
  private formatFor(turnCount: number, provider: SpeechProvider): AudioFormat {
    const configured = this.cfg.format ?? DEFAULT_FORMAT;
    if (turnCount <= 1 || provider.nativeMultiVoice) return configured;
    return "wav";
  }

  /**
   * `SynthesizeRequest` carries an optional `signal`, and nothing passes one:
   * `ToolContext` has no cancellation signal to forward (#631). Each provider
   * call still bounds itself with its own timeout, so a hung server fails the
   * turn instead of hanging it — but a script already halfway rendered cannot
   * be stopped early. The field stays so it costs nothing to wire up the day
   * a signal exists.
   */
  private async render(
    provider: SpeechProvider,
    turns: Utterance[],
    format: AudioFormat,
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    if (turns.length === 1 || provider.nativeMultiVoice) {
      return provider.synthesize({ utterances: turns, format });
    }

    // Sequential on purpose. Firing every turn at once is faster and is the
    // wrong trade against a local single-GPU server, which serialises them
    // anyway, and against a paid API, where a rate-limit rejection halfway
    // through wastes everything already rendered.
    const rendered: Buffer[] = [];
    for (const turn of turns) {
      const out = await provider.synthesize({ utterances: [turn], format });
      if (!isWav(out.bytes)) {
        throw new SpeechProviderError(
          provider.id,
          undefined,
          `a multi-voice script is joined locally and needs wav, but the provider returned ${out.mimeType}`,
        );
      }
      rendered.push(out.bytes);
    }
    return { bytes: concatWav(rendered), mimeType: AUDIO_MIME.wav };
  }
}

/**
 * What the agent reads back. Length first, because that is the number it
 * needs to judge the result and the one the media placeholder cannot supply
 * — `MediaRef` has no time axis (#596), so `[audio: dialogue.wav ...]` reads
 * the same for four seconds and forty minutes.
 */
function summarize(label: string, turns: Utterance[], bytes: Buffer): string {
  const chars = turns.reduce((n, t) => n + t.text.length, 0);
  const kb = Math.round(bytes.byteLength / 1024);
  const ms = wavDurationMs(bytes);
  const bits = [ms !== undefined ? formatDuration(ms) : `${kb} KB`, `${chars.toLocaleString()} characters`];
  if (turns.length > 1) bits.push(`${turns.length} turns`);
  return `Recorded ${label} — ${bits.join(", ")}.`;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

function fail(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
