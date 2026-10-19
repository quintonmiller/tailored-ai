import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, type AvatarControls } from "../avatar/Avatar";
import type { Cue } from "../avatar/cues";
import type { BodyState } from "../avatar/motion";
import { bodyFor, DEFAULT_ROOM, type Room } from "../avatar/scene";
import { subscribeStateChanges } from "../lib/state-events";
import { useVoice } from "./voice";

/**
 * The chat page's scene and voice: the agent's 3D body behind the
 * conversation when it has one, and hold-to-talk into the same
 * conversation. Typed and spoken turns are one history.
 */

const STAGE_KEY = "tai.chat.stage";
/** How wide the chat panel laid over the scene is, on a screen wide enough for one. */
export const PANEL_WIDTH = 440;
/**
 * How long a conversation counts as going on after its last turn. While it
 * does, the avatar stays where it is (or where it was sent) instead of
 * wandering; the first turn after a quiet spell calls it over to face you.
 */
export const CONVERSING_MS = 3 * 60_000;

function saved(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "on";
  } catch {
    return fallback;
  }
}

function remember(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // A convenience: without storage the choice resets next time.
  }
}

/**
 * The agent's room as the server keeps it, a `place` record the agent can
 * change with its `place` tool, redrawn the moment it does. The built-in
 * room until it arrives, and when the server keeps none.
 */
export function useRoom(agent: string, enabled: boolean): Room {
  const [room, setRoom] = useState<Room>(DEFAULT_ROOM);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    let id: string | undefined;
    const load = () =>
      fetch(`/api/ext/builtin:places/${encodeURIComponent(agent || "default")}`)
        .then((res) => (res.ok ? (res.json() as Promise<{ id?: string; place?: Room }>) : null))
        .then((body) => {
          if (gone) return;
          id = body?.id;
          setRoom(body?.place ?? DEFAULT_ROOM);
        })
        .catch(() => {
          if (!gone) setRoom(DEFAULT_ROOM);
        });
    void load();
    const off = subscribeStateChanges((change) => {
      if (change.type !== "place" || !id || change.id !== id) return;
      if (change.op === "delete" || !change.after) void load();
      else setRoom(change.after as unknown as Room);
    });
    return () => {
      gone = true;
      off();
    };
  }, [agent, enabled]);
  return room;
}

interface LiveInfo {
  enabled?: boolean;
  avatar?: string;
  animations?: string[];
}

export interface ChatStageOptions {
  agent: string;
  /** The conversation on the page; undefined for a new chat. */
  sessionKey: string | undefined;
  /** A typed turn is in flight. */
  sending: boolean;
  /** The chat panel is open over the scene. */
  panelOpen: boolean;
  /** A spoken turn finished in this conversation: show it with the rest. */
  onSpoken: (conversation: string | undefined, sessionKey: string) => void;
  /** Hand typed turns the body and a place for their cues, while the body is on screen. */
  setTurnExtras?: (extras: { body?: unknown; onCue?: (cue: { name: string; target?: string }) => void }) => void;
}

export function useChatStage({ agent, sessionKey, sending, panelOpen, onSpoken, setTurnExtras }: ChatStageOptions) {
  const [info, setInfo] = useState<LiveInfo>({});
  useEffect(() => {
    let gone = false;
    fetch(`/api/live${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`)
      .then((res) => (res.ok ? (res.json() as Promise<LiveInfo>) : {}))
      .then((body) => {
        if (!gone) setInfo(body ?? {});
      })
      .catch(() => {
        if (!gone) setInfo({});
      });
    return () => {
      gone = true;
    };
  }, [agent]);

  const [stageOn, setStageOn] = useState(() => saved(STAGE_KEY, true));
  const has3d = typeof info.avatar === "string";
  const showStage = has3d && stageOn;
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 720px)").matches ?? true);
  useEffect(() => {
    const q = window.matchMedia?.("(min-width: 720px)");
    if (!q) return;
    const on = () => setWide(q.matches);
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []);

  const room = useRoom(agent, has3d);
  // What the body can do in this room: its moves, and the things it can go to, look at and point at.
  const body = useMemo(() => bodyFor(room), [room]);

  const controls = useRef<AvatarControls | null>(null);
  // The conversation a voice session talks in. A new chat gets a key on its
  // first spoken turn; the chat adopts it, so what is typed next joins it.
  const minted = useRef<string | null>(null);
  const inUse = useRef<string | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const [replying, setReplying] = useState("");
  const keyFor = () => {
    const key = sessionKey ?? (minted.current ??= `web:${Date.now()}`);
    inUse.current = key;
    return key;
  };

  const voice = useVoice({
    agent: agent || undefined,
    sessionKey: keyFor,
    body: showStage ? body : undefined,
    measure: showStage,
    onCue: (cue) => controls.current?.cue(cue),
    onHeard: (text) => {
      setHeard(text || null);
      setReplying("");
    },
    onText: (delta) => setReplying((r) => r + delta),
    onDone: (turn) => {
      const key = inUse.current ?? keyFor();
      setHeard(null);
      setReplying("");
      if (turn.transcript) onSpoken(turn.conversation, key);
    },
  });

  // Typed turns move the body too, while it is on screen: same cues as talking.
  useEffect(() => {
    if (!setTurnExtras) return;
    setTurnExtras(showStage ? { body, onCue: (cue) => controls.current?.cue(cue) } : {});
    return () => setTurnExtras({});
  }, [showStage, setTurnExtras, body]);

  // Another conversation on the page, or a new chat: the voice session is for the old one.
  const end = voice.end;
  useEffect(() => {
    if (sessionKey === undefined) {
      minted.current = null;
      if (inUse.current) end();
      inUse.current = null;
    } else if (inUse.current && sessionKey !== inUse.current) {
      end();
      inUse.current = null;
    }
  }, [sessionKey, end]);

  // Space to talk, like a walkie-talkie, unless the person is typing.
  const { hold, release } = voice;
  useEffect(() => {
    if (!info.enabled) return;
    const typing = (e: KeyboardEvent) =>
      (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !typing(e)) {
        e.preventDefault();
        void hold();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e)) release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [info.enabled, hold, release]);

  // Talking or typing keeps the conversation going for a while after.
  const busy = voice.active || sending || voice.phase !== "idle";
  const [conversing, setConversing] = useState(false);
  useEffect(() => {
    if (busy) {
      setConversing(true);
      return;
    }
    const quiet = setTimeout(() => setConversing(false), CONVERSING_MS);
    return () => clearTimeout(quiet);
  }, [busy]);

  // A quiet moment, while the page is in view: the agent chooses what it does.
  const chooseIdle = useCallback(
    async (here: string | undefined, hour: number): Promise<Cue[]> => {
      if (document.visibilityState === "hidden") return [];
      const res = await fetch("/api/live/idle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(agent ? { agent } : {}), body, here, hour }),
      });
      if (!res.ok) throw new Error(`idle choice failed (${res.status})`);
      const data = (await res.json()) as { cues?: Cue[] };
      return Array.isArray(data.cues) ? data.cues : [];
    },
    [agent, body],
  );

  const state: BodyState = voice.phase !== "idle" ? voice.phase : sending ? "thinking" : "idle";
  const stage: ReactNode =
    showStage && info.avatar ? (
      <Avatar
        fill
        url={info.avatar}
        animations={info.animations ?? []}
        state={state}
        loudness={voice.loudness}
        engaged={busy || conversing}
        controls={controls}
        insetRight={panelOpen && wide ? PANEL_WIDTH : 0}
        room={room}
        {...(info.enabled ? { chooseIdle } : {})}
      />
    ) : null;

  return {
    has3d,
    stageOn,
    showStage,
    setStageOn: (on: boolean) => {
      setStageOn(on);
      remember(STAGE_KEY, on);
    },
    stage,
    voiceEnabled: !!info.enabled,
    voice,
    /** A spoken turn in progress: what was heard, and the reply so far. */
    spoken: heard === null ? null : { heard, replying },
  };
}

/** Hold to talk: press and speak, let go to send. Space works too, when not typing. */
export function TalkButton({ voice }: { voice: ReturnType<typeof useVoice> }) {
  const label =
    voice.phase === "listening"
      ? "Listening… let go to send"
      : voice.phase === "thinking"
        ? "Thinking…"
        : voice.phase === "speaking"
          ? "Speaking… hold to cut in"
          : "Hold to talk";
  return (
    <button
      type="button"
      className={`chat-talk-btn chat-talk-${voice.phase}`}
      aria-label={label}
      title="Hold to talk (or hold Space)"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        void voice.hold();
      }}
      onPointerUp={voice.release}
      onPointerCancel={voice.release}
    >
      <span className="chat-talk-dot" aria-hidden="true" />
      <span className="chat-talk-label">{voice.phase === "idle" ? "Talk" : label}</span>
    </button>
  );
}
