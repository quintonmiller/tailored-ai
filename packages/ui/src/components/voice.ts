import { useCallback, useEffect, useRef, useState } from "react";
import { type Cue, CueTimeline } from "../avatar/cues";
import { decodeEnvelope, loudnessAt } from "../avatar/envelope";
import type { BodyState } from "../avatar/motion";

/**
 * Talking with an agent out loud, from any page: hold to speak, let go to
 * send, and the reply plays back a sentence at a time while the rest is still
 * being written.
 *
 * The live session behind it opens on the first hold and joins the
 * conversation `sessionKey` names, so what is said and what is typed on the
 * page are one conversation. It starts over when the agent, the body or the
 * conversation changes.
 */

export type VoicePhase = BodyState;

export interface VoiceTurn {
  transcript: string;
  reply: string;
  /** The conversation the turn went into: the chat adopts it when it had none yet. */
  conversation?: string;
}

export interface VoiceOptions {
  agent?: string;
  /** The conversation to talk in. Called when a session opens; the chat's key, or a new one. */
  sessionKey: () => string;
  /** What the avatar's body can do, when one is on screen; its cues then come back as `onCue`. */
  body?: unknown;
  /** Decode each reply's loudness, so an avatar's mouth can follow it. */
  measure: boolean;
  onCue?: (cue: Cue) => void;
  /** What was heard, as soon as it is known. */
  onHeard?: (text: string) => void;
  /** The reply as it is written. */
  onText?: (delta: string) => void;
  onDone?: (turn: VoiceTurn) => void;
}

interface LiveSession {
  id: string;
  conversation?: string;
  endedAt?: string;
}

export function useVoice(opts: VoiceOptions) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [timing, setTiming] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const live = useRef(opts);
  live.current = opts;
  const session = useRef<LiveSession | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const held = useRef(false);
  const timeline = useRef(new CueTimeline((cue) => live.current.onCue?.(cue)));
  const player = useAudioQueue(
    (busy) => {
      setPhase((p) => (busy ? "speaking" : p === "speaking" ? "idle" : p));
      if (!busy) timeline.current.quiet();
    },
    opts.measure,
    (seq) => timeline.current.started(seq),
  );

  const end = useCallback(() => {
    const s = session.current;
    session.current = null;
    setActive(false);
    if (s && !s.endedAt)
      void fetch(`/api/live/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
  }, []);

  // A different agent, body or conversation is a different session: the
  // prompt it talks with changes, so the next hold opens a new one.
  const bodyKey = JSON.stringify(opts.body ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: any of these changing ends the session.
  useEffect(() => end, [opts.agent, bodyKey, end]);

  // Let the session and the microphone go when the page does.
  useEffect(
    () => () => {
      end();
      for (const t of stream.current?.getTracks() ?? []) t.stop();
    },
    [end],
  );

  const open = useCallback(async (): Promise<LiveSession | null> => {
    if (session.current && !session.current.endedAt) return session.current;
    const { agent, body, sessionKey } = live.current;
    const res = await fetch("/api/live/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(agent ? { agent } : {}), ...(body ? { body } : {}), sessionKey: sessionKey() }),
    });
    const data = (await res.json().catch(() => ({}))) as LiveSession & { error?: string };
    if (!res.ok) {
      setError(data.error ?? `Could not start talking (${res.status}).`);
      return null;
    }
    session.current = data;
    setActive(true);
    return data;
  }, []);

  const send = useCallback(
    async (audio: Blob) => {
      const s = session.current;
      if (!s) return;
      setPhase("thinking");
      setError(null);
      timeline.current.reset();
      const res = await fetch(`/api/live/sessions/${encodeURIComponent(s.id)}/turn`, {
        method: "POST",
        headers: { "Content-Type": audio.type || "audio/webm" },
        body: audio,
      });
      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        setError(detail.error ?? `The turn failed (${res.status}).`);
        setPhase("idle");
        // Past a limit: the next hold opens a fresh session.
        if (res.status === 409) end();
        return;
      }
      let transcript = "";
      await readEvents(res.body, (event, data) => {
        if (event === "transcript") {
          transcript = String(data.text ?? "");
          live.current.onHeard?.(transcript);
          if (!transcript) setPhase("idle");
        } else if (event === "text") {
          live.current.onText?.(String(data.delta ?? ""));
        } else if (event === "audio") {
          player.push(String(data.data ?? ""), String(data.mimeType ?? "audio/mpeg"), Number(data.seq));
        } else if (event === "cue") {
          if (typeof data.name === "string")
            timeline.current.cue({
              name: data.name,
              seq: Number(data.seq) || 0,
              ...(typeof data.target === "string" ? { target: data.target } : {}),
            });
        } else if (event === "done") {
          timeline.current.finished();
          const t = data.timings as Record<string, number> | undefined;
          if (t)
            setTiming(
              [
                t.sttMs !== undefined && `heard in ${t.sttMs} ms`,
                t.firstAudioMs !== undefined && `first word at ${t.firstAudioMs} ms`,
              ]
                .filter(Boolean)
                .join(", "),
            );
          setPhase((p) => (p === "thinking" ? "idle" : p));
          live.current.onDone?.({
            transcript: String(data.transcript ?? transcript),
            reply: String(data.reply ?? ""),
            ...(s.conversation ? { conversation: s.conversation } : {}),
          });
        } else if (event === "error") {
          setError(String(data.message ?? "The turn failed."));
          setPhase("idle");
        }
      });
    },
    [player, end],
  );

  const record = useCallback(() => {
    if (!stream.current || recorder.current) return;
    chunks.current = [];
    const rec = new MediaRecorder(stream.current);
    rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
      if (blob.size > 0) void send(blob);
      else setPhase("idle");
    };
    recorder.current = rec;
    rec.start();
    setPhase("listening");
  }, [send]);

  /** Start listening. The first time, asks for the microphone and opens the session. */
  const hold = useCallback(async () => {
    held.current = true;
    // Cutting in drops the words still to come, and the moves waiting with them.
    timeline.current.reset();
    player.stop();
    setError(null);
    if (!stream.current) {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError("No microphone: allow it in the browser to talk.");
        return;
      }
    }
    if (!(await open())) return;
    // Still holding once the microphone and session are ready.
    if (held.current) record();
  }, [open, player, record]);

  /** Stop listening and send what was said. */
  const release = useCallback(() => {
    held.current = false;
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
  }, []);

  return { phase, error, timing, active, hold, release, end, loudness: player.loudness };
}

/** Read a server-sent event stream from a fetch body, frame by frame. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  on: (event: string, data: Record<string, unknown>) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    // Whole frames only: an event's name and its data can arrive in different chunks.
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: ?(.*)$/m.exec(frame)?.[1];
      const data = /^data: ?(.*)$/m.exec(frame)?.[1];
      if (!event || data === undefined) continue;
      try {
        on(event, JSON.parse(data));
      } catch {
        // a malformed frame is skipped, not fatal
      }
    }
    if (done) break;
  }
}

/**
 * Plays audio chunks one after another, in the order they arrive. With
 * `measure` on, it also decodes each chunk's loudness over time, so an
 * avatar's mouth can follow the voice.
 */
function useAudioQueue(onBusy: (busy: boolean) => void, measure: boolean, onStart?: (seq: number) => void) {
  const queue = useRef<{ url: string; seq?: number }[]>([]);
  const starting = useRef(onStart);
  starting.current = onStart;
  const current = useRef<{ url: string; audio: HTMLAudioElement } | null>(null);
  const busy = useRef(false);
  const notify = useRef(onBusy);
  notify.current = onBusy;
  const measuring = useRef(measure);
  measuring.current = measure;
  // Per chunk: its envelope once decoded, null if it couldn't be.
  const envelopes = useRef(new Map<string, Float32Array | null>());

  const next = useCallback(() => {
    const item = queue.current.shift();
    if (!item) {
      busy.current = false;
      current.current = null;
      notify.current(false);
      return;
    }
    const { url } = item;
    busy.current = true;
    notify.current(true);
    if (item.seq !== undefined) starting.current?.(item.seq);
    const audio = new Audio(url);
    current.current = { url, audio };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      envelopes.current.delete(url);
      next();
    };
    audio.play().catch(() => next());
  }, []);

  return useRef({
    push(base64: string, mimeType: string, seq?: number) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      if (measuring.current) {
        void decodeEnvelope(bytes).then((envelope) => {
          // A chunk already played, or cut off, needs no envelope.
          if (queue.current.some((q) => q.url === url) || current.current?.url === url)
            envelopes.current.set(url, envelope);
        });
      }
      queue.current.push({ url, ...(Number.isFinite(seq) ? { seq } : {}) });
      if (!busy.current) next();
    },
    /** Stop speaking: the person has started talking. */
    stop() {
      current.current?.audio.pause();
      for (const { url } of queue.current.splice(0)) URL.revokeObjectURL(url);
      envelopes.current.clear();
      busy.current = false;
      current.current = null;
      notify.current(false);
    },
    /** How loud the voice is right now, 0–1. Read every frame by the avatar. */
    loudness(): number {
      const playing = current.current;
      if (!playing) return 0;
      const t = playing.audio.currentTime || 0;
      const envelope = envelopes.current.get(playing.url);
      if (envelope) return loudnessAt(envelope, t);
      // Not decoded (yet, or at all): a steady flap still reads as talking.
      return 0.3 + 0.25 * Math.sin(t * 18);
    },
  }).current;
}
