import { type MutableRefObject, type ReactNode, useEffect, useRef, useState } from "react";
import type { BoardTask } from "./boards";
import type { Cue } from "./cues";
import type { AgentActivity } from "./doing";
import type { BodyState } from "./motion";
import type { Room } from "./scene";
import type { Companion, Line, Stage, StageView, Travel } from "./stage";

const VIEW_KEY = "tai.talk.avatarView";

/** One thing the menu on an agent's body offers. */
export interface AgentAction {
  label: string;
  run: () => void | Promise<void>;
}

/** What the page can tell the avatar to do once it is on screen. */
export interface AvatarControls {
  cue(cue: Cue): void;
}

function savedView(): StageView {
  try {
    return localStorage.getItem(VIEW_KEY) === "close" ? "close" : "room";
  } catch {
    return "room";
  }
}

/**
 * The agent's body on the Talk page, in a small room: it breathes, leans in
 * while you talk, looks away while it thinks, and moves its mouth with its
 * voice. Between sessions it wanders the room; click furniture to send it
 * there. Drag to look around, or switch to a close-up. The 3D code
 * loads only when this renders, so a page without an avatar never downloads
 * it.
 */
export function Avatar({
  url,
  animations = [],
  state,
  loudness,
  engaged,
  controls,
  fill = false,
  insetRight = 0,
  chooseIdle,
  room,
  company,
  still,
  onReady,
  onProblem,
  view: fixedView,
  agent,
  activities,
  speech,
  menuFor,
  visitor = false,
  onNear,
  tools,
  overlay,
  tasks,
  onUse,
}: {
  url: string;
  /** Animation libraries for the avatar; it moves by code until they load. */
  animations?: string[];
  state: BodyState;
  loudness: () => number;
  /** A session is under way: the avatar stays put and faces you instead of wandering. */
  engaged: boolean;
  /** Filled in once the avatar is on screen, so the page can pass on the agent's cues. */
  controls?: MutableRefObject<AvatarControls | null>;
  /** Fill the container instead of sitting in a box on the page: the scene behind a chat. */
  fill?: boolean;
  /** Pixels of the right side covered by something laid over the scene; the camera frames what is left. */
  insetRight?: number;
  /** Ask the agent what it does with a quiet moment; without it, the avatar wanders at random. */
  chooseIdle?: (here: string | undefined, hour: number) => Promise<Cue[]>;
  /** The room it lives in; a new one is shown as it changes, without rebuilding the stage. */
  room?: Room;
  /** Others in the room, each with a body of their own. */
  company?: Companion[];
  /** Hold still for a photo, at a spot, striking a gesture; the view toggle is hidden. */
  still?: { spot?: string; gesture?: string };
  /** A still avatar is ready to photograph. */
  onReady?: () => void;
  /** It couldn't be shown, and why. */
  onProblem?: (reason: string) => void;
  /** Show this view and offer no toggle, instead of the one the person last chose. */
  view?: StageView;
  /** The agent whose body this is: its colour, and which activity is its own. */
  agent?: string;
  /** What each agent is doing, by agent; every body in the room shows its own. */
  activities?: Record<string, AgentActivity>;
  /** The last thing each agent said, by agent; a new line shows in a bubble. */
  speech?: Record<string, Line>;
  /** What clicking an agent's body offers; without it, bodies aren't clickable. */
  menuFor?: (agent: string) => AgentAction[];
  /** The body is the visitor's own: walked with the keys, or put away to fly. */
  visitor?: boolean;
  /** The agent a visitor is standing next to, as it changes. */
  onNear?: (agent: string | undefined) => void;
  /** Controls laid over the top left of the stage. */
  tools?: ReactNode;
  /** Something laid over the whole stage, like a map. */
  overlay?: ReactNode;
  /** What the task boards on the walls show. */
  tasks?: BoardTask[];
  /** A kiosk or a board was clicked: what it does. */
  onUse?: (action: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // The stage reads these every frame; a ref keeps that from re-rendering React.
  const live = useRef({ state, loudness, engaged });
  live.current = { state, loudness, engaged };
  const stage = useRef<Stage | null>(null);
  const [view, setView] = useState<StageView>(() => fixedView ?? savedView());
  const viewRef = useRef(view);
  viewRef.current = view;
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const chooseRef = useRef(chooseIdle);
  chooseRef.current = chooseIdle;
  const choosing = !!chooseIdle;
  const insetRef = useRef(insetRight);
  insetRef.current = insetRight;
  useEffect(() => {
    stage.current?.setInsets({ right: insetRight });
  }, [insetRight]);
  const stillRef = useRef({ still, onReady, onProblem });
  stillRef.current = { still, onReady, onProblem };
  const companyRef = useRef(company);
  companyRef.current = company;
  const companyKey = JSON.stringify(company ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key says when the company changed; the ref holds it.
  useEffect(() => {
    stage.current?.setCompany(companyRef.current ?? []);
  }, [companyKey]);
  const activitiesRef = useRef(activities);
  activitiesRef.current = activities;
  useEffect(() => {
    if (activities) stage.current?.setActivities(activities);
  }, [activities]);
  const speechRef = useRef(speech);
  speechRef.current = speech;
  useEffect(() => {
    if (speech) stage.current?.setSpeech(speech);
  }, [speech]);
  const menuRef = useRef(menuFor);
  menuRef.current = menuFor;
  const picking = !!menuFor;
  const [picked, setPicked] = useState<{ agent: string; x: number; y: number } | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(() => {
    if (tasks) stage.current?.setTasks(tasks);
  }, [tasks]);
  const onUseRef = useRef(onUse);
  onUseRef.current = onUse;
  const nearRef = useRef(onNear);
  nearRef.current = onNear;
  const [travel, setTravel] = useState<Travel>("walk");
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const roomRef = useRef(room);
  roomRef.current = room;
  useEffect(() => {
    if (room) stage.current?.setRoom(room);
  }, [room]);
  const animationsRef = useRef(animations);
  animationsRef.current = animations;
  const animationsKey = animations.join("\n");
  const [problem, setProblem] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new animation list rebuilds the stage; the effect reads it through a ref.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let gone = false;
    setProblem(null);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    import("./stage")
      .then(({ createStage }) =>
        createStage(el, url, () => live.current, {
          reducedMotion,
          view: visitor ? "room" : viewRef.current,
          animations: animationsRef.current,
          ...(roomRef.current ? { room: roomRef.current } : {}),
          ...(companyRef.current?.length ? { company: companyRef.current } : {}),
          ...(agentRef.current ? { agent: agentRef.current } : {}),
          ...(visitor ? { visitor: true, onNear: (who: string | undefined) => nearRef.current?.(who) } : {}),
          onUse: (action: string) => onUseRef.current?.(action),
          ...(picking
            ? {
                onPick: (who: string, at: { x: number; y: number }) => {
                  const box = host.current?.getBoundingClientRect();
                  const w = box?.width ?? 0;
                  const h = box?.height ?? 0;
                  // Below the click, kept inside the stage.
                  const x = Math.min(Math.max(at.x - (box?.left ?? 0), 130), Math.max(130, w - 130));
                  const y = Math.min(at.y - (box?.top ?? 0) + 10, Math.max(10, h - 220));
                  setPicked({ agent: who, x, y });
                },
              }
            : {}),
          ...(stillRef.current.still
            ? { still: stillRef.current.still, onReady: () => stillRef.current.onReady?.() }
            : {}),
          // Through the ref: the page's latest way to ask, without rebuilding the stage.
          ...(choosing
            ? {
                chooseIdle: (here: string | undefined, hour: number) =>
                  chooseRef.current?.(here, hour) ?? Promise.resolve([]),
              }
            : {}),
        }),
      )
      .then((s) => {
        if (gone) {
          s.dispose();
          return;
        }
        stage.current = s;
        if (controlsRef.current) controlsRef.current.current = { cue: (c) => s.cue(c) };
        s.setInsets({ right: insetRef.current });
        // The room, or who is in it, may have arrived or changed while the stage was loading.
        if (roomRef.current) s.setRoom(roomRef.current);
        s.setCompany(companyRef.current ?? []);
        if (activitiesRef.current) s.setActivities(activitiesRef.current);
        if (speechRef.current) s.setSpeech(speechRef.current);
        if (tasksRef.current) s.setTasks(tasksRef.current);
      })
      .catch((err: unknown) => {
        if (gone) return;
        const reason = err instanceof Error ? err.message : String(err);
        setProblem(reason);
        stillRef.current.onProblem?.(reason);
      });
    return () => {
      gone = true;
      stage.current?.dispose();
      stage.current = null;
      if (controlsRef.current) controlsRef.current.current = null;
    };
  }, [url, animationsKey, choosing, picking, visitor]);
  useEffect(() => {
    if (visitor) setTravel("walk");
  }, [visitor]);

  const choose = (next: StageView) => {
    setView(next);
    stage.current?.setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Remembering the view is a convenience; without storage it just resets.
    }
  };

  if (problem) return <p className="talk-avatar-problem">Couldn't show the avatar: {problem}</p>;
  return (
    <div className={fill ? "talk-stage fill" : "talk-stage"}>
      <div
        className="talk-avatar"
        ref={host}
        aria-hidden="true"
        title="Drag to look around. Click furniture to send it there."
      />
      {picked && (
        <AgentMenu
          agent={picked.agent}
          at={picked}
          activity={activities?.[picked.agent]}
          actions={menuRef.current?.(picked.agent) ?? []}
          onClose={() => setPicked(null)}
        />
      )}
      {tools && <div className="talk-tools">{tools}</div>}
      {overlay}
      {visitor && (
        <>
          <fieldset className="talk-view" aria-label="How you get around">
            {(["walk", "fly"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={travel === t}
                onClick={() => {
                  setTravel(t);
                  stage.current?.setTravel(t);
                }}
              >
                {t === "walk" ? "Walk" : "Fly"}
              </button>
            ))}
          </fieldset>
          <p className="talk-keys">
            {travel === "walk"
              ? "WASD or arrows to walk · click the floor to go there · drag to look round"
              : "WASD to fly · E up, Q down · drag to turn · wheel to zoom"}
          </p>
        </>
      )}
      {!fixedView && !visitor && (
        <fieldset className="talk-view" aria-label="Avatar view">
          {(["room", "close"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => choose(v)}>
              {v === "room" ? "Room" : "Close up"}
            </button>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** Seconds, minutes or hours since, in a few words. */
function since(at: string | undefined): string | undefined {
  const ms = at ? Date.now() - Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `for ${Math.round(ms / 60_000)} min`;
  return `for ${Math.round(ms / 3_600_000)} h`;
}

/**
 * What clicking an agent's body opens: who it is, what it is doing and since
 * when, and what you can do about it. Escape or a click elsewhere closes it.
 */
function AgentMenu({
  agent,
  at,
  activity,
  actions,
  onClose,
}: {
  agent: string;
  at: { x: number; y: number };
  activity: AgentActivity | undefined;
  actions: AgentAction[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", away);
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", away);
    };
  }, [onClose]);
  const status = activity && activity.doing !== "idle" ? activity.what : "idle";
  const when = activity?.doing !== "idle" ? since(activity?.since) : undefined;
  return (
    <div
      ref={box}
      className="agent-menu"
      role="dialog"
      aria-label={`${agent === "default" ? "This agent" : agent}: what you can do`}
      style={{ left: at.x, top: at.y }}
    >
      <div className="agent-menu-head">
        <strong>{agent === "default" ? "Default agent" : agent}</strong>
        <span className={`agent-menu-status agent-menu-${activity?.doing ?? "idle"}`}>
          {status}
          {activity?.detail ? ` · ${activity.detail}` : ""}
          {when ? ` · ${when}` : ""}
        </span>
      </div>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              await a.run();
              onClose();
            } catch (err) {
              setProblem(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          {a.label}
        </button>
      ))}
      {problem && <p className="agent-menu-problem">{problem}</p>}
    </div>
  );
}
