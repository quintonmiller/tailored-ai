import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AutopilotActivity,
  type BriefingResponse,
  type CronData,
  fetchAutopilotActivity,
  fetchBriefing,
  fetchCron,
  fetchHealth,
  refreshBriefing,
} from "../api";
import { useChatStore } from "../components/ChatContext";
import { SuggestionChips } from "../components/SuggestionChips";
import { type NeedsYouItem, useNeedsYou } from "../hooks/useNeedsYou";
import { type FeedItem, useTodayFeed } from "../hooks/useTodayFeed";

marked.setOptions({ breaks: true, gfm: true });

const ACTIVITY_POLL_MS = 5000;
const SLOW_POLL_MS = 30000;
const NEEDS_YOU_MAX = 4;

/**
 * Home v3 — a real dashboard.
 *
 * A single centered column (right of the persistent app sidebar) descending in
 * priority: a slim status eyebrow with ambient health folded in; the serif
 * briefing hero (the agent's voice); a quick-actions row; NEEDS YOU (the
 * hairline approval/blocked stack); then the FEED as the main body of the page
 * — a day-grouped, in-flight-pinned activity log merged client-side from the
 * existing endpoints, with memory notes collapsed into digest rows. Suggestion
 * chips close it out, prefilling the floating ChatDock rather than auto-sending.
 *
 * Chat lives in the floating ChatDock now — Home no longer embeds a thread.
 */
export function Dashboard() {
  const [activeTask, setActiveTask] = useState<AutopilotActivity["current"] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [cron, setCron] = useState<CronData | null>(null);
  const { items: needsYou } = useNeedsYou();
  const { items: feed } = useTodayFeed();
  const store = useChatStore();

  useEffect(() => {
    const tick = () => {
      fetchAutopilotActivity()
        .then((a) => setActiveTask(a.current))
        .catch(() => setActiveTask(null));
    };
    tick();
    const id = setInterval(tick, ACTIVITY_POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const tick = () => {
      fetchHealth()
        .then(() => setConnected(true))
        .catch(() => setConnected(false));
      fetchCron()
        .then(setCron)
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, SLOW_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Suggestion chips + the "new chat" quick action prefill the dock instead of
  // auto-sending — the user reviews, edits, and presses send themselves.
  const onPick = useCallback((text: string) => store.requestDock(text), [store]);

  return (
    <div className="home">
      <div className="home-col home-col-v3">
        <Eyebrow activeTask={activeTask} connected={connected} cron={cron} />
        <BriefingHero />
        <QuickActions onNewChat={() => store.requestDock()} />
        <NeedsYou items={needsYou} />
        <Feed items={feed} />
        <div className="home-actions home-reveal" style={revealDelay(5)}>
          <SuggestionChips variant="row" onPick={onPick} />
        </div>
      </div>
    </div>
  );
}

// --- Eyebrow status line (with ambient health folded in) --------------------

function Eyebrow({
  activeTask,
  connected,
  cron,
}: {
  activeTask: AutopilotActivity["current"] | null;
  connected: boolean | null;
  cron: CronData | null;
}) {
  const tod = timeOfDay();
  const situation = activeTask ? `working: ${activeTask.title}` : "all quiet";
  const next = cron?.enabled ? nextCronLabel(cron) : null;
  const dotClass = connected === false ? "home-foot-dot error" : "home-foot-dot";
  const state = connected === false ? "offline" : activeTask ? "busy" : "idle";
  return (
    <div className="home-eyebrow home-reveal" style={revealDelay(0)}>
      <span className="home-eyebrow-left">
        {tod} · {situation}
      </span>
      <span className="home-eyebrow-right">
        <span className={dotClass} aria-hidden="true" />
        <span>{state}</span>
        {next && <span>· next: {next}</span>}
      </span>
    </div>
  );
}

// --- Briefing hero (the serif voice, upright body) --------------------------

function BriefingHero() {
  const [state, setState] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchBriefing()
      .then((r) => {
        if (!cancelled) setState(r);
      })
      .catch(() => {
        if (!cancelled) setState({ enabled: false });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refreshBriefing()
      .then((r) => setState(r))
      .catch(() => {
        // Keep the prior content on a refresh failure.
      })
      .finally(() => setRefreshing(false));
  }, []);

  const html = useMemo(() => {
    if (state?.enabled) return marked.parse(state.content || "") as string;
    return "";
  }, [state]);

  return (
    <section className="home-hero home-reveal" style={revealDelay(1)} aria-label="Briefing">
      <div className="home-hero-prose">
        {loading ? (
          <p className="home-hero-loading">
            gathering the day…
            <span className="home-caret" aria-hidden="true">
              ▍
            </span>
          </p>
        ) : state?.enabled ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="home-hero-greeting">{greeting()}</p>
        )}
      </div>
      {state?.enabled && (
        <div className="home-hero-caption">
          {state.stale && <span className="home-hero-stale">stale</span>}
          <span>generated {relTime(state.generatedAt)}</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="home-hero-refresh"
            onClick={onRefresh}
            disabled={refreshing}
            title="Regenerate briefing"
            aria-label="Regenerate briefing"
          >
            <span className={refreshing ? "home-hero-spin" : ""}>↻</span>
          </button>
        </div>
      )}
    </section>
  );
}

// --- Quick actions ----------------------------------------------------------

/**
 * Small text buttons linking to the closest real destination. "new chat" opens
 * the floating dock via requestDock; the rest are plain hash routes that exist
 * today (Tasks board, Agents page → create modal, Config → providers/plugins).
 */
function QuickActions({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div className="home-quick home-reveal" style={revealDelay(2)}>
      <button type="button" className="home-quick-btn" onClick={onNewChat}>
        new chat
      </button>
      <a className="home-quick-btn" href="#/projects">
        new task
      </a>
      <a className="home-quick-btn" href="#/agents">
        create agent
      </a>
      <a className="home-quick-btn" href="#/config/providers">
        install plugin
      </a>
    </div>
  );
}

// --- NEEDS YOU stack --------------------------------------------------------

function NeedsYou({ items }: { items: NeedsYouItem[] }) {
  const shown = items.slice(0, NEEDS_YOU_MAX);
  const overflow = items.length - shown.length;
  return (
    <section className="home-needs home-reveal" style={revealDelay(3)}>
      <div className="home-section-head">
        <h2 className="home-section-label">Needs you</h2>
        {items.length > 0 && <span className="home-section-count">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="home-needs-empty">Nothing needs you.</p>
      ) : (
        <ul className="home-needs-list">
          {shown.map((it) => (
            <li key={it.key} className="home-needs-row" title={it.reason}>
              <span className="home-needs-title">{it.title}</span>
              {it.when && <span className="home-needs-age">{shortAge(it.when)}</span>}
              <a className="home-needs-action" href={it.href}>
                {it.action}
              </a>
            </li>
          ))}
          {overflow > 0 && (
            <li className="home-needs-row home-needs-more">
              <a href="#/projects">and {overflow} more →</a>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

// --- Feed (the main body) ---------------------------------------------------

/**
 * Day-grouped activity log. In-flight rows pin to the top with a pulsing dot;
 * memory bursts render as a collapsed digest row expandable inline. Each row is
 * a HH:MM stamp, a kind glyph, the text, and a deep link where one exists.
 */
function Feed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return (
      <section className="home-feed home-reveal" style={revealDelay(4)}>
        <div className="home-section-head">
          <h2 className="home-section-label">Activity</h2>
        </div>
        <p className="home-feed-empty">quiet so far.</p>
      </section>
    );
  }

  const groups = groupByDay(items);

  return (
    <section className="home-feed home-reveal" style={revealDelay(4)}>
      <div className="home-section-head">
        <h2 className="home-section-label">Activity</h2>
      </div>
      <ul className="home-feed-list">
        {groups.map((g) => (
          <li key={g.label} className="home-feed-day">
            <div className="home-feed-day-label">{g.label}</div>
            <ul className="home-feed-rows">
              {g.items.map((it) => (
                <FeedRow key={it.key} item={it} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const [expanded, setExpanded] = useState(false);
  const glyph = KIND_GLYPH[item.kind] ?? "·";

  const body = (
    <>
      <span className="home-feed-time">{clock(item.at)}</span>
      <span className={`home-feed-glyph${item.inFlight ? " home-feed-pulse" : ""}`} aria-hidden="true">
        {item.inFlight ? "●" : glyph}
      </span>
      <span className="home-feed-text">{item.text}</span>
    </>
  );

  // Memory digest — a button that expands the note first-lines inline.
  if (item.details && item.details.length > 0) {
    return (
      <li className={`home-feed-row${item.inFlight ? " is-inflight" : ""}`}>
        <button
          type="button"
          className="home-feed-link home-feed-digest"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {body}
          <span className="home-feed-caret" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        {expanded && (
          <ul className="home-feed-details">
            {item.details.map((d, i) => (
              <li key={`${item.key}-d${i}`} className="home-feed-detail">
                {d}
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li className={`home-feed-row${item.inFlight ? " is-inflight" : ""}`}>
      {item.href ? (
        <a className="home-feed-link" href={item.href} title={item.text}>
          {body}
        </a>
      ) : (
        <span className="home-feed-link home-feed-static" title={item.text}>
          {body}
        </span>
      )}
    </li>
  );
}

const KIND_GLYPH: Record<FeedItem["kind"], string> = {
  workflow: "⚙",
  task: "▸",
  explore: "✦",
  cron: "↻",
  session: "›",
  memory: "✎",
};

// --- Helpers ----------------------------------------------------------------

function timeOfDay(): string {
  const d = new Date();
  const day = d.toLocaleDateString(undefined, { weekday: "short" }).toLowerCase();
  const h = d.getHours();
  const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return `${day} ${part}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning.";
  if (h < 18) return "Good afternoon.";
  return "Good evening.";
}

/** 24h HH:MM stamp for a feed row. */
function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Group feed items under "today" / "yesterday" / a date label, in order. */
function groupByDay(items: FeedItem[]): Array<{ label: string; items: FeedItem[] }> {
  const groups: Array<{ label: string; items: FeedItem[] }> = [];
  const byLabel = new Map<string, FeedItem[]>();
  for (const it of items) {
    const label = dayLabel(it.at);
    let arr = byLabel.get(label);
    if (!arr) {
      arr = [];
      byLabel.set(label, arr);
      groups.push({ label, items: arr });
    }
    arr.push(it);
  }
  return groups;
}

function dayLabel(d: Date): string {
  const today = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toLowerCase();
}

/** Pick the soonest enabled cron job's name + HH:MM, if cheaply derivable. */
function nextCronLabel(cron: CronData): string | null {
  const enabled = cron.jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return null;
  for (const j of enabled) {
    const t = cronTime(j.schedule);
    if (t) return `${j.name} ${t}`;
  }
  return enabled[0].name;
}

/** Extract HH:MM from a 5-field cron expr when minute+hour are literal. */
function cronTime(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [min, hr] = parts;
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hr)) return null;
  return `${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
}

function relTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  return `${day}d ago`;
}

function shortAge(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d`;
  const w = Math.floor(day / 7);
  return `${w}w`;
}

/**
 * Per-element reveal delay (seconds) for the one-shot fade-up. Uses a CSS var
 * the stylesheet reads, so `prefers-reduced-motion` can neutralise the whole
 * effect without touching inline styles.
 */
function revealDelay(step: number): React.CSSProperties {
  return { "--home-reveal-delay": `${step * 60}ms` } as React.CSSProperties;
}
