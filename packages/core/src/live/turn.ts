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
import { loadSession, newSession } from "../agent/session.js";
import { type AgentConfig, DEFAULT_CONFIG } from "../config.js";
import type { AgentRuntime } from "../runtime.js";
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
  text?(delta: string): void;
  audio?(chunk: { seq: number; text: string; bytes: Buffer; mimeType: string }): void;
}

export interface VoiceTurnResult {
  transcript: string;
  reply: string;
  /** Where the time went, in ms from the start of the turn. */
  timings: { sttMs?: number; firstTextMs?: number; firstAudioMs?: number; totalMs: number };
}

/**
 * Open a live session for an agent: refused unless `live.enabled`, with the
 * configured limits, and a fresh conversation for its turns.
 */
export function startLiveSession(
  runtime: Pick<AgentRuntime, "getConfig" | "getLiveSessions" | "db" | "getModel">,
  input: { agent?: string; transport: string },
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
  const conversation = newSession(runtime.db, runtime.getModel(), config.agent.defaultProvider);
  return runtime.getLiveSessions().start({
    ...(input.agent ? { agent: input.agent } : {}),
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
  const opts = runtime.buildLoopOptions({ session, agentName: live.agent, mode: "voice" });
  const voice = runtime.voiceModeFor(live.agent)?.voice ?? configuredVoice;

  // Speech runs one sentence at a time, in order, while the model keeps
  // writing: the chain starts on the first full sentence.
  const splitter = new SentenceSplitter();
  let chain: Promise<void> = Promise.resolve();
  let seq = 0;
  let streamed = false;
  const speak = (sentence: string) => {
    if (!sentence) return;
    chain = chain.then(async () => {
      const audio = await tts.synthesize(sentence, { ...(voice ? { voice } : {}), ...(signal ? { signal } : {}) });
      timings.firstAudioMs ??= since();
      sink.audio?.({ seq: seq++, text: sentence, ...audio });
    });
  };

  const reply = await runAgentLoop(transcript, {
    ...opts,
    ...(signal ? { signal } : {}),
    onTextDelta: (delta) => {
      streamed = true;
      timings.firstTextMs ??= since();
      sink.text?.(delta);
      for (const sentence of splitter.push(delta)) speak(sentence);
    },
  });

  // A provider that does not stream hands the whole reply over at the end.
  if (streamed) speak(splitter.flush());
  else {
    timings.firstTextMs ??= since();
    sink.text?.(reply);
    const whole = new SentenceSplitter();
    for (const sentence of [...whole.push(`${reply} `), whole.flush()]) speak(speakable(sentence));
  }
  await chain;
  return { transcript, reply, timings: { ...timings, totalMs: since() } };
}
