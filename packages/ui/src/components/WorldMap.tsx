import { useEffect, useMemo, useRef, useState } from "react";
import { type AgentActivity, hueFor } from "../avatar/doing";
import { nameOf } from "../lib/conversations";
import { subscribeStateChanges } from "../lib/state-events";

/** One place on the map, as `builtin:places` lists it. */
export interface MapPlace {
  id: string;
  name: string;
  kind: "lobby" | "home" | "shared" | "room";
  agents: string[];
  owner?: string;
  purpose?: string;
}

const SECTIONS: { kind: MapPlace["kind"]; title: string }[] = [
  { kind: "lobby", title: "Start here" },
  { kind: "room", title: "Rooms" },
  { kind: "shared", title: "Shared places" },
  { kind: "home", title: "Homes" },
];

/** A body's colour on the map, near enough to the colour it is drawn in. */
export function agentColor(agent: string): string {
  const hue = hueFor(agent);
  return `hsl(${(145 + (hue ?? 0)) % 360} 52% 52%)`;
}

/** A one-character mark for what an agent is doing, when it is worth a glance. */
const MARKS: Partial<Record<AgentActivity["doing"], string>> = {
  waiting: "!",
  stuck: "?",
  asleep: "z",
  working: "•",
  thinking: "…",
  talking: "…",
};

/** The places, asked for when the map opens and again whenever someone comes or goes. */
export function useWorldMap(open: boolean): { places: MapPlace[]; problem: string | null } {
  const [places, setPlaces] = useState<MapPlace[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    const load = () =>
      fetch("/api/ext/builtin:places/map")
        .then(async (res) => {
          if (!res.ok) throw new Error(`The map couldn't be loaded (${res.status}).`);
          return (await res.json()) as { places?: MapPlace[] };
        })
        .then((body) => {
          if (gone) return;
          setPlaces(body.places ?? []);
          setProblem(null);
        })
        .catch((err: unknown) => {
          if (!gone) setProblem(err instanceof Error ? err.message : String(err));
        });
    void load();
    const off = subscribeStateChanges((change) => {
      if (change.type === "whereabouts" || (change.type === "place" && change.id.startsWith("shared:"))) void load();
    });
    return () => {
      gone = true;
      off();
    };
  }, [open]);
  return { places, problem };
}

/**
 * Every place there is, to go to in one click: the rooms agents talk in, the
 * shared places, and each agent's home, with who is in each and a mark for
 * any who are waiting on you, stuck or asleep.
 */
export function WorldMap({
  places,
  problem,
  here,
  activities,
  onGo,
  onClose,
}: {
  places: MapPlace[];
  problem: string | null;
  /** The place on screen now. */
  here: string | undefined;
  activities: Record<string, AgentActivity>;
  onGo: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Claimed, so the chat page doesn't take the same Escape as stopping a reply.
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", key);
    box.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return places;
    return places.filter((p) => p.name.toLowerCase().includes(q) || p.agents.some((a) => a.toLowerCase().includes(q)));
  }, [places, query]);
  return (
    <div ref={box} className="world-map" role="dialog" aria-label="Map">
      <div className="world-map-head">
        <strong>Map</strong>
        <input
          type="search"
          value={query}
          placeholder="Find a place or an agent"
          aria-label="Find a place or an agent"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="world-map-close" aria-label="Close the map" onClick={onClose}>
          ×
        </button>
      </div>
      {problem && <p className="world-map-problem">{problem}</p>}
      <div className="world-map-body">
        {SECTIONS.map(({ kind, title }) => {
          const list = shown.filter((p) => p.kind === kind);
          if (!list.length) return null;
          return (
            <section key={kind} aria-label={title}>
              <h3>{title}</h3>
              <ul>
                {list.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`world-map-place world-map-${p.kind}${p.agents.length ? "" : " empty"}`}
                      aria-current={p.id === here ? "location" : undefined}
                      onClick={() => onGo(p.id)}
                    >
                      <span className="world-map-name">
                        {p.kind === "room" ? `#${p.name}` : p.name}
                        {p.id === here && <span className="world-map-here">you are here</span>}
                      </span>
                      {p.purpose && <span className="world-map-purpose">{p.purpose}</span>}
                      {p.kind === "lobby" && (
                        <span className="world-map-purpose">Make a new agent, task or room; see every open task</span>
                      )}
                      <span className="world-map-agents">
                        {p.agents.length === 0 && p.kind !== "lobby" && (
                          <span className="world-map-nobody">nobody here</span>
                        )}
                        {p.agents.map((a) => {
                          const doing = activities[a]?.doing;
                          const mark = doing ? MARKS[doing] : undefined;
                          return (
                            <span key={a} className={`world-map-agent${doing ? ` doing-${doing}` : ""}`}>
                              <span className="world-map-dot" style={{ background: agentColor(a) }} aria-hidden="true">
                                {mark}
                              </span>
                              {nameOf(a)}
                            </span>
                          );
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {!problem && shown.length === 0 && <p className="world-map-problem">Nothing matches "{query}".</p>}
      </div>
    </div>
  );
}
