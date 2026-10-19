import { useEffect, useState } from "react";
import { Avatar } from "../avatar/Avatar";
import type { Room } from "../avatar/scene";
import type { Companion } from "../avatar/stage";
import { companyOf, type PlaceInfo, roomOf } from "../components/ChatStage";

/**
 * A photo of an agent's room, for the server's camera: the stage alone, with
 * nothing of the app around it, the avatar holding still where it was asked
 * to be. `data-snapshot` says when the frame is worth taking ("ready"), or
 * that it can't be ("failed", with the reason as the text).
 *
 * `#/snapshot?agent=<name>&view=room|selfie&spot=<id>&gesture=<name>`
 */
export function Snapshot() {
  const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const agent = query.get("agent") || "default";
  const view = query.get("view") === "selfie" ? "close" : "room";
  const spot = query.get("spot") ?? undefined;
  const gesture = query.get("gesture") ?? undefined;
  const [scene, setScene] = useState<{
    avatar: string;
    animations: string[];
    room: Room;
    company: Companion[];
  } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [problem, setProblem] = useState("");

  useEffect(() => {
    const named = agent === "default" ? "" : `?agent=${encodeURIComponent(agent)}`;
    Promise.all([
      fetch(`/api/live${named}`).then((res) => (res.ok ? res.json() : {})),
      fetch(`/api/ext/builtin:places/${encodeURIComponent(agent)}`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null),
    ])
      .then(([live, here]: [{ avatar?: string; animations?: string[] }, PlaceInfo | null]) => {
        if (!live.avatar) throw new Error(`${agent} has no avatar.`);
        setScene({
          avatar: live.avatar,
          animations: live.animations ?? [],
          // With its doors, as the chat page draws it.
          room: roomOf(here),
          company: companyOf(here),
        });
      })
      .catch((err: unknown) => {
        setProblem(err instanceof Error ? err.message : String(err));
        setState("failed");
      });
  }, [agent]);

  return (
    <div className="snapshot-stage" data-snapshot={state}>
      {problem ||
        (scene && (
          <Avatar
            fill
            url={scene.avatar}
            animations={scene.animations}
            room={scene.room}
            company={scene.company}
            view={view}
            state="idle"
            loudness={() => 0}
            engaged={false}
            still={{ ...(spot ? { spot } : {}), ...(gesture ? { gesture } : {}) }}
            onReady={() => setState("ready")}
            onProblem={(reason) => {
              setProblem(reason);
              setState("failed");
            }}
          />
        ))}
    </div>
  );
}
