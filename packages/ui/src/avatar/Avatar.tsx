import { useEffect, useRef, useState } from "react";
import type { BodyState } from "./motion";
import type { Stage, StageView } from "./stage";

const VIEW_KEY = "tai.talk.avatarView";

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
  state,
  loudness,
  engaged,
}: {
  url: string;
  state: BodyState;
  loudness: () => number;
  /** A session is under way: the avatar stays put and faces you instead of wandering. */
  engaged: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  // The stage reads these every frame; a ref keeps that from re-rendering React.
  const live = useRef({ state, loudness, engaged });
  live.current = { state, loudness, engaged };
  const stage = useRef<Stage | null>(null);
  const [view, setView] = useState<StageView>(savedView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let gone = false;
    setProblem(null);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    import("./stage")
      .then(({ createStage }) => createStage(el, url, () => live.current, { reducedMotion, view: viewRef.current }))
      .then((s) => {
        if (gone) s.dispose();
        else stage.current = s;
      })
      .catch((err: unknown) => {
        if (!gone) setProblem(err instanceof Error ? err.message : String(err));
      });
    return () => {
      gone = true;
      stage.current?.dispose();
      stage.current = null;
    };
  }, [url]);

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
    <div className="talk-stage">
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
