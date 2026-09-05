/**
 * `speak` — text in, audio out, as a media part the surfaces already know
 * how to carry.
 *
 * Deliberately one tool with two input shapes rather than two tools or an
 * action enum: `text` is one voice, `script` is several, and the shape is
 * already the discriminant. An agent that has learned the single-speaker
 * form learns the dialogue form by adding a field.
 */
import { readFileSync } from "node:fs";
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
import { parseScript } from "./script-file.js";
import { concatWav, isWav, wavDurationMs } from "./wav.js";

export interface SpeakToolConfig {
  /**
   * Silence inserted between turns of a multi-voice script, in milliseconds.
   * A dialogue joined with no gap runs at the pace of an argument; a real
   * conversation breathes between speakers.
   */
  gapMs?: number;
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

/** A header block is a handful of lines, not a scene. Past this it is dialogue. */
const MAX_MATTER_LINES = 10;

/**
 * A beat between speakers. Measured against a real episode that had none: no
 * pause exceeded 0.8s across 12.5 minutes, which is exhausting to listen to.
 * Long enough to hear a speaker change, short enough not to drag.
 */
const DEFAULT_GAP_MS = 350;

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_FORMAT: AudioFormat = "mp3";

interface ScriptTurn {
  speaker: string;
  text: string;
}

export class SpeakTool implements Tool {
  name = "speak";
  description =
    "Turn text into audio and attach it. Pass `text` for one voice, `script` (a list of {speaker, text}) for a dialogue, or `scriptFile` to read a long script off disk and only map the voices.";
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
      scriptFile: {
        type: "string",
        description:
          "Path to a script file to read instead of passing `script` inline. Lines are `SPEAKER: what they say`; anything else (act headings, notes) is skipped. Use this for anything long — you supply the voices, not the text.",
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
    let note: string | undefined;
    try {
      ({ turns, label, note } = this.plan(args));
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
        output: { parts: [textPart(summarize(label, turns, bytes) + (note ?? "")), mediaPart(ref)] },
      };
    } catch (err) {
      return fail(`audio was generated but could not be stored: ${(err as Error).message}`);
    }
  }

  /** Resolve the two input shapes into one ordered list of utterances. */
  private plan(args: Record<string, unknown>): { turns: Utterance[]; label: string; note?: string } {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    let rawScript = Array.isArray(args.script) ? (args.script as unknown[]) : undefined;
    const scriptFile = pickString(args.scriptFile);

    if (text && (rawScript?.length || scriptFile)) {
      throw new Error("pass `text`, `script` or `scriptFile` — not more than one.");
    }
    if (rawScript?.length && scriptFile) {
      throw new Error("pass `script` or `scriptFile`, not both.");
    }

    let skippedNote = "";
    if (scriptFile) {
      let source: string;
      try {
        source = readFileSync(scriptFile, "utf8");
      } catch (err) {
        throw new Error(`could not read ${scriptFile}: ${(err as Error).message}`);
      }
      const parsed = parseScript(source);
      if (parsed.turns.length === 0) {
        throw new Error(
          `${scriptFile} has no dialogue lines. Each spoken line must look like ` +
            `"SPEAKER: what they say"` +
            (parsed.skipped.length ? `; ${parsed.skipped.length} line(s) matched nothing.` : "."),
        );
      }
      // A script is usually wrapped in a header and a footer — "Cast: ...",
      // "Setting: ...", "Notes for TTS: ..." — and every one of those lines is
      // shaped exactly like dialogue. Nothing in the text tells them apart, so
      // three things together do: they sit at an EDGE, there are FEW, and
      // nobody cast them. All three are required, because each alone is wrong:
      // a character can speak the first line, a character can be left uncast by
      // mistake, and a script can open with several short exchanges.
      //
      // Both ends are trimmed, because writers put notes at both ends. What
      // stops a genuinely miscast character from vanishing here is not refusal
      // but visibility: every dropped line is named in the result, so an agent
      // that sees "skipped: MARA" knows it forgot a voice, while one that sees
      // "skipped: Notes for TTS" knows the trim was right.
      //
      // From a real 141-line script whose cast parsed as GM, REX, MARA ... plus
      // "Setting", "Tone", "Running gag" and a trailing "Notes for TTS".
      const cast = isRecord(args.voices) ? (args.voices as Record<string, unknown>) : {};
      const isCast = (sp: string) => Boolean(pickString(cast[sp]) ?? this.cfg.voices?.[sp]);
      const all = parsed.turns;
      let head = 0;
      while (head < all.length && !isCast(all[head].speaker)) head++;
      let tail = 0;
      while (tail < all.length - head && !isCast(all[all.length - 1 - tail].speaker)) tail++;
      const trimmable = (n: number) => n > 0 && n <= MAX_MATTER_LINES && n / all.length <= 0.25;
      const dropHead = trimmable(head) ? head : 0;
      const dropTail = trimmable(tail) ? tail : 0;
      const turns = all.slice(dropHead, all.length - dropTail);
      rawScript = turns as unknown[];
      const trimmed = [...all.slice(0, dropHead), ...all.slice(all.length - dropTail)];
      const dropped = parsed.skipped.length + trimmed.length;
      if (dropped > 0) {
        const names = [...new Set(trimmed.map((t) => t.speaker))];
        skippedNote = ` (${dropped} non-dialogue line(s) skipped${names.length ? `: ${names.join(", ")}` : ""})`;
      }
    }

    if (text) {
      const voice = pickString(args.voice) ?? this.cfg.voice;
      return { turns: [{ text, voice }], label: "speech" };
    }

    if (!rawScript?.length) {
      throw new Error("nothing to say — pass `text`, `script` with at least one turn, or `scriptFile`.");
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

    if (skippedNote) console.warn(`[speak] ${scriptFile}${skippedNote}`);
    // The note goes back to the caller, not just to the operator log. Trimming
    // a line the agent meant to keep is only safe if the agent is told which.
    return { turns, label: "dialogue", note: skippedNote || undefined };
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
    return { bytes: concatWav(rendered, this.cfg.gapMs ?? DEFAULT_GAP_MS), mimeType: AUDIO_MIME.wav };
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
