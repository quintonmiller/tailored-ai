import { useEffect, useRef, useState } from "react";
import type { BodyState } from "./motion";
import type { Stage } from "./stage";

/**
 * The agent's body on the Talk page: a VRM model that breathes, leans in while
 * you talk, looks away while it thinks, and moves its mouth with its voice.
 * The 3D code loads only when this renders, so a page without an avatar never
 * downloads it.
 */
export function Avatar({ url, state, loudness }: { url: string; state: BodyState; loudness: () => number }) {
  const host = useRef<HTMLDivElement>(null);
  // The stage reads these every frame; a ref keeps that from re-rendering React.
  const live = useRef({ state, loudness });
  live.current = { state, loudness };
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let stage: Stage | undefined;
    let gone = false;
    setProblem(null);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    import("./stage")
      .then(({ createStage }) => createStage(el, url, () => live.current, { reducedMotion }))
      .then((s) => {
        if (gone) s.dispose();
        else stage = s;
      })
      .catch((err: unknown) => {
        if (!gone) setProblem(err instanceof Error ? err.message : String(err));
      });
    return () => {
      gone = true;
      stage?.dispose();
    };
  }, [url]);

  return (
    <>
      <div className="talk-avatar" ref={host} aria-hidden="true" hidden={!!problem} />
      {problem && <p className="talk-avatar-problem">Couldn't show the avatar: {problem}</p>}
    </>
  );
}
