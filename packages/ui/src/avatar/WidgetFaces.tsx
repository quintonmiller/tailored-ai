/**
 * The widgets' faces (`widgets.ts`): what a status board, an activity feed, a
 * needs-you board, a to-do list, a photo wall, a room ticker, a chart and a
 * clock show, as live HTML on their surfaces. Each has three ways of being
 * read: from across a room (`data-detail="far"`, the few things that read
 * from there, big), near (everything that fits), and brought up close
 * (`focused`), where its buttons work and its lists scroll. They share the
 * screen's look: dark glass, a heading with a line under it, the agent's own
 * colour on its name. What a face shows comes from the page, fetched once for
 * every widget in view (`WorldData`); a widget keeps showing what it had while
 * a fetch fails, and says so at its foot.
 */
import { type MouseEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useAgentColor } from "../lib/body-colors";
import { nameOf } from "../lib/conversations";
import { clockTime } from "../lib/did";
import { answerable, type Need, ownFlow } from "../lib/needs";
import { ago, lasting, statusLabel } from "../lib/tasks";
import {
  type ChartDay,
  dayChart,
  durationWords,
  lastDays,
  MEASURES,
  type Measure,
  measureOf,
  niceScale,
  shortNumber,
  timeChart,
} from "./charts";
import { DOING_VARS } from "./doing";
import type { UseSpot } from "./stage";
import {
  agendaFor,
  chartMeasure,
  type FaceChoice,
  FEED_FILTERS,
  type FeedFilter,
  feedShown,
  feedVerb,
  photoCaption,
  photoUrl,
  SLIDE_MS,
  slideAt,
  type TickerLine,
  todoFor,
  todoTitle,
  type WorldData,
  whoGroups,
} from "./widgets";

/** What a widget's face needs of the surface it is drawn on. */
export interface WidgetSurface {
  /** Brought up close to be read and used. */
  focused: boolean;
}

/** What a widget's face does when used: the page's `onUse`, and answering an approval. */
export interface WidgetActions {
  onUse?: (action: string, on?: UseSpot) => void;
  /** Approve or deny what an agent waits on: rejects with why it couldn't be. */
  onApprove?: (need: Need, approved: boolean) => Promise<unknown>;
}

/** A widget's face, by the widget it is. */
export function WidgetFace({
  choice,
  world,
  surface,
  actions,
}: {
  choice: FaceChoice;
  world: WorldData;
  surface: WidgetSurface;
  actions: WidgetActions;
}): ReactNode {
  const props = { choice, world, surface, actions };
  switch (choice.face) {
    case "status":
      return <StatusFace {...props} />;
    case "feed":
      return <FeedFace {...props} />;
    case "needs":
      return <NeedsFace {...props} />;
    case "my-tasks":
      return <TodoFace {...props} />;
    case "photos":
      return <PhotoFace {...props} />;
    case "ticker":
      return <TickerFace {...props} />;
    case "chart":
      return <ChartFace {...props} />;
    case "agenda":
      return <AgendaFace {...props} />;
    default:
      return null;
  }
}

type FaceProps = { choice: FaceChoice; world: WorldData; surface: WidgetSurface; actions: WidgetActions };

// --------------------------------------------------------------------------
// What they share
// --------------------------------------------------------------------------

/** An agent's name, a dot before it in the colour its body wears (and its doing's colour, where that says more). */
function Agent({ agent, doing }: { agent: string; doing?: string }) {
  const color = useAgentColor()(agent);
  return (
    <span
      className="sw-agent"
      style={{
        ["--who" as string]: color,
        ...(doing ? { ["--dot" as string]: DOING_VARS[`--doing-${doing}`] } : {}),
      }}
    >
      {nameOf(agent)}
    </span>
  );
}

/** A widget's heading: its title, a few words beside it, and on the right whatever it keeps there. */
function Head({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <header className="sw-head">
      <span className="sw-title">{title}</span>
      {sub && <span className="sw-sub">{sub}</span>}
      {children && <span className="sw-head-end">{children}</span>}
    </header>
  );
}

/** A widget's foot: why nothing newer came, or, brought up close, what you can do. */
function Foot({ error, focused, hint }: { error?: string; focused: boolean; hint: string }) {
  if (error)
    return (
      <footer className="sw-foot is-error">
        <output>Not updated: {error}</output>
      </footer>
    );
  return focused ? <footer className="sw-foot">{hint}</footer> : null;
}

/** A row of choices, brought up close: the page's filter chips in the widget's look. */
function Chips<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <fieldset className="sw-chips" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          className="sw-chip"
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/** The time to the second, every second, while `on`; otherwise the minute, every quarter minute. */
function useClock(seconds: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), seconds ? 1000 : 15_000);
    return () => clearInterval(timer);
  }, [seconds]);
  return now;
}

// --------------------------------------------------------------------------
// Who's doing what
// --------------------------------------------------------------------------

/**
 * Every agent, grouped by what it is doing: waiting on you, working,
 * talking, each a card with a line for each agent (what, and for how long);
 * idle and asleep as rows of names at the foot, the most recently busy
 * first. From across the room, a big number for each group. An agent opens
 * its card; brought up close, its place is one click on.
 */
function StatusFace({ world, surface, actions }: FaceProps) {
  const groups = useMemo(() => whoGroups(world.activities, world.agents, world.now), [world]);
  const active = groups.filter((g) => g.id === "waiting" || g.id === "working" || g.id === "talking");
  const quiet = groups.filter((g) => g.id === "idle" || g.id === "asleep");
  const busy = active.reduce((n, g) => n + (g.id === "waiting" ? 0 : g.rows.length), 0);
  const waiting = groups.find((g) => g.id === "waiting")?.rows.length ?? 0;
  const go = (agent: string) => actions.onUse?.("go", { agent });
  return (
    <div className="sw sw-status">
      <Head
        title="Who's doing what"
        sub={`${busy} busy${waiting ? ` · ${waiting} waiting on you` : ""} · ${world.agents.length} in all`}
      />
      <div className="sw-far sw-status-far" aria-hidden="true">
        {groups.map((g) => (
          <div key={g.id} className={`sw-far-tile is-${g.id}`}>
            <span className="sw-far-count">{g.rows.length}</span>
            <span className="sw-far-label">{g.title}</span>
          </div>
        ))}
      </div>
      <div className="sw-near sw-status-body">
        <div className="sw-status-active">
          {active.every((g) => !g.rows.length) && <p className="sw-empty">Everyone is idle or asleep.</p>}
          {active
            .filter((g) => g.rows.length)
            .map((g) => (
              <section key={g.id} className={`sw-group is-${g.id}`}>
                <h4 className="sw-group-head">
                  {g.title}
                  <span className="sw-count">{g.rows.length}</span>
                </h4>
                <ul className="sw-rows">
                  {g.rows.map((r) => (
                    <li key={r.agent}>
                      <button type="button" className="sw-row" onClick={() => go(r.agent)}>
                        <Agent agent={r.agent} doing={r.doing} />
                        <span className="sw-row-text">
                          {r.what}
                          {r.detail && <span className="sw-row-detail"> · {r.detail}</span>}
                        </span>
                        {r.when && <span className="sw-row-meta">{r.when}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
        <div className={`sw-status-quiet${active.some((g) => g.rows.length) ? "" : " is-all"}`}>
          {quiet
            .filter((g) => g.rows.length)
            .map((g) => (
              <section key={g.id} className={`sw-quiet is-${g.id}`}>
                <h4 className="sw-quiet-head">
                  {g.title} <span className="sw-count">{g.rows.length}</span>
                </h4>
                <ul className="sw-quiet-rows">
                  {g.rows.map((r) => (
                    <li key={r.agent}>
                      <button type="button" className="sw-quiet-row" onClick={() => go(r.agent)}>
                        <Agent agent={r.agent} doing={r.doing} />
                        <span className="sw-quiet-what">{r.what === "idle" ? "" : r.what}</span>
                        {r.when && <span className="sw-row-meta">{r.when}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </div>
      <Foot focused={surface.focused} hint="Click an agent to go to it · Esc to step back" />
    </div>
  );
}

// --------------------------------------------------------------------------
// The activity feed
// --------------------------------------------------------------------------

/** The mark before a line of the feed, by what it is. */
const FEED_MARK: Record<string, string> = { turn: "↩", tool: "⚙", post: "#", done: "✓" };

/**
 * What agents did lately, newest first: replies, tools used (the same one
 * again and again folded into one line), posts and finished tasks. Brought
 * up close, chips narrow it to one kind, and to the agents here; a finished
 * task opens its card, anything else the agent's.
 */
function FeedFace({ world, surface, actions }: FaceProps) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [hereOnly, setHereOnly] = useState(!!world.whose);
  const items = useMemo(
    () => feedShown(world.feed.data ?? [], filter, hereOnly ? world.whose : undefined),
    [world.feed.data, filter, hereOnly, world.whose],
  );
  const open = (e: MouseEvent, task?: string, agent?: string) => {
    e.stopPropagation();
    if (task) actions.onUse?.("tasks", { task });
    else if (agent) actions.onUse?.("agent", { agent });
  };
  const loading = !world.feed.data && !world.feed.error;
  return (
    <div className="sw sw-feed">
      <Head title="Activity" sub={hereOnly && world.whose ? "here" : "everyone"}>
        {!surface.focused && <span className="sw-live">newest first</span>}
      </Head>
      {surface.focused && (
        <div className="sw-tools">
          <Chips options={FEED_FILTERS} value={filter} onChange={setFilter} label="Show" />
          {world.whose && (
            <button
              type="button"
              className="sw-chip"
              aria-pressed={hereOnly}
              onClick={() => setHereOnly(!hereOnly)}
              title="Only the agents here"
            >
              Here only
            </button>
          )}
        </div>
      )}
      <ol className="sw-feed-list">
        {loading && <li className="sw-empty">Loading…</li>}
        {!loading && !items.length && (
          <li className="sw-empty">
            {world.feed.data?.length ? "Nothing of that kind lately." : "Nothing done in the last two days."}
          </li>
        )}
        {items.map((item) => (
          <li key={item.id} className={`sw-feed-item is-${item.kind}`}>
            <button type="button" className="sw-feed-row" onClick={(e) => open(e, item.task, item.agent)}>
              <span className="sw-mark" aria-hidden="true">
                {FEED_MARK[item.kind]}
              </span>
              <span className="sw-feed-main">
                <span className="sw-feed-line">
                  <Agent agent={item.agent} /> <span className="sw-feed-verb">{feedVerb(item)}</span>
                  {item.kind === "post" && item.detail && <span className="sw-feed-verb"> {item.detail}</span>}
                </span>
                {item.kind !== "tool" && <span className="sw-feed-quote">{item.text}</span>}
                {item.kind === "tool" && item.detail && <span className="sw-feed-quote is-dim">{item.detail}</span>}
              </span>
              <time className="sw-feed-when" dateTime={item.at}>
                {ago(item.at, world.now)}
              </time>
            </button>
          </li>
        ))}
      </ol>
      <Foot
        error={world.feed.error}
        focused={surface.focused}
        hint="A finished task opens its card, anything else the agent's · Esc to step back"
      />
    </div>
  );
}

// --------------------------------------------------------------------------
// Needs you
// --------------------------------------------------------------------------

/** A tool call's arguments in a line: the first few as key and value, cut short. */
function argsLine(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const parts = Object.entries(args)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  if (!parts.length) return undefined;
  const line = parts.join(" · ");
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * What agents are waiting on you for: each approval with the call it is for,
 * and Approve or Deny right there when the page has its details from the
 * server and it has no stricter flow of its own (never a purchase, never a
 * trusted action: those say where to approve them, and only Deny is here);
 * each question with Answer, which opens it where it can be answered.
 * Approve never takes the second click of a double click.
 */
function NeedsFace({ world, surface, actions }: FaceProps) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [said, setSaid] = useState<Record<string, string>>({});
  const decide = async (need: Need, approved: boolean) => {
    if (!actions.onApprove) return;
    setBusy((b) => ({ ...b, [need.key]: true }));
    try {
      await actions.onApprove(need, approved);
      setSaid((s) => ({ ...s, [need.key]: approved ? "Approved" : "Denied" }));
    } catch (err) {
      setSaid((s) => ({ ...s, [need.key]: `Couldn't: ${err instanceof Error ? err.message : String(err)}` }));
    } finally {
      setBusy((b) => ({ ...b, [need.key]: false }));
    }
  };
  const needs = world.needs;
  return (
    <div className={`sw sw-needs${needs.length ? " has-needs" : ""}`}>
      <Head title="Needs you" sub={needs.length ? `${needs.length} waiting` : "nothing waiting"} />
      <div className="sw-far sw-needs-far" aria-hidden="true">
        <span className="sw-far-count">{needs.length || "✓"}</span>
        <span className="sw-far-label">
          {needs.length
            ? needs
                .slice(0, 3)
                .map((n) => nameOf(n.agent))
                .join(", ")
            : "No one is waiting on you"}
        </span>
      </div>
      <div className="sw-near sw-needs-list">
        {!needs.length && (
          <p className="sw-empty sw-needs-none">
            <span className="sw-big-check" aria-hidden="true">
              ✓
            </span>
            No one is waiting on you.
          </p>
        )}
        {needs.map((need) => {
          const can = answerable(need);
          const strict = need.kind === "approval" && (ownFlow(need.tool) || ownFlow(need.approval?.toolName));
          const outcome = said[need.key];
          return (
            <article key={need.key} className={`sw-need is-${need.kind}`}>
              <div className="sw-need-top">
                <Agent agent={need.agent} doing="waiting" />
                <span className="sw-need-what">
                  {need.kind === "approval" ? `wants your OK${need.tool ? ` to use ${need.tool}` : ""}` : need.what}
                </span>
                {lasting(need.since, world.now) && (
                  <span className="sw-row-meta">{lasting(need.since, world.now)}</span>
                )}
              </div>
              {need.kind === "approval" && need.approval?.description && (
                <p className="sw-need-detail">{need.approval.description}</p>
              )}
              {need.kind === "approval" && argsLine(need.approval?.toolArgs) && (
                <p className="sw-need-args">{argsLine(need.approval?.toolArgs)}</p>
              )}
              {need.kind === "question" && (need.question ?? need.detail) && (
                <p className="sw-need-detail">{need.question ?? need.detail}</p>
              )}
              {strict && <p className="sw-need-note">This one is approved in its own flow, never from a wall.</p>}
              <div className="sw-need-actions">
                {outcome ? (
                  <output className="sw-need-said">{outcome}</output>
                ) : need.kind === "approval" ? (
                  <>
                    {can && (
                      <button
                        type="button"
                        className="sw-btn is-go"
                        disabled={busy[need.key]}
                        onClick={(e) => {
                          // A double click is never two answers, and never an approval by accident.
                          if (e.detail > 1) return;
                          void decide(need, true);
                        }}
                      >
                        Approve
                      </button>
                    )}
                    {need.approval && (
                      <button
                        type="button"
                        className="sw-btn"
                        disabled={busy[need.key]}
                        onClick={() => void decide(need, false)}
                      >
                        Deny
                      </button>
                    )}
                    <button
                      type="button"
                      className="sw-btn is-quiet"
                      onClick={() => actions.onUse?.("need", { agent: need.agent })}
                    >
                      Details
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="sw-btn is-go"
                    onClick={() => actions.onUse?.("need", { agent: need.agent })}
                  >
                    Answer
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <Foot
        focused={surface.focused}
        hint="Approve or deny here; Answer and Details open the card · Esc to step back"
      />
    </div>
  );
}

// --------------------------------------------------------------------------
// A to-do list
// --------------------------------------------------------------------------

/** Lines a to-do list shows before it says how many more, while it isn't being read. */
const TODO_SHOWN = 6;

/**
 * One agent's open tasks, on a pad: in a home its owner's, elsewhere those of
 * whoever is there, or everyone's in the lobby. What is in hand first, then
 * what is blocked, then what waits to start. A line opens its task.
 */
function TodoFace({ world, surface, actions }: FaceProps) {
  const tasks = useMemo(() => todoFor(world.tasks, world.whose), [world.tasks, world.whose]);
  const shown = surface.focused ? tasks : tasks.slice(0, TODO_SHOWN);
  return (
    <div className="sw-todo">
      <header className="sw-todo-head">
        <span className="sw-todo-title">{todoTitle(world)}</span>
        <span className="sw-todo-count">{tasks.length}</span>
      </header>
      <div className="sw-far sw-todo-far" aria-hidden="true">
        <span className="sw-far-count">{tasks.length}</span>
        <span className="sw-far-label">{tasks.length === 1 ? "thing to do" : "things to do"}</span>
        {tasks[0] && <span className="sw-todo-first">{tasks[0].title}</span>}
      </div>
      <ul className="sw-near sw-todo-list">
        {!tasks.length && <li className="sw-todo-empty">Nothing to do.</li>}
        {shown.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={`sw-todo-item is-${t.status}`}
              onClick={() => actions.onUse?.("tasks", { task: t.id })}
            >
              <span className="sw-box" aria-hidden="true" />
              <span className="sw-todo-text">{t.title}</span>
              {t.status !== "backlog" && <span className="sw-todo-status">{statusLabel(t.status)}</span>}
              {!world.owner && t.assignee && <span className="sw-todo-who">{nameOf(t.assignee)}</span>}
            </button>
          </li>
        ))}
        {tasks.length > shown.length && <li className="sw-todo-more">+{tasks.length - shown.length} more</li>}
      </ul>
    </div>
  );
}

// --------------------------------------------------------------------------
// The photo wall
// --------------------------------------------------------------------------

/**
 * The photos and selfies agents took, newest first, from every place: one
 * big, turning over slowly by the clock, the rest pinned along the side.
 * Brought up close it holds still; a photo clicked is the big one, and the
 * arrows go through them.
 */
function PhotoFace({ world, surface }: FaceProps) {
  const photos = world.photos.data ?? [];
  const now = useClock(false);
  const [held, setHeld] = useState<number | null>(null);
  useEffect(() => {
    if (!surface.focused) setHeld(null);
  }, [surface.focused]);
  const auto = slideAt(now, photos.length);
  const at = held !== null && held < photos.length ? held : auto;
  const big = photos[at];
  const pick = (i: number) => setHeld(((i % photos.length) + photos.length) % photos.length);
  // The page turns by itself every few seconds while not held: this ticks it over in time.
  const [, tick] = useState(0);
  useEffect(() => {
    if (held !== null || photos.length < 2) return;
    const timer = setTimeout(() => tick((n) => n + 1), SLIDE_MS - (Date.now() % SLIDE_MS) + 30);
    return () => clearTimeout(timer);
  });
  return (
    <div className="sw-photos">
      {!photos.length ? (
        <div className="sw-photos-none">
          <span className="sw-photos-none-title">No photos yet</span>
          <span className="sw-photos-none-sub">
            {world.photos.error ? `Couldn't load them: ${world.photos.error}` : "Agents' photos and selfies hang here."}
          </span>
        </div>
      ) : (
        <>
          <figure className="sw-photo-big">
            <div className="sw-photo-frame">
              {photos.map((p, i) => (
                <img
                  key={p.media}
                  src={photoUrl(p.media)}
                  alt={photoCaption(p, world.now)}
                  className={i === at ? "is-up" : ""}
                  loading="lazy"
                />
              ))}
            </div>
            {big && <figcaption className="sw-photo-caption">{photoCaption(big, world.now)}</figcaption>}
            {surface.focused && photos.length > 1 && (
              <>
                <button
                  type="button"
                  className="sw-photo-turn is-before"
                  aria-label="Photo before"
                  onClick={() => pick(at - 1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="sw-photo-turn is-after"
                  aria-label="Photo after"
                  onClick={() => pick(at + 1)}
                >
                  ›
                </button>
              </>
            )}
          </figure>
          <ol className="sw-photo-strip" aria-label="Every photo">
            {photos.slice(0, 12).map((p, i) => (
              <li key={p.media} style={{ ["--tilt" as string]: `${((i % 3) - 1) * 2.2}deg` }}>
                <button
                  type="button"
                  className={`sw-polaroid${i === at ? " is-up" : ""}`}
                  aria-label={photoCaption(p, world.now)}
                  onClick={() => pick(i)}
                >
                  <img src={photoUrl(p.media)} alt="" loading="lazy" />
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// The room ticker
// --------------------------------------------------------------------------

/** How long each line of a ticker is the one up. */
const LINE_MS = 6_000;

/**
 * A room's latest lines on a strip: the room's name, and one line at a time,
 * newest first, each sliding up after the last. Brought up close, every line
 * it has, to scroll through. People read it; nobody in the room is woken.
 */
function TickerFace({ choice, world, surface }: FaceProps) {
  const ticker = world.ticker(choice.arg);
  const lines = ticker.lines;
  const now = useClock(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (lines.length < 2 || surface.focused) return;
    const timer = setTimeout(() => tick((n) => n + 1), LINE_MS - (Date.now() % LINE_MS) + 30);
    return () => clearTimeout(timer);
  });
  const up = lines.length ? Math.floor(Date.now() / LINE_MS) % Math.min(lines.length, 5) : 0;
  const line = lines[up];
  return (
    <div className="sw-ticker">
      <div className="sw-ticker-label">
        <span className="sw-ticker-dot" aria-hidden="true" />
        <span className="sw-ticker-room">{ticker.title}</span>
      </div>
      {surface.focused ? (
        <ol className="sw-ticker-all">
          {!lines.length && <li className="sw-ticker-quiet">Nothing said yet.</li>}
          {lines.map((l) => (
            <TickerRow key={l.id} line={l} now={now} />
          ))}
        </ol>
      ) : (
        <div className="sw-ticker-window" aria-live="off">
          {line ? (
            <div key={line.id} className="sw-ticker-line">
              <TickerRow line={line} now={now} />
            </div>
          ) : (
            <span className="sw-ticker-quiet">
              {ticker.error ? `Couldn't read it: ${ticker.error}` : "Quiet so far."}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TickerRow({ line, now }: { line: TickerLine; now: number }) {
  return (
    <li className="sw-ticker-row">
      {line.agent ? <Agent agent={line.agent} /> : <span className="sw-agent is-person">{line.who}</span>}
      <span className="sw-ticker-text">{line.text}</span>
      <time className="sw-ticker-when" dateTime={line.at}>
        {ago(line.at, now)}
      </time>
    </li>
  );
}

// --------------------------------------------------------------------------
// A chart
// --------------------------------------------------------------------------

/** The margins round a chart's bars, in the face's pixels: room for the scale on the left and the days below. */
const PLOT = { left: 62, right: 10, top: 14, bottom: 38 };

/** An element's size in its own CSS pixels, kept up to date as it changes: what a chart is drawn to fit. */
function useBox<T extends HTMLElement>(): [RefObject<T | null>, [number, number]] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setBox((was) =>
        was[0] === el.clientWidth && was[1] === el.clientHeight ? was : [el.clientWidth, el.clientHeight],
      );
    measure();
    // Without one (an old browser, a test page), it is drawn at the size it had at first.
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, box];
}

/**
 * A small chart of real numbers, by the day on the page's clock: tokens
 * (read and written, stacked), turns, tasks done, or time by activity as
 * bars. It goes through the four unless told one; brought up close, tabs
 * pick the measure and the last week or two. In a home, its owner's
 * numbers; anywhere else, everyone's. A day with nothing is a zero.
 */
function ChartFace({ choice, world, surface }: FaceProps) {
  const fixed = measureOf(choice.arg);
  const [picked, setPicked] = useState<Measure | null>(null);
  const [span, setSpan] = useState<7 | 14>(7);
  useEffect(() => {
    if (!surface.focused) setPicked(null);
  }, [surface.focused]);
  const measure = picked ?? fixed ?? chartMeasure(undefined, world.now);
  const title = MEASURES.find((m) => m.id === measure)?.title ?? "Chart";
  const whose = world.owner ? `${nameOf(world.owner)}'s` : world.whose ? "who's here" : "everyone";
  const stats = world.stats.data;
  return (
    <div className="sw sw-chart">
      <Head title={title} sub={whose}>
        {!surface.focused && !fixed && (
          <span className="sw-dots" aria-hidden="true">
            {MEASURES.map((m) => (
              <span key={m.id} className={`sw-dot${m.id === measure ? " is-up" : ""}`} />
            ))}
          </span>
        )}
      </Head>
      {surface.focused && (
        <div className="sw-tools">
          <Chips
            options={MEASURES.map((m) => ({ id: m.id, label: m.short }))}
            value={measure}
            onChange={setPicked}
            label="Measure"
          />
          <Chips
            options={[
              { id: "7", label: "7 days" },
              { id: "14", label: "14 days" },
            ]}
            value={String(span) as "7" | "14"}
            onChange={(v) => setSpan(v === "14" ? 14 : 7)}
            label="Days"
          />
        </div>
      )}
      <div className="sw-chart-body">
        {!stats ? (
          <p className="sw-empty">
            {world.stats.error ? `Couldn't load the numbers: ${world.stats.error}` : "Loading…"}
          </p>
        ) : measure === "time" ? (
          <TimeBars
            stats={stats}
            days={lastDays(surface.focused ? span : 1, world.now)}
            who={world.whose}
            span={surface.focused ? span : 1}
          />
        ) : (
          <DayBars chart={dayChart(stats, measure, surface.focused ? span : 7, world.now, world.whose)} />
        )}
      </div>
      <Foot error={stats ? world.stats.error : undefined} focused={surface.focused} hint="Esc to step back" />
    </div>
  );
}

/** Bars by the day, stacked when there are two series, with a scale up the side and the days along the foot. */
function DayBars({ chart }: { chart: ReturnType<typeof dayChart> }) {
  const sums = chart.days.map((_, i) => chart.series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const scale = niceScale(Math.max(...sums));
  const [boxRef, [w, h]] = useBox<HTMLDivElement>();
  const { left, right, top, bottom } = PLOT;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const slot = plotW / chart.days.length;
  const bar = Math.min(44, slot * 0.62);
  const y = (v: number) => top + plotH - (v / scale.max) * plotH;
  return (
    <div className="sw-chart-plot">
      <div className="sw-chart-figures">
        <span className="sw-chart-big">{shortNumber(chart.today)}</span>
        <span className="sw-chart-small">
          today · {shortNumber(chart.total)} in {chart.days.length} days
        </span>
        {chart.series.length > 1 && (
          <span className="sw-legend">
            {chart.series.map((s) => (
              <span key={s.key} className={`sw-key tone-${s.tone}`}>
                {s.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="sw-plot-box" ref={boxRef}>
        {w > left + right && h > top + bottom && (
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            className="sw-svg"
            role="img"
            aria-label={`${chart.measure} per day`}
          >
            {scale.ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={w - right} y1={y(t)} y2={y(t)} className={t === 0 ? "sw-axis" : "sw-grid"} />
                <text x={left - 10} y={y(t)} className="sw-tick" textAnchor="end" dominantBaseline="middle">
                  {shortNumber(t)}
                </text>
              </g>
            ))}
            {chart.days.map((d, i) => {
              const x = left + slot * i + (slot - bar) / 2;
              let base = 0;
              return (
                <g key={d.start}>
                  {chart.series.map((s) => {
                    const v = s.values[i] ?? 0;
                    const from = base;
                    base += v;
                    return v > 0 ? (
                      <rect
                        key={s.key}
                        x={x}
                        width={bar}
                        y={y(from + v)}
                        height={Math.max(1, y(from) - y(from + v))}
                        rx={3}
                        className={`sw-bar tone-${s.tone}`}
                      >
                        <title>{`${d.label}: ${shortNumber(v)} ${s.label.toLowerCase()}`}</title>
                      </rect>
                    ) : null;
                  })}
                  <text x={left + slot * i + slot / 2} y={h - bottom + 26} className="sw-tick" textAnchor="middle">
                    {d.label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

/** Time by activity: a bar for each thing agents spent time at, longest first, with how long. */
function TimeBars({
  stats,
  days,
  who,
  span,
}: {
  stats: NonNullable<WorldData["stats"]["data"]>;
  days: ChartDay[];
  who?: string[];
  span: number;
}) {
  const t = timeChart(stats, days, who);
  const most = t.bars[0]?.ms ?? 0;
  const period = span === 1 ? "today" : `in ${span} days`;
  return (
    <div className="sw-time">
      <div className="sw-chart-figures">
        <span className="sw-chart-big">{t.total ? durationWords(t.total) : "0 min"}</span>
        <span className="sw-chart-small">
          busy {period}
          {t.since
            ? ` · counted since ${clockTime(t.since)}${span > 1 ? ` ${new Date(t.since).toLocaleDateString([], { weekday: "short" })}` : ""}`
            : ""}
        </span>
      </div>
      {!t.bars.length ? (
        <p className="sw-empty">Nothing counted {period} yet: time is counted while agents work.</p>
      ) : (
        <ul className="sw-time-bars">
          {t.bars.map((b) => (
            <li key={b.what} className="sw-time-bar">
              <span className="sw-time-what">{b.what}</span>
              <span className="sw-time-track">
                <span className="sw-time-fill" style={{ width: `${Math.max(2, (b.ms / most) * 100)}%` }} />
              </span>
              <span className="sw-time-ms">{durationWords(b.ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// The clock and the day's agenda
// --------------------------------------------------------------------------

/**
 * The time, big, ticking by the second up close; the date; and the day's
 * agenda under them: what wakes still to come today (or tomorrow's first,
 * late on), then what got done. In a home, its owner's day. A line about an
 * agent opens that agent's list of wakes.
 */
function AgendaFace({ world, surface, actions }: FaceProps) {
  const now = useClock(surface.focused);
  const who = world.whose;
  const day = useMemo(
    () =>
      agendaFor(
        world.wakes.filter((w) => !who || who.includes(w.agent)),
        world.done.filter((d) => !who || who.includes(d.agent)),
        world.now,
      ),
    [world.wakes, world.done, world.now, who],
  );
  const date = new Date(now);
  // The hours and minutes big, and where the clock has them, AM or PM small beside them: on one line, however wide.
  const parts = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).formatToParts(date);
  const time = parts
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value)
    .join("")
    .trim();
  const period = parts.find((p) => p.type === "dayPeriod")?.value;
  const secs = String(date.getSeconds()).padStart(2, "0");
  return (
    <div className="sw sw-agenda">
      <div className="sw-clock">
        <span className="sw-clock-time">
          {time}
          {surface.focused && <span className="sw-clock-secs">:{secs}</span>}
          {period && <span className="sw-clock-period">{period}</span>}
        </span>
        <span className="sw-clock-date">
          {date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        </span>
      </div>
      <div className="sw-far sw-agenda-far" aria-hidden="true">
        {day.coming[0] ? (
          <>
            <span className="sw-agenda-next-when">Next · {clockTime(day.coming[0].at)}</span>
            <span className="sw-agenda-next-what">
              {who?.length === 1 ? "" : `${nameOf(day.coming[0].agent)}: `}
              {day.coming[0].what}
            </span>
          </>
        ) : (
          <span className="sw-agenda-next-what is-dim">Nothing more today</span>
        )}
      </div>
      <ol className="sw-near sw-agenda-list">
        {!day.coming.length && !day.done.length && <li className="sw-empty">Nothing on today.</li>}
        {day.coming.map((i) => (
          <li key={i.key}>
            <button
              type="button"
              className={`sw-agenda-item is-${i.kind ?? "turn"}`}
              onClick={() => actions.onUse?.("calendar", { agent: i.agent })}
            >
              <span className="sw-agenda-time">{clockTime(i.at)}</span>
              <span className="sw-agenda-what">
                {who?.length === 1 ? null : <Agent agent={i.agent} />} {i.what}
              </span>
            </button>
          </li>
        ))}
        {day.done.length > 0 && <li className="sw-agenda-sep">Done today</li>}
        {day.done.map((i) => (
          <li key={i.key}>
            <span className="sw-agenda-item is-done">
              <span className="sw-agenda-time">✓</span>
              <span className="sw-agenda-what">
                {who?.length === 1 ? null : <Agent agent={i.agent} />} {i.what}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
