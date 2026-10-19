import { useEffect, useMemo, useRef, useState } from "react";
import { type AgentActivity, hueFor } from "../avatar/doing";
import { nameOf } from "../lib/conversations";
import { subscribeStateChanges } from "../lib/state-events";

/** One place on the map, as `builtin:places` lists it. */
export interface MapPlace {
  id: string;
  name: string;
  kind: "lobby" | "hall" | "home" | "shared" | "room";
  agents: string[];
  /** The area it is in, by id: `main` for the main building. */
  area?: string;
  owner?: string;
  purpose?: string;
  /** A room of conversation's members, wherever their bodies are; `agents` are those talking in it now. */
  members?: string[];
}

/** An area: places joined by doors. Between areas, the map is the way. */
export interface MapArea {
  id: string;
  name: string;
  places: string[];
}

const SECTIONS: { kind: MapPlace["kind"]; title: string }[] = [
  { kind: "lobby", title: "Start here" },
  { kind: "room", title: "Rooms" },
  { kind: "shared", title: "Shared places" },
  { kind: "home", title: "Homes" },
  { kind: "hall", title: "Halls" },
];

/** The main building's area id, which a place without one is in. */
const MAIN = "main";

/** A name as a heading: "the summer house" becomes "The summer house". */
const heading = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

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

/** What is happening in a place, for its mark: the most pressing doing there and how many are busy; none when all are idle. */
export function busyMark(
  place: MapPlace,
  activities: Record<string, AgentActivity>,
): { doing: AgentActivity["doing"]; count: number } | undefined {
  const busy = place.agents.flatMap((a) => {
    const doing = activities[a]?.doing;
    return doing && URGENCY[doing] !== undefined ? [doing] : [];
  });
  if (!busy.length) return undefined;
  const doing = busy.sort((a, b) => (URGENCY[a] ?? 9) - (URGENCY[b] ?? 9))[0];
  return { doing, count: busy.length };
}

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
      if (change.type === "whereabouts" || moved || (change.type === "place" && change.id.startsWith("shared:")))
        void load();
    });
    return () => {
      gone = true;
      off();
    };
  }, [open]);
  return { places, areas, problem };
}

/**
 * Every place there is, to go to in one click: the rooms agents talk in, the
 * shared places, each agent's home and the halls between them, with who is in
 * each and a mark for any who are waiting on you, stuck or asleep. Who is busy
 * comes first, with where each of them is, and in each group the places where
 * something is happening come before the quiet ones. When some places are in
 * areas of their own, the map groups them by area and says which one you are
 * in.
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
  const areaOf = (p: MapPlace) => p.area ?? MAIN;
  const where = places.find((p) => p.id === here);
  const all = areas.length ? areas : [{ id: MAIN, name: "the main building", places: [] }];
  // The area you are in first, then the main building, then the rest as the server orders them.
  const mine = where ? areaOf(where) : undefined;
  const known = [...all].sort((a, b) => Number(b.id === mine) - Number(a.id === mine));
  const grouped = known.length > 1;

  const busy = useMemo(() => busyAgents(places, activities), [places, activities]);
  const row = (p: MapPlace) => {
    const mark = busyMark(p, activities);
    return (
      <li key={p.id}>
        <button
          type="button"
          className={`world-map-place world-map-${p.kind}${p.agents.length ? "" : " empty"}${mark ? ` busy busy-${mark.doing}` : ""}`}
          aria-current={p.id === here ? "location" : undefined}
          onClick={() => onGo(p.id)}
        >
          <span className="world-map-name">
            {p.kind === "room" ? `#${p.name}` : p.name}
            {p.id === here && <span className="world-map-here">you are here</span>}
          </span>
          {mark && (
            <span className={`world-map-mark doing-${mark.doing}`}>
              {BUSY_WORDS[mark.doing]}
              {mark.count > 1 ? ` · ${mark.count}` : ""}
            </span>
          )}
          {p.purpose && <span className="world-map-purpose">{p.purpose}</span>}
          {p.kind === "lobby" && (
            <span className="world-map-purpose">Make a new agent, task or room; see every open task</span>
          )}
          {p.kind !== "hall" && (
            <span className="world-map-agents">
              {p.agents.length === 0 && p.kind !== "lobby" && (
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
  // Where something is happening first; the rest as they came.
  const rank = (p: MapPlace) => {
    const mark = busyMark(p, activities);
    return mark ? (URGENCY[mark.doing] ?? 9) : 10;
  };
  const sections = (list: MapPlace[]) =>
    SECTIONS.map(({ kind, title }) => {
      const these = list.filter((p) => p.kind === kind).sort((a, b) => rank(a) - rank(b));
      if (!these.length) return null;
      return (
        <section key={kind} aria-label={title}>
          <h3>{title}</h3>
          <ul>{these.map(row)}</ul>
        </section>
      );
    });

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
      {grouped && where && (
        <p className="world-map-area-here">
          You're in {known.find((a) => a.id === areaOf(where))?.name ?? "the main building"}.{" "}
          {places.filter((p) => areaOf(p) === areaOf(where)).length > 1
            ? "Doors lead round it; other areas are a click away here."
            : "Nothing else is there yet, so it has no doors; other areas are a click away here."}
        </p>
      )}
      <div className="world-map-body">
        {!query.trim() && places.length > 0 && (
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
                      aria-current={b.place.id === here ? "location" : undefined}
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
        {grouped
          ? known.map((area) => {
              const list = shown.filter((p) => areaOf(p) === area.id);
              if (!list.length) return null;
              const inIt = area.id === mine;
              return (
                <section
                  key={area.id}
                  className={`world-map-area${inIt ? " here" : ""}`}
                  aria-label={heading(area.name)}
                >
                  <h2>
                    {heading(area.name)}
                    {inIt && <span className="world-map-here">you are here</span>}
                  </h2>
                  {sections(list)}
                </section>
              );
            })
          : sections(shown)}
        {!problem && shown.length === 0 && <p className="world-map-problem">Nothing matches "{query}".</p>}
      </div>
    </div>
  );
}
