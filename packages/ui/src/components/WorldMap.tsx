import { useEffect, useMemo, useRef, useState } from "react";
import { type AgentActivity, hueFor } from "../avatar/doing";
import { nameOf } from "../lib/conversations";
import { subscribeStateChanges } from "../lib/state-events";
import { areaTitle, MAIN, type MapArea, type MapPlace, mapIndex, placeTitle } from "../lib/wayfinding";

export type { MapArea, MapPlace } from "../lib/wayfinding";

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

/** How much a doing asks of you, most first: waiting on you, stuck, then at work. Idle and asleep aren't busy. */
const URGENCY: Partial<Record<AgentActivity["doing"], number>> = {
  waiting: 0,
  stuck: 1,
  talking: 2,
  working: 3,
  thinking: 4,
};

/** A doing in the word a place's mark uses. */
const BUSY_WORDS: Partial<Record<AgentActivity["doing"], string>> = {
  waiting: "waiting on you",
  stuck: "stuck",
  talking: "talking",
  working: "working",
  thinking: "thinking",
};

/** Someone busy, what at, and the place their body is in. */
export interface Busy {
  agent: string;
  activity: AgentActivity;
  place: MapPlace;
}

/**
 * Everyone busy, with the place their body is in, so you can go straight to
 * them: waiting on you first, then stuck, then talking, working and thinking.
 * Only bodies on the map: an agent without one is nowhere to go to.
 */
export function busyAgents(places: MapPlace[], activities: Record<string, AgentActivity>): Busy[] {
  const out: Busy[] = [];
  const seen = new Set<string>();
  for (const place of places)
    for (const agent of place.agents) {
      const activity = activities[agent];
      if (seen.has(agent) || !activity || URGENCY[activity.doing] === undefined) continue;
      seen.add(agent);
      out.push({ agent, activity, place });
    }
  const rank = (b: Busy) => URGENCY[b.activity.doing] ?? 9;
  return out.sort((a, b) => rank(a) - rank(b) || a.agent.localeCompare(b.agent));
}

/**
 * What is happening in a place, for its mark: the most pressing doing there,
 * how many are doing it, and how many others are busy with something else;
 * none when all are idle.
 */
export function busyMark(
  place: MapPlace,
  activities: Record<string, AgentActivity>,
): { doing: AgentActivity["doing"]; count: number; others: number } | undefined {
  const busy = place.agents.flatMap((a) => {
    const doing = activities[a]?.doing;
    return doing && URGENCY[doing] !== undefined ? [doing] : [];
  });
  if (!busy.length) return undefined;
  const doing = busy.sort((a, b) => (URGENCY[a] ?? 9) - (URGENCY[b] ?? 9))[0];
  const count = busy.filter((d) => d === doing).length;
  return { doing, count, others: busy.length - count };
}

/** A place's mark in words: "waiting on you", "2 working", "waiting on you · 2 more busy". */
export function markWords(mark: { doing: AgentActivity["doing"]; count: number; others: number }): string {
  const word = BUSY_WORDS[mark.doing] ?? mark.doing;
  return `${mark.count > 1 ? `${mark.count} ` : ""}${word}${mark.others ? ` · ${mark.others} more busy` : ""}`;
}

/** A change to where a body is: where an agent lives (`whereabouts`), or a meeting room it is visiting (`visit`). */
export const comeOrGone = (type: string) => type === "whereabouts" || type === "visit";

/** The places and areas, asked for when the map opens and again whenever someone comes or goes. */
export function useWorldMap(open: boolean): { places: MapPlace[]; areas: MapArea[]; problem: string | null } {
  const [places, setPlaces] = useState<MapPlace[]>([]);
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    const load = () =>
      fetch("/api/ext/builtin:places/map")
        .then(async (res) => {
          if (!res.ok) throw new Error(`The map couldn't be loaded (${res.status}).`);
          return (await res.json()) as { places?: MapPlace[]; areas?: MapArea[] };
        })
        .then((body) => {
          if (gone) return;
          setPlaces(body.places ?? []);
          setAreas(body.areas ?? []);
          setProblem(null);
        })
        .catch((err: unknown) => {
          if (!gone) setProblem(err instanceof Error ? err.message : String(err));
        });
    void load();
    const off = subscribeStateChanges((change) => {
      // Someone came or went, a shared place came or went, or a place moved to another area.
      const moved = change.type === "place" && change.before?.area !== change.after?.area;
      if (comeOrGone(change.type) || moved || (change.type === "place" && change.id.startsWith("shared:"))) void load();
    });
    return () => {
      gone = true;
      off();
    };
  }, [open]);
  return { places, areas, problem };
}

/** A doing in a word or two, for an agent's line on the map. */
const STATE_WORDS: Record<AgentActivity["doing"], string> = {
  waiting: "waiting on you",
  stuck: "stuck",
  talking: "talking",
  working: "working",
  thinking: "thinking",
  asleep: "asleep",
  idle: "idle",
};

/**
 * Every place there is, to go to in one click, laid out for finding someone:
 * who is busy first, with where each of them is; then every agent, coloured
 * by what it is doing, whose home a click goes to (and where its body is, when
 * that is somewhere else); then the rooms agents talk in, the shared places,
 * and the other areas. The lobby and the halls between places come last,
 * folded away until asked for. Typing filters all of it, and Enter goes to the
 * first thing left.
 */
export function WorldMap({
  places,
  areas = [],
  problem,
  here,
  activities,
  onGo,
  onClose,
}: {
  places: MapPlace[];
  /** The areas, the main building first; without them, every place is in the main building. */
  areas?: MapArea[];
  problem: string | null;
  /** The place on screen now. */
  here: string | undefined;
  activities: Record<string, AgentActivity>;
  onGo: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hallsOpen, setHallsOpen] = useState(false);
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
  const searching = !!query.trim();
  const index = useMemo(() => {
    // Where something is happening first; the rest as they came.
    const rank = (p: MapPlace) => {
      const mark = busyMark(p, activities);
      return mark ? (URGENCY[mark.doing] ?? 9) : 10;
    };
    return mapIndex(places, areas, activities, query, rank);
  }, [places, areas, activities, query]);
  const busy = useMemo(() => busyAgents(places, activities), [places, activities]);
  // A place alone in an area of its own has no doors: worth saying, or it looks like a room you can't leave.
  const where = places.find((p) => p.id === here);
  const lone = where && (where.area ?? MAIN) !== MAIN && places.filter((p) => p.area === where.area).length === 1;
  const lonely = lone ? areas.find((a) => a.id === where.area) : undefined;
  const first = (id: string) => (searching && id === index.first ? " first" : "");
  const current = (id: string) => (id === here ? "location" : undefined);

  const tile = (p: MapPlace) => {
    const mark = busyMark(p, activities);
    return (
      <li key={p.id}>
        <button
          type="button"
          className={`world-map-place world-map-${p.kind}${p.agents.length ? "" : " empty"}${mark ? ` busy busy-${mark.doing}` : ""}${first(p.id)}`}
          aria-current={current(p.id)}
          onClick={() => onGo(p.id)}
        >
          <span className="world-map-name">
            {p.kind === "room" ? `#${p.name}` : p.name}
            {p.id === here && <span className="world-map-here">you are here</span>}
          </span>
          {mark && <span className={`world-map-mark doing-${mark.doing}`}>{markWords(mark)}</span>}
          {p.purpose && <span className="world-map-purpose">{p.purpose}</span>}
          {p.kind === "lobby" && (
            <span className="world-map-purpose">Make a new agent, task or room; see every open task</span>
          )}
          {p.kind !== "hall" && p.kind !== "lobby" && (
            <span className="world-map-agents">
              {p.agents.length === 0 && (
                <span className="world-map-nobody">
                  {p.kind === "room" && p.members?.length
                    ? `quiet · ${p.members.length === 1 ? "1 member" : `${p.members.length} members`}`
                    : "nobody here"}
                </span>
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
          )}
        </button>
      </li>
    );
  };
  const section = (title: string, items: MapPlace[]) =>
    items.length > 0 && (
      <section aria-label={title}>
        <h3>{title}</h3>
        <ul>{items.map(tile)}</ul>
      </section>
    );
  const anything =
    index.agents.length +
      index.rooms.length +
      index.shared.length +
      index.areas.length +
      index.halls.length +
      (index.lobby ? 1 : 0) >
    0;

  return (
    <div ref={box} className="world-map" role="dialog" aria-label="Map">
      <div className="world-map-head">
        <strong>Map</strong>
        <input
          type="search"
          value={query}
          placeholder="Find an agent, a room or a place"
          aria-label="Find an agent, a room or a place"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter goes to the first thing the search has left.
            if (e.key !== "Enter" || !searching || !index.first) return;
            e.preventDefault();
            onGo(index.first);
          }}
        />
        <button type="button" className="world-map-close" aria-label="Close the map" onClick={onClose}>
          ×
        </button>
      </div>
      {problem && <p className="world-map-problem">{problem}</p>}
      {lonely && (
        <p className="world-map-area-here">
          You're in {lonely.name}. Nothing else is there yet, so it has no doors; other areas are a click away here.
        </p>
      )}
      <div className="world-map-body">
        {!searching && places.length > 0 && (
          <section aria-label="Busy now" className="world-map-busy-list">
            <h3>Busy now</h3>
            {busy.length === 0 ? (
              <p className="world-map-quiet">Nobody is busy right now: every agent is idle or asleep.</p>
            ) : (
              <ul>
                {busy.map((b) => (
                  <li key={b.agent}>
                    <button
                      type="button"
                      className={`world-map-busy doing-${b.activity.doing}`}
                      aria-current={current(b.place.id)}
                      onClick={() => onGo(b.place.id)}
                    >
                      <span className="world-map-dot" style={{ background: agentColor(b.agent) }} aria-hidden="true">
                        {MARKS[b.activity.doing]}
                      </span>
                      <span className="world-map-busy-who">{nameOf(b.agent)}</span>
                      <span className="world-map-busy-what">
                        {b.activity.what}
                        {b.activity.detail ? ` · ${b.activity.detail}` : ""}
                      </span>
                      <span className="world-map-busy-where">
                        {b.place.id === here
                          ? "here"
                          : b.place.kind === "room"
                            ? `in #${b.place.name}`
                            : b.place.kind === "home" && b.place.owner === b.agent
                              ? "at home"
                              : `in ${b.place.name}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {index.agents.length > 0 && (
          <section aria-label="Agents" className="world-map-people">
            <h3>Agents</h3>
            <ul>
              {index.agents.map(({ agent, home, away, activity }) => {
                const doing = activity?.doing ?? "idle";
                return (
                  <li key={agent} className="world-map-person">
                    <button
                      type="button"
                      className={`world-map-who doing-${doing}${first(home.id)}`}
                      aria-current={current(home.id)}
                      title={`Go to ${placeTitle(home)}`}
                      onClick={() => onGo(home.id)}
                    >
                      <span className="world-map-state" aria-hidden="true" />
                      <span className="world-map-who-name">{nameOf(agent)}</span>
                      <span className="world-map-who-doing">{STATE_WORDS[doing]}</span>
                    </button>
                    {away && (
                      <button
                        type="button"
                        className="world-map-away"
                        aria-current={current(away.id)}
                        title={`Go to ${placeTitle(away)}, where ${nameOf(agent)} is`}
                        onClick={() => onGo(away.id)}
                      >
                        in {placeTitle(away)}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {section("Meeting rooms", index.rooms)}
        {section("Shared places", index.shared)}
        {index.areas.length > 0 && (
          <section aria-label="Other areas">
            <h3>Other areas</h3>
            <ul>
              {index.areas.map(({ area, way, places: there }) => (
                <li key={area.id}>
                  <button
                    type="button"
                    className={`world-map-place world-map-area-go${first(way)}`}
                    aria-current={there.some((p) => p.id === here) ? "location" : undefined}
                    onClick={() => onGo(way)}
                  >
                    <span className="world-map-name">
                      {areaTitle(area.name)}
                      {there.some((p) => p.id === here) && <span className="world-map-here">you are here</span>}
                    </span>
                    <span className="world-map-purpose">{there.map(placeTitle).join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {section("Lobby", index.lobby ? [index.lobby] : [])}
        {index.halls.length > 0 && (
          <section aria-label="Halls" className="world-map-halls">
            <button
              type="button"
              className="world-map-fold"
              aria-expanded={searching || hallsOpen}
              onClick={() => setHallsOpen(!hallsOpen)}
            >
              <span aria-hidden="true">{searching || hallsOpen ? "▾" : "▸"}</span> Halls
              <span className="world-map-count">{index.halls.length}</span>
            </button>
            {(searching || hallsOpen) && <ul>{index.halls.map(tile)}</ul>}
          </section>
        )}
        {!problem && places.length > 0 && !anything && <p className="world-map-problem">Nothing matches "{query}".</p>}
      </div>
    </div>
  );
}
