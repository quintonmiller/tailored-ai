/**
 * One spoken exchange: what the person said, an ordinary agent turn in voice
 * mode, and the reply spoken sentence by sentence.
 *
 * Each exchange is a normal turn — the loop, its tools, limits, guardrails
 * and history — rather than a separate component calling tools from outside
 * one. The spike measured the whole loop at ~25–35 ms over a bare model call,
 * which a voice reply can afford.
 */
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession, loadSession, newSession } from "../agent/session.js";
import { type AgentConfig, DEFAULT_CONFIG } from "../config.js";
import type { AgentRuntime } from "../runtime.js";
import { type Body, type Cue, type CuePiece, CueReader, withoutCues } from "./cues.js";
import { SentenceSplitter, speakable } from "./sentences.js";
import { type LiveSession, LiveSessionError } from "./session.js";
import { type SpeechToText, speechToTextRegistry, type TextToSpeech, textToSpeechRegistry } from "./stages.js";

export interface VoiceTurnInput {
  /** What the person said, recorded. */
  audio?: { bytes: Buffer; mimeType: string };
  /** Or typed: a transport may let a person type into a call. */
  text?: string;
}

/** What a transport hears as the turn happens, so it can play the reply while the rest is still being written. */
export interface VoiceTurnSink {
  transcript?(text: string): void;
  /** The reply as it is written, without its cues. */
  text?(delta: string): void;
  audio?(chunk: { seq: number; text: string; bytes: Buffer; mimeType: string }): void;
  /**
   * A cue, with the `seq` of the sentence it comes before: play it as that
   * audio starts. A cue after the last sentence has the next seq, so it plays
   * once the speech is done, or at once when there was none.
   */
  cue?(cue: Cue & { seq: number }): void;
}

export interface VoiceTurnResult {
  transcript: string;
  /** The reply as the person hears and reads it: its cues taken out. History keeps them, so the agent sees its own. */
  reply: string;
  /** Where the time went, in ms from the start of the turn. */
  timings: { sttMs?: number; firstTextMs?: number; firstAudioMs?: number; totalMs: number };
}

/**
 * Open a live session for an agent: refused unless `live.enabled`, with the
 * configured limits. Its turns go into the conversation `sessionKey` names,
 * so talking and typing on one page are one conversation; without a key, a
 * fresh one.
 */
export function startLiveSession(
  runtime: Pick<AgentRuntime, "getConfig" | "getLiveSessions" | "db" | "getModel">,
  input: { agent?: string; transport: string; body?: Body; sessionKey?: string },
): LiveSession {
  const config = runtime.getConfig();
  if (!config.live?.enabled) {
    throw new LiveSessionError(
      "Live sessions are off. Set `live.enabled: true` and configure `live.stt` and `live.tts`.",
    );
  }
  const limits = config.live.limits ?? {};
  // DEFAULT_CONFIG is the one place the defaults live; a config built by hand
  // (an embed, a test) may not have been merged with it.
  const defaults = DEFAULT_CONFIG.live?.limits as Required<NonNullable<NonNullable<AgentConfig["live"]>["limits"]>>;
  const conversation = input.sessionKey
    ? findOrCreateSession(runtime.db, input.sessionKey, runtime.getModel(), config.agent.defaultProvider)
    : newSession(runtime.db, runtime.getModel(), config.agent.defaultProvider);
  return runtime.getLiveSessions().start({
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.body ? { body: input.body } : {}),
    transport: input.transport,
    sessionId: conversation.id,
    limits: {
      maxMinutes: limits.maxMinutes ?? defaults.maxMinutes,
      idleMinutes: limits.idleMinutes ?? defaults.idleMinutes,
      maxTurns: limits.maxTurns ?? defaults.maxTurns,
    },
  });
}

/** The stages `live:` config names, built from their registries. */
export function speechStages(config: AgentConfig): { stt: SpeechToText; tts: TextToSpeech; voice?: string } {
  const live = config.live;
  const sttId = live?.stt?.provider ?? "openai_compatible";
  const ttsId = live?.tts?.provider ?? "openai_compatible";
  const stt = speechToTextRegistry.get(sttId);
  const tts = textToSpeechRegistry.get(ttsId);
  if (!stt) throw new Error(`No speech-to-text stage is registered as "${sttId}".`);
  if (!tts) throw new Error(`No text-to-speech stage is registered as "${ttsId}".`);
  return {
    stt: stt(live?.stt?.options ?? {}),
    tts: tts(live?.tts?.options ?? {}),
    ...(live?.tts?.voice ? { voice: live.tts.voice } : {}),
  };
}

export async function runVoiceTurn(
  runtime: Pick<AgentRuntime, "getConfig" | "buildLoopOptions" | "voiceModeFor" | "db">,
  live: LiveSession,
  input: VoiceTurnInput,
  sink: VoiceTurnSink = {},
  signal?: AbortSignal,
): Promise<VoiceTurnResult> {
  const started = Date.now();
  const since = () => Date.now() - started;
  const { stt, tts, voice: configuredVoice } = speechStages(runtime.getConfig());
  const timings: VoiceTurnResult["timings"] = { totalMs: 0 };

  let transcript = input.text?.trim() ?? "";
  if (!transcript && input.audio) {
    const heard = await stt.transcribe(input.audio.bytes, {
      mimeType: input.audio.mimeType,
      ...(signal ? { signal } : {}),
    });
    transcript = heard.text;
    timings.sttMs = since();
  }
  sink.transcript?.(transcript);
  if (!transcript) return { transcript, reply: "", timings: { ...timings, totalMs: since() } };

  const session = loadSession(runtime.db, live.sessionId);
  if (!session) throw new Error("This live session's conversation is gone.");
  const opts = runtime.buildLoopOptions({
    session,
    agentName: live.agent,
    mode: "voice",
    ...(live.body ? { body: live.body } : {}),
  });
  const voice = runtime.voiceModeFor(live.agent)?.voice ?? configuredVoice;

  // Speech runs one sentence at a time, in order, while the model keeps
  // writing: the chain starts on the first full sentence.
  const splitter = new SentenceSplitter();
  let chain: Promise<void> = Promise.resolve();
  let seq = 0;
  // Sentences handed to speech so far: a cue belongs to the next one.
  let queued = 0;
  let streamed = false;
  const speak = (sentence: string) => {
    if (!sentence) return;
    queued++;
    chain = chain.then(async () => {
      const audio = await tts.synthesize(sentence, { ...(voice ? { voice } : {}), ...(signal ? { signal } : {}) });
      timings.firstAudioMs ??= since();
      sink.audio?.({ seq: seq++, text: sentence, ...audio });
    });
  };

  // Cues come out before anything is spoken or shown; with no body there are
  // none to look for, and the text passes through untouched.
  const reader = live.body ? new CueReader(live.body) : undefined;
  const take = (pieces: CuePiece[], into: SentenceSplitter) => {
    for (const piece of pieces) {
      if ("cue" in piece) {
        sink.cue?.({ ...piece.cue, seq: queued });
        continue;
      }
      sink.text?.(piece.text);
      for (const sentence of into.push(piece.text)) speak(sentence);
    }
  };

  const reply = await runAgentLoop(transcript, {
    ...opts,
    ...(signal ? { signal } : {}),
    onTextDelta: (delta) => {
      streamed = true;
      timings.firstTextMs ??= since();
      take(reader ? reader.push(delta) : [{ text: delta }], splitter);
    },
  });

  // A provider that does not stream hands the whole reply over at the end.
  if (streamed) {
    if (reader) take(reader.flush(), splitter);
    speak(splitter.flush());
  } else {
    timings.firstTextMs ??= since();
    const whole = new SentenceSplitter();
    take(reader ? [...reader.push(reply), ...reader.flush()] : [{ text: reply }], whole);
    speak(speakable(whole.flush()));
  }
  await chain;
  return {
    transcript,
    reply: live.body ? withoutCues(live.body, reply) : reply,
    timings: { ...timings, totalMs: since() },
  };
}
