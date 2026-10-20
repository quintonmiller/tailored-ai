import { useEffect, useMemo, useRef, useState } from "react";
import { BODY_TYPE, dotColor } from "../avatar/body";
import type { AgentActivity } from "../avatar/doing";
import { outWords, talkedWords } from "../avatar/routines";
import type { TownPlan as Plan } from "../avatar/town";
import { WEAR_TYPE } from "../avatar/wear";
import { useAgentColor } from "../lib/body-colors";
import { nameOf } from "../lib/conversations";
import { byWait } from "../lib/needs";
import { subscribeStateChanges } from "../lib/state-events";
import { areaTitle, type MapArea, type MapPlace, mapIndex, placeTitle } from "../lib/wayfinding";
import { TownPlan } from "./TownPlan";

export type { MapArea, MapPlace } from "../lib/wayfinding";

/**
 * A body's colour, near enough to the colour it is drawn in, for the dot by an
 * agent's name on its card and in the chat, and the small one by its role in
 * the map's list: the colour it chose, or the one its name gives it. The
 * map's larger dot by each agent says what it is doing.
 */
export function agentColor(agent: string, color?: string): string {
  return dotColor(agent, color);
}

/**
 * What an agent is for, in a word, unless its name says so already: a
 * "coder" called coder, or a "producer" called podcast-producer, needs no
 * telling twice.
 */
export function roleWord(agent: string, role: string | undefined): string | undefined {
  if (!role) return undefined;
  const words = ` ${nameOf(agent)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .toLowerCase()} `;
  return words.includes(` ${role.toLowerCase()} `) ? undefined : role;
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
 * One talking with another, face to face or on the phone, is talking for as
 * long as the talk lasts. Those waiting on you go in the order the world's "Needs you" lists them
 * (`byWait`). Only bodies on the map: an agent without one is nowhere to go to.
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
  const waits = (a: Busy, b: Busy) =>
    a.activity.doing === "waiting" && b.activity.doing === "waiting" ? byWait(a.activity, b.activity) : 0;
  return out.sort((a, b) => rank(a) - rank(b) || waits(a, b) || a.agent.localeCompare(b.agent));
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

/**
 * A quiet room of conversation, in words: when it last talked, and how many
 * are in it as the room lists them, people too, as the Rooms page counts
 * them; or, for a room that keeps no list, the agents it wakes, every one of
 * them, a body or not. Undefined for a room with neither.
 */
export function quietWords(
  p: Pick<MapPlace, "members" | "everyone" | "subscribed" | "talked">,
  now: number,
): string | undefined {
  // When it last talked, when the server knows; quiet otherwise.
  const lead = talkedWords(p.talked, now) ?? "quiet";
  if (p.everyone) return `${lead} · ${p.everyone === 1 ? "1 member" : `${p.everyone} members`}`;
  // `members` are only those with a body: the count the server sends counts them all.
  const subscribed = p.subscribed ?? p.members?.length;
  if (subscribed) return `${lead} · ${subscribed} subscribed`;
  return undefined;
}

/** A change to where a body is: where an agent lives (`whereabouts`), or a meeting room it is visiting (`visit`). */
export const comeOrGone = (type: string) => type === "whereabouts" || type === "visit";

/**
 * The places, the areas and the town's plan, asked for while `open` and again
 * whenever someone comes or goes. `fresh` turning true (the map or an agent's
 * card opening) asks again, for what changes without anyone moving: a new
 * agent, a new room.
 */
export function useWorldMap(
  open: boolean,
  fresh = false,
): { places: MapPlace[]; areas: MapArea[]; town?: Plan; links: [string, string][]; problem: string | null } {
  const [places, setPlaces] = useState<MapPlace[]>([]);
  const [areas, setAreas] = useState<MapArea[]>([]);
  const [town, setTown] = useState<Plan | undefined>(undefined);
  const [links, setLinks] = useState<[string, string][]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    if (!open) return;
    let gone = false;
    // Answers can come back out of order: only the last one asked for is kept, so an older map never wins.
    let asked = 0;
    const load = () => {
      const n = ++asked;
      fetch("/api/ext/builtin:places/map")
        .then(async (res) => {
          if (!res.ok) throw new Error(`The map couldn't be loaded (${res.status}).`);
          return (await res.json()) as {
            places?: MapPlace[];
            areas?: MapArea[];
            town?: Plan;
            links?: [string, string][];
          };
        })
        .then((body) => {
          if (gone || n !== asked) return;
          setPlaces(body.places ?? []);
          setAreas(body.areas ?? []);
          setTown(body.town);
          setLinks(body.links ?? []);
          setProblem(null);
        })
        .catch((err: unknown) => {
          if (!gone && n === asked) setProblem(err instanceof Error ? err.message : String(err));
        });
    };
    reload.current = load;
    load();
    const off = subscribeStateChanges((change) => {
      // Someone came or went, a shared place came or went, a place moved to another area or was given a new purpose,
      // or someone chose what a body wears, which the map says of each home's owner.
      const place = change.type === "place";
      const moved = place && change.before?.area !== change.after?.area;
      const repurposed = place && change.before?.purpose !== change.after?.purpose;
      // A door put in or taken out, which the plan draws between the two places.
      const relinked =
        place && JSON.stringify(change.before?.links ?? []) !== JSON.stringify(change.after?.links ?? []);
      const dressed = change.type === WEAR_TYPE || change.type === BODY_TYPE;
      if (
        comeOrGone(change.type) ||
        moved ||
        repurposed ||
        relinked ||
        dressed ||
        (place && change.id.startsWith("shared:"))
      )
        load();
    });
    return () => {
      gone = true;
      reload.current = () => {};
      off();
    };
  }, [open]);
  const asking = open && fresh;
  useEffect(() => {
    if (asking) reload.current();
  }, [asking]);
  return { places, areas, ...(town ? { town } : {}), links, problem };
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
 * Every place there is, to go to in one click. The town from above, every
 * building a button (see `TownPlan`), beside a list laid out for finding
 * someone: who is busy first, with where each of them is; then every agent,
 * coloured by what it is doing, whose home a click goes to (and where its body
 * is, when that is somewhere else); then the rooms agents talk in, the shared
 * places, and the plots at the edge of town. The town, the town hall and the
 * office's floors come last, the floors folded away until asked for. Typing
 * filters the list, and Enter goes to the first thing left.
 */
export function WorldMap({
  places,
  areas = [],
  town,
  links = [],
  problem,
  here,
  you,
  activities,
  back,
  onGo,
  onNeed,
  onClose,
}: {
  places: MapPlace[];
  /** The areas, the town first; without them, every place is in town. */
  areas?: MapArea[];
  /** The town's plan, drawn from above; without it, the list alone. */
  town?: Plan;
  /** The places joined by doors put in, each pair once: the plan draws a line between them. */
  links?: [string, string][];
  problem: string | null;
  /** The place on screen now. */
  here: string | undefined;
  /** Where you stand in the town, while you are out in it: marked on the plan. */
  you?: [number, number];
  activities: Record<string, AgentActivity>;
  /**
   * While you visit in your own body: the place that is the agent's own view, and the agent's name. Anywhere you
   * pick you walk into as you; that one takes you back to the agent's view, and the map says so.
   */
  back?: { place: string; agent: string };
  onGo: (id: string) => void;
  /** Go to an agent waiting on you, with what it waits on open: from "Busy now", as from the "Needs you" list. */
  onNeed?: (agent: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [floorsOpen, setFloorsOpen] = useState(false);
  // Each agent in the colour it chose for its body, on the plan as in the list: the one colour every dot by its name
  // is (`useAgentColor`), kept current as it chooses again.
  const colorOf = useAgentColor();
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
  // Out on their day, which is neither busy nor idle at home: "6 out: café, benches".
  const out = useMemo(() => outWords(activities), [activities]);
  // The one place that ends a visit: the agent's own, which is its view rather than somewhere to walk into.
  const backTo = back ? places.find((p) => p.id === back.place) : undefined;
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
            {back?.place === p.id && p.id !== here && (
              <span className="world-map-here world-map-back">back to {back.agent}'s view</span>
            )}
          </span>
          {mark && <span className={`world-map-mark doing-${mark.doing}`}>{markWords(mark)}</span>}
          {p.purpose && <span className="world-map-purpose">{p.purpose}</span>}
          {p.kind === "lobby" && (
            <span className="world-map-purpose">Make a new agent, task or room; see every open task</span>
          )}
          {p.kind === "town" && (
            <span className="world-map-purpose">The square, the streets, and every building to go into</span>
          )}
          {/* Who is in it; out in the town, who is out and about, at the café or on a bench. */}
          {p.kind !== "office" && p.kind !== "lobby" && (p.kind !== "town" || p.agents.length > 0) && (
            <span className="world-map-agents">
              {p.agents.length === 0 && (
                <span className="world-map-nobody">
                  {(p.kind === "room" && quietWords(p, Date.now())) || "nobody here"}
                </span>
              )}
              {p.agents.map((a) => {
                const doing = activities[a]?.doing;
                const mark = doing ? MARKS[doing] : undefined;
                return (
                  <span key={a} className={`world-map-agent${doing ? ` doing-${doing}` : ""}`}>
                    <span className="world-map-dot" aria-hidden="true">
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
      index.floors.length +
      (index.town ? 1 : 0) +
      (index.lobby ? 1 : 0) >
    0;

  return (
    <div ref={box} className={`world-map${town ? " with-plan" : ""}`} role="dialog" aria-label="Map">
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
      {back && (
        <p className="world-map-rule">
          Anywhere you pick, you walk in as you, except {backTo ? placeTitle(backTo) : `${back.agent}'s home`}: that
          takes you back to {back.agent}'s own view.
        </p>
      )}
      <div className="world-map-split">
        {town && (
          <TownPlan
            plan={town}
            places={places}
            links={links}
            here={here}
            {...(you ? { you } : {})}
            activities={activities}
            color={colorOf}
            onGo={onGo}
          />
        )}
        <div className="world-map-body">
          {!searching && places.length > 0 && (
            <section aria-label="Busy now" className="world-map-busy-list">
              <h3>Busy now</h3>
              {busy.length === 0 ? (
                <p className="world-map-quiet">
                  {out ? "Nobody is busy." : "Nobody is busy: every agent is idle or asleep."}
                </p>
              ) : (
                <ul>
                  {busy.map((b) => (
                    <li key={b.agent}>
                      <button
                        type="button"
                        className={`world-map-busy doing-${b.activity.doing}`}
                        aria-current={current(b.place.id)}
                        title={`${nameOf(b.agent)}: ${b.activity.what}${b.activity.detail ? ` · ${b.activity.detail}` : ""}`}
                        onClick={() => (b.activity.doing === "waiting" && onNeed ? onNeed(b.agent) : onGo(b.place.id))}
                      >
                        <span className="world-map-dot" aria-hidden="true">
                          {MARKS[b.activity.doing]}
                        </span>
                        <span className="world-map-busy-text">
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
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {out && <p className="world-map-out">{out}</p>}
            </section>
          )}
          {index.agents.length > 0 && (
            <section aria-label="Agents" className="world-map-people">
              <h3>Agents</h3>
              <ul>
                {index.agents.map(({ agent, home, away }) => {
                  const doing = activities[agent]?.doing ?? "idle";
                  // Only what is worth a look is in words; idle and asleep are the dot's to say.
                  const calm = URGENCY[doing] === undefined;
                  return (
                    <li key={agent} className="world-map-person">
                      <button
                        type="button"
                        className={`world-map-who doing-${doing}${first(home.id)}`}
                        aria-current={current(home.id)}
                        title={`${nameOf(agent)}${home.role ? `, ${home.role}` : ""}, ${STATE_WORDS[doing]}: ${back?.place === home.id ? `back to ${back.agent}'s view` : `go to ${placeTitle(home)}`}`}
                        onClick={() => onGo(home.id)}
                      >
                        <span className="world-map-dot" aria-hidden="true">
                          {MARKS[doing]}
                        </span>
                        <span className="world-map-who-name">{nameOf(agent)}</span>
                        <span className="world-map-who-role">
                          <span className="world-map-hue" style={{ background: colorOf(agent) }} aria-hidden="true" />
                          {roleWord(agent, home.role)}
                        </span>
                        <span className={`world-map-who-doing${calm ? " calm" : ""}`}>{STATE_WORDS[doing]}</span>
                        {back?.place === home.id && <span className="world-map-back">back to its view</span>}
                      </button>
                      {away && (
                        <button
                          type="button"
                          className="world-map-away"
                          aria-current={current(away.id)}
                          title={
                            back?.place === away.id
                              ? `${nameOf(agent)} is in ${placeTitle(away)}: back to ${back.agent}'s view`
                              : `Go to ${placeTitle(away)}, where ${nameOf(agent)} is`
                          }
                          onClick={() => onGo(away.id)}
                        >
                          in {placeTitle(away)}
                          {back?.place === away.id && (
                            <span className="world-map-back">back to {back.agent}'s view</span>
                          )}
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
            <section aria-label="Plots">
              <h3>Plots</h3>
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
          {section("Town", [...(index.town ? [index.town] : []), ...(index.lobby ? [index.lobby] : [])])}
          {index.floors.length > 0 && (
            <section aria-label="Office floors" className="world-map-floors">
              <button
                type="button"
                className="world-map-fold"
                aria-expanded={searching || floorsOpen}
                // While searching, the floors are open to show what matched; folding them waits for the search to clear.
                disabled={searching}
                onClick={() => setFloorsOpen(!floorsOpen)}
              >
                <span aria-hidden="true">{searching || floorsOpen ? "▾" : "▸"}</span> Office floors
                <span className="world-map-count">{index.floors.length}</span>
              </button>
              {(searching || floorsOpen) && <ul>{index.floors.map(tile)}</ul>}
            </section>
          )}
          {!problem && places.length > 0 && !anything && (
            <p className="world-map-problem">Nothing matches "{query}".</p>
          )}
        </div>
      </div>
    </div>
  );
}
