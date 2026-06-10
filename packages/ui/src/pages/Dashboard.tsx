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

marked.setOptions({ breaks: true, gfm: true });

const ACTIVITY_POLL_MS = 5000;
const SLOW_POLL_MS = 30000;
const NEEDS_YOU_MAX = 4;

/**
 * Home — the assistant's surface. A single centered column: the agent speaks
 * (the serif briefing hero), shows what needs you (a flat hairline stack), and
 * listens (a docked ask bar that hands off to Chat). Every data source is one
 * of the existing config-gated endpoints; with the briefing/suggestions
 * features off the page still reads as intentional, never broken.
 */
export function Dashboard() {
  const [activeTask, setActiveTask] = useState<AutopilotActivity["current"] | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [cron, setCron] = useState<CronData | null>(null);
  const { items: needsYou } = useNeedsYou();
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

  // Send to chat through the shared store, then route to the Chat page. The
  // store is app-wide (ChatProvider in App.tsx wraps every page including the
  // ChatDock), so the message is already streaming when Chat mounts.
  const handoffToChat = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      store.send(trimmed);
      window.location.hash = "/chat";
    },
    [store],
  );

  return (
    <div className="home">
      <div className="home-col">
        <Eyebrow activeTask={activeTask} />
        <BriefingHero />
        <NeedsYou items={needsYou} />
        <QuickActions onPick={handoffToChat} />
        <div className="home-dock home-reveal" style={revealDelay(4)}>
          <AskBar agentName={resolveAgentName(store)} onSubmit={handoffToChat} />
          <FooterStatus connected={connected} cron={cron} />
        </div>
      </div>
    </div>
  );
}

// --- Eyebrow status line ----------------------------------------------------

function Eyebrow({ activeTask }: { activeTask: AutopilotActivity["current"] | null }) {
  const tod = timeOfDay();
  const situation = activeTask ? `working: ${activeTask.title}` : "all quiet";
  return (
    <div className="home-eyebrow home-reveal" style={revealDelay(0)}>
      <span className="home-eyebrow-left">
        {tod} · {situation}
      </span>
    </div>
  );
}

// --- Briefing hero (the serif voice) ---------------------------------------

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
          <p>{greeting()}</p>
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

// --- NEEDS YOU stack --------------------------------------------------------

function NeedsYou({ items }: { items: NeedsYouItem[] }) {
  const shown = items.slice(0, NEEDS_YOU_MAX);
  const overflow = items.length - shown.length;
  return (
    <section className="home-needs home-reveal" style={revealDelay(2)}>
      <div className="home-section-head">
        <h2 className="home-section-label">Needs you</h2>
        {items.length > 0 && <span className="home-section-count">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="home-needs-empty">Nothing needs you.</p>
      ) : (
        <ul className="home-needs-list">
          {shown.map((it, i) => (
            <li
              key={it.key}
              className="home-needs-row home-reveal"
              style={revealDelay(2.5 + i * 0.5)}
              title={it.reason}
            >
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

// --- Quick actions ----------------------------------------------------------

function QuickActions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="home-actions home-reveal" style={revealDelay(3)}>
      <SuggestionChips variant="row" onPick={onPick} />
    </div>
  );
}

// --- Docked ask bar ---------------------------------------------------------

function AskBar({ agentName, onSubmit }: { agentName: string | null; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  const placeholder = agentName ? `Ask or tell ${agentName} anything…` : "Ask or tell your assistant anything…";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    onSubmit(trimmed);
  }

  return (
    <form className="home-ask" onSubmit={submit}>
      <label className="home-ask-label" htmlFor="home-ask-input">
        Message your assistant
      </label>
      <input
        id="home-ask-input"
        className="home-ask-input"
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label="Message your assistant"
        autoComplete="off"
      />
      <button type="submit" className="home-ask-send" disabled={!text.trim()} aria-label="Send">
        →
      </button>
    </form>
  );
}

// --- Footer status line -----------------------------------------------------

function FooterStatus({ connected, cron }: { connected: boolean | null; cron: CronData | null }) {
  const next = cron?.enabled ? nextCronLabel(cron) : null;
  const dotClass = connected === false ? "home-foot-dot error" : "home-foot-dot";
  const dotState = connected === false ? "offline" : "idle";
  return (
    <div className="home-foot">
      <span className={dotClass} aria-hidden="true" />
      <span>{dotState}</span>
      {next && (
        <>
          <span aria-hidden="true">·</span>
          <span>next: {next}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <a href="#/agents">activity →</a>
    </div>
  );
}

// --- Helpers ----------------------------------------------------------------

function resolveAgentName(store: ReturnType<typeof useChatStore>): string | null {
  const selected = store.selectedAgent;
  if (selected && store.agents[selected]) return selected;
  return null;
}

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

/** Pick the soonest enabled cron job's name + HH:MM, if cheaply derivable. */
function nextCronLabel(cron: CronData): string | null {
  const enabled = cron.jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return null;
  // schedules are cron expressions; surface a time-of-day when the minute/hour
  // fields are plain numbers, otherwise just the job name.
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
