import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { Cue } from "./cues";
import type { BodyState } from "./motion";
import type { Stage, StageView } from "./stage";

const VIEW_KEY = "tai.talk.avatarView";

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
}) {
  const host = useRef<HTMLDivElement>(null);
  // The stage reads these every frame; a ref keeps that from re-rendering React.
  const live = useRef({ state, loudness, engaged });
  live.current = { state, loudness, engaged };
  const stage = useRef<Stage | null>(null);
  const [view, setView] = useState<StageView>(savedView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const insetRef = useRef(insetRight);
  insetRef.current = insetRight;
  useEffect(() => {
    stage.current?.setInsets({ right: insetRight });
  }, [insetRight]);
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
          view: viewRef.current,
          animations: animationsRef.current,
        }),
      )
      .then((s) => {
        if (gone) {
          s.dispose();
          return;
        }
        stage.current = s;
        s.setInsets({ right: insetRef.current });
        if (controlsRef.current) controlsRef.current.current = { cue: (c) => s.cue(c) };
      })
      .catch((err: unknown) => {
        if (!gone) setProblem(err instanceof Error ? err.message : String(err));
      });
    return () => {
      gone = true;
      stage.current?.dispose();
      stage.current = null;
      if (controlsRef.current) controlsRef.current.current = null;
    };
  }, [url, animationsKey]);

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
      <fieldset className="talk-view" aria-label="Avatar view">
        {(["room", "close"] as const).map((v) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => choose(v)}>
            {v === "room" ? "Room" : "Close up"}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
