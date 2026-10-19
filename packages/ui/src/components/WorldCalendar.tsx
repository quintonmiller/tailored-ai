import { useMemo } from "react";
import { byDay, type Done, type Wake } from "../avatar/calendar";
import { nameOf } from "../lib/conversations";
import { clockTime } from "../lib/did";
import { WorldPanel } from "./WorldPanel";

const EVERYONE = "\u0000everyone";
const HERE = "\u0000here";

/** What kind of wake it is, in a word or two. */
const KINDS: Record<Wake["kind"], string> = { booked: "booked", cron: "cron job", turn: "own turn" };

/** Where and how often a wake comes, in a line: "repeats weekdays at 9am · wakes in #lisbon-trip". */
export function wakeWhere(wake: Wake, roomName: (ref: string) => string | undefined): string {
  const parts: string[] = [];
  if (wake.every) parts.push(wake.kind === "cron" ? `runs ${wake.every}` : `repeats ${wake.every}`);
  if (wake.kind === "booked")
    parts.push(wake.room ? `wakes in #${roomName(wake.room) ?? wake.room}` : "wakes in its own conversation");
  return parts.join(" · ");
}

/**
 * A calendar's full list, opened from one on a wall: every wake to come in
 * the week, day by day; or one agent's, or those of whoever is in the place
 * it hangs in, with what they got done today. Each wake says when, what kind
 * it is, whose it is (a click goes to that agent), what it will do, and where
 * and how often it comes.
 */
export function WorldCalendar({
  wakes,
  done,
  who,
  here,
  agents,
  note,
  loading,
  roomName,
  onWho,
  onGo,
  onTask,
  onClose,
}: {
  /** Every wake to come, soonest first. */
  wakes: Wake[];
  /** What agents got done today, newest first. */
  done: Done[];
  /** Whose calendar it is: one agent's, those of the agents listed, or everyone's when undefined. */
  who: string | string[] | undefined;
  /** Who is in the place it was opened in, when its calendar there shows theirs: "Who's here" picks them. */
  here?: string[];
  /** Whose can be picked. */
  agents: string[];
  /** Why nothing wakes on time, when something says so: agents are paused. */
  note?: string;
  loading: boolean;
  roomName: (ref: string) => string | undefined;
  onWho: (who: string | string[] | undefined) => void;
  /** Go to an agent, where its body is. */
  onGo: (agent: string) => void;
  onTask: (id: string) => void;
  onClose: () => void;
}) {
  const one = typeof who === "string" ? who : undefined;
  const among = useMemo(() => (Array.isArray(who) ? who : who ? [who] : undefined), [who]);
  const shown = useMemo(() => (among ? wakes.filter((w) => among.includes(w.agent)) : wakes), [wakes, among]);
  const days = useMemo(() => byDay(shown), [shown]);
  const finished = useMemo(() => (among ? done.filter((d) => among.includes(d.agent)) : done), [done, among]);
  const people = useMemo(
    () => [...new Set([...agents, ...(one ? [one] : []), ...wakes.map((w) => w.agent)])].sort(),
    [agents, one, wakes],
  );
  return (
    <WorldPanel
      kicker="Calendar"
      title={one ? `${nameOf(one)}'s day` : among ? "Next wakes for who's here" : "Everyone's next wakes"}
      className="world-calendar-panel"
      onClose={onClose}
    >
      <div className="world-panel-row world-list-tools">
        <label className="world-list-who">
          Whose
          <select
            value={one ?? (among ? HERE : EVERYONE)}
            onChange={(e) =>
              onWho(e.target.value === EVERYONE ? undefined : e.target.value === HERE ? (here ?? []) : e.target.value)
            }
          >
            <option value={EVERYONE}>Everyone's</option>
            {(here || (among && !one)) && <option value={HERE}>Who's here</option>}
            {people.map((a) => (
              <option key={a} value={a}>
                {nameOf(a)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {note && <p className="world-calendar-note">{note}</p>}
      {days.map((day) => (
        <section key={day.start} className="world-calendar-day" aria-label={day.label}>
          <h3>{day.label}</h3>
          <ol className="world-calendar-list">
            {day.wakes.map((w) => {
              const where = wakeWhere(w, roomName);
              return (
                <li key={w.key} className="world-calendar-wake">
                  <time dateTime={new Date(w.at).toISOString()}>{clockTime(w.at)}</time>
                  <div className="world-calendar-what">
                    <div className="world-calendar-head">
                      <span className={`world-calendar-kind kind-${w.kind}`}>{KINDS[w.kind]}</span>
                      <button
                        type="button"
                        className="world-panel-inline"
                        title={`Go to ${nameOf(w.agent)}`}
                        onClick={() => onGo(w.agent)}
                      >
                        {nameOf(w.agent)}
                      </button>
                    </div>
                    <p className="world-calendar-title">{w.what}</p>
                    {w.detail && w.detail.trim() !== w.what && <p className="world-calendar-detail">{w.detail}</p>}
                    {where && <p className="world-calendar-where">{where}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {!days.length && (
        <p className="world-panel-quiet">
          {loading
            ? "Looking…"
            : one
              ? `Nothing will wake ${nameOf(one)} this week: no wake it booked, no cron job runs as it, and it doesn't run on its own.`
              : among
                ? among.length
                  ? "Nothing will wake anyone here this week."
                  : "No agent is here."
                : "Nothing will wake anyone this week."}
        </p>
      )}
      {finished.length > 0 && (
        <section className="world-calendar-day" aria-label="Done today">
          <h3>Done today</h3>
          <ol className="world-calendar-list">
            {finished.map((d) => (
              <li key={d.key} className="world-calendar-wake world-calendar-done">
                <time dateTime={new Date(d.at).toISOString()}>{clockTime(d.at)}</time>
                <div className="world-calendar-what">
                  {!one && (
                    <div className="world-calendar-head">
                      <button type="button" className="world-panel-inline" onClick={() => onGo(d.agent)}>
                        {nameOf(d.agent)}
                      </button>
                    </div>
                  )}
                  {d.task ? (
                    <button
                      type="button"
                      className="world-panel-inline world-calendar-title"
                      onClick={() => onTask(d.task as string)}
                    >
                      {d.what}
                    </button>
                  ) : (
                    <p className="world-calendar-title">{d.what}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="world-panel-quiet">
        Agents book their own wakes with the schedule tool. Cron jobs come from the config, and an agent that runs on
        its own takes a turn when its cadence comes round.
      </p>
    </WorldPanel>
  );
}
