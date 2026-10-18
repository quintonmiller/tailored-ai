import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAgents } from "../api";

/**
 * Talk to an agent out loud: push-to-talk over the live session routes.
 *
 * Hold the button (or Space), speak, let go. The recording goes up in one
 * request; the reply streams back — what was heard, the agent's words as it
 * writes them, and its voice a sentence at a time, played as each arrives.
 */

interface Session {
  id: string;
  agent?: string;
  limits: { maxMinutes: number; idleMinutes: number; maxTurns: number };
  turns: number;
  endedAt?: string;
  endReason?: string;
}

interface Line {
  who: "you" | "agent";
  text: string;
}

type Phase = "idle" | "listening" | "thinking" | "speaking";

export function Talk() {
  const [agents, setAgents] = useState<string[]>([]);
  const [agent, setAgent] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [timing, setTiming] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  // State, not just the ref: the button has to redraw when the microphone opens.
  const [micReady, setMicReady] = useState(false);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const player = useAudioQueue((busy) => setPhase((p) => (busy ? "speaking" : p === "speaking" ? "idle" : p)));

  useEffect(() => {
    fetchAgents()
      .then((a) => setAgents(Object.keys(a).sort()))
      .catch(() => {});
  }, []);

  // Let the microphone go when the page does.
  useEffect(
    () => () =>
      stream.current?.getTracks().forEach((t) => {
        t.stop();
      }),
    [],
  );

  async function start() {
    setError(null);
    const res = await fetch("/api/live/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent ? { agent } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as Session & { error?: string };
    if (!res.ok) {
      setError(body.error ?? `Could not start (${res.status}).`);
      return;
    }
    setSession(body);
    setLines([]);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicReady(true);
    } catch {
      setError("No microphone: allow it in the browser, or type below instead.");
    }
  }

  async function end() {
    if (!session) return;
    await fetch(`/api/live/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => {});
    stream.current?.getTracks().forEach((t) => {
      t.stop();
    });
    stream.current = null;
    setMicReady(false);
    setSession(null);
    setPhase("idle");
  }

  const send = useCallback(
    async (body: Blob | string) => {
      if (!session) return;
      setPhase("thinking");
      setError(null);
      const res = await fetch(`/api/live/sessions/${encodeURIComponent(session.id)}/turn`, {
        method: "POST",
        headers: { "Content-Type": typeof body === "string" ? "application/json" : body.type || "audio/webm" },
        body: typeof body === "string" ? JSON.stringify({ text: body }) : body,
      });
      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        setError(detail.error ?? `The turn failed (${res.status}).`);
        setPhase("idle");
        if (res.status === 409)
          setSession((s) => (s ? { ...s, endedAt: new Date().toISOString(), endReason: detail.error } : s));
        return;
      }
      let agentLine = -1;
      await readEvents(res.body, (event, data) => {
        if (event === "transcript") {
          const text = String(data.text ?? "");
          setLines((l) => {
            const next = [...l, { who: "you" as const, text: text || "(nothing heard)" }];
            agentLine = next.length;
            return [...next, { who: "agent" as const, text: "" }];
          });
          if (!text) setPhase("idle");
        } else if (event === "text") {
          setLines((l) =>
            l.map((line, i) => (i === agentLine ? { ...line, text: line.text + String(data.delta ?? "") } : line)),
          );
        } else if (event === "audio") {
          player.push(String(data.data ?? ""), String(data.mimeType ?? "audio/mpeg"));
        } else if (event === "done") {
          const t = data.timings as Record<string, number> | undefined;
          if (t) {
            setTiming(
              [
                t.sttMs !== undefined && `heard in ${t.sttMs} ms`,
                t.firstAudioMs !== undefined && `first word at ${t.firstAudioMs} ms`,
              ]
                .filter(Boolean)
                .join(", "),
            );
          }
          setPhase((p) => (p === "thinking" ? "idle" : p));
        } else if (event === "error") {
          setError(String(data.message ?? "The turn failed."));
          setPhase("idle");
        }
      });
    },
    [session, player],
  );

  function hold() {
    if (!stream.current || phase === "listening" || session?.endedAt) return;
    player.stop();
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
  }

  function release() {
    if (recorder.current?.state === "recording") recorder.current.stop();
    recorder.current = null;
  }

  // Space to talk, like a walkie-talkie, unless the person is typing.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.closest("input, textarea, select");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && session && !typing(e)) {
        e.preventDefault();
        hold();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && session && !typing(e)) release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const label =
    phase === "listening"
      ? "Listening… let go to send"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "speaking"
          ? "Speaking… hold to cut in"
          : "Hold to talk";

  return (
    <div className="talk-page">
      <div className="tools-header">
        <div>
          <h2>Talk</h2>
          <p className="tools-subtitle">Speak with an agent out loud. Hold the button, or Space, while you talk.</p>
        </div>
      </div>
      {error && <div className="config-error">{error}</div>}
      {!session ? (
        <div className="talk-start">
          <label>
            Agent
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">default</option>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-primary" onClick={start}>
            Start talking
          </button>
        </div>
      ) : (
        <div className="talk-session">
          <div className="talk-meta">
            <span>{session.agent ?? "default"}</span>
            {session.endedAt ? (
              <span className="talk-ended">Ended: {session.endReason}</span>
            ) : (
              <span>
                ends after {session.limits.maxMinutes} min, or {session.limits.idleMinutes} min quiet
              </span>
            )}
            <button type="button" className="btn-secondary" onClick={end}>
              End
            </button>
          </div>
          <button
            type="button"
            className={`talk-button talk-${phase}`}
            disabled={!!session.endedAt || !micReady}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              hold();
            }}
            onPointerUp={release}
            onPointerCancel={release}
            aria-label={label}
          >
            <span className="talk-dot" aria-hidden="true" />
            {label}
          </button>
          {timing && <div className="talk-timing">{timing}</div>}
          <ol className="talk-lines" aria-live="polite">
            {lines.map((line, i) => (
              <li key={i} className={`talk-line talk-${line.who}`}>
                <span className="talk-who">{line.who === "you" ? "You" : (session.agent ?? "Agent")}</span>
                <span>{line.text || "…"}</span>
              </li>
            ))}
          </ol>
          <form
            className="talk-type"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim() && !session.endedAt) void send(typed.trim());
              setTyped("");
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Or type to it"
              aria-label="Type to the agent"
              disabled={!!session.endedAt}
            />
            <button type="submit" className="btn-secondary" disabled={!typed.trim() || !!session.endedAt}>
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/** Read a server-sent event stream from a fetch body, frame by frame. */
async function readEvents(
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

/** Plays audio chunks one after another, in the order they arrive. */
function useAudioQueue(onBusy: (busy: boolean) => void) {
  const queue = useRef<string[]>([]);
  const current = useRef<HTMLAudioElement | null>(null);
  const busy = useRef(false);
  const notify = useRef(onBusy);
  notify.current = onBusy;

  const next = useCallback(() => {
    const url = queue.current.shift();
    if (!url) {
      busy.current = false;
      current.current = null;
      notify.current(false);
      return;
    }
    busy.current = true;
    notify.current(true);
    const audio = new Audio(url);
    current.current = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      next();
    };
    audio.play().catch(() => next());
  }, []);

  return useRef({
    push(base64: string, mimeType: string) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      queue.current.push(URL.createObjectURL(new Blob([bytes], { type: mimeType })));
      if (!busy.current) next();
    },
    /** Stop speaking: the person has started talking. */
    stop() {
      current.current?.pause();
      for (const url of queue.current.splice(0)) URL.revokeObjectURL(url);
      busy.current = false;
      current.current = null;
      notify.current(false);
    },
  }).current;
}
