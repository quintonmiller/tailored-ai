import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { type ChatStore, useChatStore } from "../components/ChatContext";
import { SuggestionChips } from "../components/SuggestionChips";
import { type NeedsYouItem, useNeedsYou } from "../hooks/useNeedsYou";
import { type FeedItem, useTodayFeed } from "../hooks/useTodayFeed";

marked.setOptions({ breaks: true, gfm: true });

const ACTIVITY_POLL_MS = 5000;
const SLOW_POLL_MS = 30000;
const NEEDS_YOU_MAX = 4;
const THREAD_TAIL = 6;

/**
 * Home — the assistant's surface, now a two-zone layout.
 *
 * On wide viewports it's a grid: a primary 640px column + a secondary "Today"
 * rail (ambient peripheral vision, not a second content column). Below the
 * breakpoint the rail stacks under the column for a single-column mobile read.
 *
 * The primary column descends in importance: the agent speaks (the serif
 * briefing hero, body upright with at most one italic accent), shows what needs
 * you (a flat hairline stack), then — the new heart of the page — HOSTS the
 * actual current chat session inline. The docked ask bar and suggestion chips
 * call store.send() and stay here; the tail of the live transcript renders just
 * above the bar (markdown for the agent, live status + interrupt while sending,
 * inline approval rows), with a quiet "open full chat" escape hatch. No more
 * handoff to /chat.
 *
 * The right rail is the live "Today" feed (useTodayFeed) — timestamped events
 * merged client-side from existing endpoints, polled on a single interval.
 *
 * Every data source is one of the existing config-gated endpoints; with the
 * briefing/suggestions features off, or an empty session, the page still reads
 * as intentional, never broken.
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

  // Send through the shared app-wide store and STAY on Home — the inline thread
  // below the ask bar renders the live turn. No route handoff.
  const onSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      store.send(trimmed);
    },
    [store],
  );

  return (
    <div className="home">
      <div className="home-grid">
        <div className="home-col">
          <Eyebrow activeTask={activeTask} />
          <BriefingHero />
          <NeedsYou items={needsYou} />
          <QuickActions onPick={onSend} />
          <div className="home-dock home-reveal" style={revealDelay(4)}>
            <Thread store={store} />
            <AskBar agentName={resolveAgentName(store)} onSubmit={onSend} />
            <FooterStatus connected={connected} cron={cron} />
          </div>
        </div>
        <TodayRail items={feed} />
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

// --- Inline live thread -----------------------------------------------------

/**
 * The lightweight live surface: the tail of the current session, a sending
 * status row with interrupt, and inline approval rows. No tool logs or copy
 * buttons — that detail lives on /chat. Renders nothing when there's no
 * conversation and nothing in flight, so the page stays clean for new users.
 */
function Thread({ store }: { store: ChatStore }) {
  const { messages, sending, activeTool, activityDesc, approvals } = store;
  const tail = messages.slice(-THREAD_TAIL);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // One signature that flips whenever the visible thread changes (new message,
  // a tool starts/stops, the status line updates). The effect reads it so the
  // dependency is honest while still re-scrolling on every relevant change.
  // Scroll only the thread's own box — scrollIntoView would also scroll the
  // app scroller, yanking the whole page down on mount.
  const scrollSig = `${messages.length}|${sending}|${activeTool ?? ""}|${activityDesc ?? ""}`;
  useEffect(() => {
    const el = scrollRef.current;
    if (scrollSig && el) el.scrollTop = el.scrollHeight;
  }, [scrollSig]);

  const hasContent = tail.length > 0 || sending || approvals.length > 0;
  if (!hasContent) return null;

  const statusText = activityDesc ?? (activeTool ? `running ${activeTool}` : "thinking…");

  return (
    <div className="home-thread">
      <div className="home-thread-scroll" ref={scrollRef}>
        {tail.map((m, i) => (
          <ThreadLine key={`${i}-${m.role}`} role={m.role} content={m.content} agentName={resolveAgentName(store)} />
        ))}

        {sending && (
          <div className="home-thread-status" aria-live="polite">
            <span className="home-thread-status-text">
              {statusText}
              <span className="home-caret" aria-hidden="true">
                ▍
              </span>
            </span>
            <button type="button" className="home-thread-stop" onClick={store.interrupt}>
              stop
            </button>
          </div>
        )}

        {approvals.map((a) => (
          <div key={a.requestId} className="home-thread-approval">
            <span className="home-thread-approval-text" title={a.description ?? a.toolName}>
              <span className="home-thread-approval-tool">{a.toolName}</span>
              {a.description && <span className="home-thread-approval-desc">{a.description}</span>}
            </span>
            <span className="home-thread-approval-actions">
              <button type="button" className="home-thread-approve" onClick={() => store.approve(a.requestId)}>
                Approve
              </button>
              <button type="button" className="home-thread-reject" onClick={() => store.reject(a.requestId)}>
                Reject
              </button>
            </span>
          </div>
        ))}

      </div>
      {tail.length > 0 && (
        <a className="home-thread-open" href="#/chat">
          open full chat →
        </a>
      )}
    </div>
  );
}

function ThreadLine({
  role,
  content,
  agentName,
}: {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  agentName: string | null;
}) {
  const text = content ?? "";
  // Hooks run unconditionally (rules of hooks); the render guards below decide
  // whether the line shows at all.
  const html = useMemo(() => (role === "assistant" ? (marked.parse(text) as string) : ""), [role, text]);

  // Quiet surface — skip system/tool carriers and empty lines.
  if (role !== "user" && role !== "assistant") return null;
  if (!text.trim()) return null;

  const label = role === "user" ? "you" : (agentName ?? "agent");

  return (
    <div className={`home-thread-line home-thread-${role}`}>
      <span className="home-thread-label">{label}</span>
      {role === "assistant" ? (
        <div className="home-thread-body markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="home-thread-body">{text}</div>
      )}
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

// --- Today rail (live feed, secondary) --------------------------------------

function TodayRail({ items }: { items: FeedItem[] }) {
  // Track which keys have already been seen so freshly-arrived rows can fade in
  // without re-animating the whole list on every poll.
  const seenRef = useRef<Set<string>>(new Set());
  const seen = seenRef.current;
  const fresh = new Set<string>();
  for (const it of items) {
    if (!seen.has(it.key)) fresh.add(it.key);
  }
  useEffect(() => {
    for (const it of items) seen.add(it.key);
  });

  return (
    <aside className="home-rail home-reveal" style={revealDelay(2)} aria-label="Today">
      <h2 className="home-rail-label">Today</h2>
      {items.length === 0 ? (
        <p className="home-rail-empty">quiet so far.</p>
      ) : (
        <ul className="home-rail-list">
          {items.map((it) => {
            const row = (
              <>
                <span className="home-rail-time">{clock(it.at)}</span>
                <span className="home-rail-text">{it.text}</span>
              </>
            );
            return (
              <li key={it.key} className={`home-rail-row${fresh.has(it.key) ? " home-rail-fresh" : ""}`}>
                {it.href ? (
                  <a className="home-rail-link" href={it.href} title={it.text}>
                    {row}
                  </a>
                ) : (
                  <span className="home-rail-static" title={it.text}>
                    {row}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

// --- Helpers ----------------------------------------------------------------

function resolveAgentName(store: ChatStore): string | null {
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

/** 24h HH:MM stamp for a feed row. */
function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
