import { useCallback, useEffect, useState } from "react";
import {
  type AutopilotActivity,
  type CronData,
  type CronJobRow,
  type ExploratoryRun,
  fetchActivity,
  fetchAllPendingForms,
  fetchAutopilotActivity,
  fetchCron,
  fetchExploratoryRuns,
  fetchHealth,
  fetchPendingApprovals,
  fetchProjectTasks,
  fetchWorkflowRuns,
  type HealthInfo,
  type PendingApprovalRequest,
  type ProjectTask,
  type SessionActivity,
  type WorkflowFormPendingRow,
  type WorkflowRunRow,
} from "../api";
import { BriefingCard } from "../components/BriefingCard";

const ACTIVITY_POLL_MS = 3000;
const SLOW_POLL_MS = 30000;
const RECENT_LIMIT = 8;
const UPCOMING_LIMIT = 5;

export function Dashboard() {
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [autopilot, setAutopilot] = useState<AutopilotActivity | null>(null);
  const [backlog, setBacklog] = useState<ProjectTask[]>([]);
  const [blocked, setBlocked] = useState<ProjectTask[]>([]);
  const [recentDone, setRecentDone] = useState<ProjectTask[]>([]);
  const [pendingForms, setPendingForms] = useState<WorkflowFormPendingRow[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalRequest[]>([]);
  const [recentRuns, setRecentRuns] = useState<WorkflowRunRow[]>([]);
  const [recentTicks, setRecentTicks] = useState<ExploratoryRun[]>([]);
  const [cron, setCron] = useState<CronData | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);

  const refreshActivity = useCallback(() => {
    fetchActivity()
      .then(setActivity)
      .catch(() => {});
    fetchAutopilotActivity()
      .then(setAutopilot)
      .catch(() => {});
  }, []);

  const refreshSlow = useCallback(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => {});
    fetchCron()
      .then(setCron)
      .catch(() => {});
    fetchProjectTasks({ status: "backlog", order_by: "rank", limit: UPCOMING_LIMIT })
      .then((r) => setBacklog(r.tasks))
      .catch(() => {});
    fetchProjectTasks({ status: "blocked", order_by: "updated_at", limit: 10 })
      .then((r) => setBlocked(r.tasks))
      .catch(() => {});
    fetchProjectTasks({ status: "done", order_by: "updated_at", limit: RECENT_LIMIT })
      .then((r) => setRecentDone(r.tasks))
      .catch(() => {});
    fetchAllPendingForms()
      .then((r) => setPendingForms(r.forms))
      .catch(() => {});
    fetchPendingApprovals()
      .then(setPendingApprovals)
      .catch(() => {});
    fetchWorkflowRuns({ limit: RECENT_LIMIT })
      .then(setRecentRuns)
      .catch(() => {});
    // Recent exploratory ticks — the prose summary of each agent tick.
    // Surfaces the actual work the default/online agents are doing (routing
    // tasks, writing docs, recall notes) that would otherwise be invisible
    // because backlog/done counts don't change when tasks are re-routed.
    fetchExploratoryRuns({ limit: RECENT_LIMIT })
      .then((r) => setRecentTicks(r.runs))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshActivity();
    refreshSlow();
    const a = setInterval(refreshActivity, ACTIVITY_POLL_MS);
    const s = setInterval(refreshSlow, SLOW_POLL_MS);
    return () => {
      clearInterval(a);
      clearInterval(s);
    };
  }, [refreshActivity, refreshSlow]);

  const liveAgents = activity.filter((a) => a.status !== "idle");
  const failedRuns = recentRuns.filter((r) => r.status === "failed");
  const recentFinishedRuns = recentRuns.filter((r) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(r.status),
  );
  const needsHumanCount = blocked.length + pendingForms.length + pendingApprovals.length + failedRuns.length;
  const enabledCron = (cron?.jobs ?? []).filter((j) => j.enabled).slice(0, UPCOMING_LIMIT);

  return (
    <div className="dashboard dashboard-home">
      {/* BRIEFING: LLM-written summary at the top. Renders nothing when the
          briefing feature is disabled (the default), so Home is unchanged. */}
      <BriefingCard />

      {/* NOW: live activity */}
      <DashboardSection title="Now">
        <NowPanel liveAgents={liveAgents} autopilot={autopilot} />
      </DashboardSection>

      {/* NEEDS HUMAN */}
      <DashboardSection title="Needs Human" count={needsHumanCount} emphasized={needsHumanCount > 0}>
        <NeedsHumanPanel
          blocked={blocked}
          pendingForms={pendingForms}
          pendingApprovals={pendingApprovals}
          failedRuns={failedRuns}
        />
      </DashboardSection>

      {/* UPCOMING */}
      <DashboardSection title="Upcoming">
        <UpcomingPanel backlog={backlog} cron={enabledCron} />
      </DashboardSection>

      {/* RECENT */}
      <DashboardSection title="Recent">
        <RecentPanel runs={recentFinishedRuns} tasks={recentDone} ticks={recentTicks} />
      </DashboardSection>

      {/* Compact health footer */}
      <HealthFooter health={health} />
    </div>
  );
}

function DashboardSection(props: { title: string; count?: number; emphasized?: boolean; children: React.ReactNode }) {
  const { title, count, emphasized, children } = props;
  return (
    <section className={`dash-section ${emphasized ? "dash-section-alert" : ""}`}>
      <header className="dash-section-header">
        <h3>{title}</h3>
        {typeof count === "number" && count > 0 && <span className="dash-section-badge">{count}</span>}
      </header>
      {children}
    </section>
  );
}

function NowPanel(props: { liveAgents: SessionActivity[]; autopilot: AutopilotActivity | null }) {
  const { liveAgents, autopilot } = props;
  const items: { label: string; description: string; status?: string }[] = [];
  for (const a of liveAgents) {
    items.push({
      label: a.agentName ?? "(unnamed)",
      description: a.description ?? a.status,
      status: a.status,
    });
  }
  if (autopilot?.current) {
    items.push({
      label: "autopilot",
      description: autopilot.current.title,
      status: "running",
    });
  }
  if (items.length === 0) {
    return <div className="dash-empty">Nothing running right now.</div>;
  }
  return (
    <ul className="dash-now-list">
      {items.map((it, i) => (
        <li key={i} className="dash-now-item">
          <span className="dash-now-pulse" />
          <span className="dash-now-label">{it.label}</span>
          <span className="dash-now-desc">{it.description}</span>
        </li>
      ))}
    </ul>
  );
}

function NeedsHumanPanel(props: {
  blocked: ProjectTask[];
  pendingForms: WorkflowFormPendingRow[];
  pendingApprovals: PendingApprovalRequest[];
  failedRuns: WorkflowRunRow[];
}) {
  const { blocked, pendingForms, pendingApprovals, failedRuns } = props;
  if (blocked.length === 0 && pendingForms.length === 0 && pendingApprovals.length === 0 && failedRuns.length === 0) {
    return <div className="dash-empty">Nothing waiting on you.</div>;
  }
  return (
    <ul className="dash-needs-list">
      {pendingForms.map((f) => (
        <li key={`form-${f.id}`} className="dash-needs-item dash-needs-form">
          <span className="dash-needs-kind">Form</span>
          <a href={`#/workflow-runs/${encodeURIComponent(f.run_id)}`} className="dash-needs-title">
            {f.prompt || `${f.step_name} input required`}
          </a>
          <span className="dash-needs-meta">{relTime(f.created_at)}</span>
        </li>
      ))}
      {pendingApprovals.map((a) => (
        <li key={`approval-${a.requestId}`} className="dash-needs-item dash-needs-approval">
          <span className="dash-needs-kind">Approve</span>
          <a href="#/resources" className="dash-needs-title">
            {a.description || a.toolName}
          </a>
          <span className="dash-needs-meta">{a.toolName}</span>
        </li>
      ))}
      {blocked.map((t) => (
        <li key={`blocked-${t.id}`} className="dash-needs-item dash-needs-blocked">
          <span className="dash-needs-kind">Blocked</span>
          <a href={`#/tasks/${encodeURIComponent(t.id)}`} className="dash-needs-title">
            {t.title}
          </a>
          <span className="dash-needs-meta">
            {t.blocked_reason ? `${t.blocked_reason} · ` : ""}
            {relTime(t.updated_at)}
          </span>
        </li>
      ))}
      {failedRuns.map((r) => (
        <li key={`run-${r.id}`} className="dash-needs-item dash-needs-failed">
          <span className="dash-needs-kind">Failed</span>
          <a href={`#/workflow-runs/${encodeURIComponent(r.id)}`} className="dash-needs-title">
            {r.workflow_name}
          </a>
          <span className="dash-needs-meta">{r.error ? truncate(r.error, 40) : "no error message"}</span>
        </li>
      ))}
    </ul>
  );
}

function UpcomingPanel(props: { backlog: ProjectTask[]; cron: CronJobRow[] }) {
  const { backlog, cron } = props;
  if (backlog.length === 0 && cron.length === 0) {
    return <div className="dash-empty">Nothing scheduled or queued.</div>;
  }
  return (
    <div className="dash-upcoming">
      {backlog.length > 0 && (
        <div className="dash-upcoming-group">
          <h4>Next up</h4>
          <ul className="dash-upcoming-list">
            {backlog.map((t) => (
              <li key={t.id}>
                <a href={`#/tasks/${encodeURIComponent(t.id)}`}>
                  <span className="dash-upcoming-title">{t.title}</span>
                  {t.assignee && <span className="dash-upcoming-assignee">{t.assignee}</span>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {cron.length > 0 && (
        <div className="dash-upcoming-group">
          <h4>Scheduled</h4>
          <ul className="dash-upcoming-list">
            {cron.map((j) => (
              <li key={j.name}>
                <a href="#/config/cron">
                  <span className="dash-upcoming-title">{j.name}</span>
                  <span className="dash-upcoming-assignee">{j.schedule}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RecentPanel(props: { runs: WorkflowRunRow[]; tasks: ProjectTask[]; ticks: ExploratoryRun[] }) {
  const { runs, tasks, ticks } = props;
  const merged: {
    key: string;
    when: string;
    kind: "run" | "task" | "tick";
    title: string;
    detail: string;
    href: string;
    status: string;
  }[] = [];
  for (const r of runs) {
    merged.push({
      key: `run-${r.id}`,
      when: r.completed_at ?? r.started_at,
      kind: "run",
      title: r.workflow_name,
      detail: r.status,
      href: `#/workflow-runs/${encodeURIComponent(r.id)}`,
      status: r.status,
    });
  }
  for (const t of tasks) {
    merged.push({
      key: `task-${t.id}`,
      when: t.updated_at,
      kind: "task",
      title: t.title,
      detail: "done",
      href: `#/tasks/${encodeURIComponent(t.id)}`,
      status: "completed",
    });
  }
  for (const x of ticks) {
    // Strip the "[Sleep] " prefix and any leading newlines/whitespace so the
    // first sentence of the actual work is what surfaces.
    const raw = (x.summary ?? x.error ?? "").trim();
    const firstLine =
      raw
        .replace(/^\[Sleep\]\s*/i, "")
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s.length > 0) ?? "";
    if (!firstLine) continue;
    const isSleep = /^\[Sleep\]/i.test(raw);
    merged.push({
      key: `tick-${x.id}`,
      when: x.ended_at ?? x.started_at,
      kind: "tick",
      title: firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine,
      detail: `${x.agent_name}${isSleep ? " · idle" : ""}`,
      href: `#/agents/${encodeURIComponent(x.agent_name)}`,
      status: x.status === "error" ? "failed" : isSleep ? "idle" : x.status,
    });
  }
  merged.sort((a, b) => (a.when < b.when ? 1 : -1));
  const top = merged.slice(0, RECENT_LIMIT);
  if (top.length === 0) {
    return <div className="dash-empty">No recent activity.</div>;
  }
  return (
    <ul className="dash-recent-list">
      {top.map((it) => (
        <li key={it.key} className={`dash-recent-item dash-recent-${it.status}`}>
          <a href={it.href}>
            <span className="dash-recent-title">{it.title}</span>
            <span className="dash-recent-meta">
              {it.kind} · {it.detail} · {relTime(it.when)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function HealthFooter(props: { health: HealthInfo | null }) {
  const { health } = props;
  if (!health) return null;
  return (
    <div className="dash-health-footer">
      <span className={`dash-health-pip ${health.status === "ok" ? "ok" : ""}`} />
      <span>
        {health.provider}/{health.model}
      </span>
      <span className="dash-health-sep">·</span>
      <a href="#/tools">{health.tools} tools</a>
      <span className="dash-health-sep">·</span>
      <span>up {formatUptime(health.uptime)}</span>
      <span className="dash-health-sep">·</span>
      <a href="#/config">configure</a>
    </div>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const m = Math.floor(diffMs / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const day = Math.floor(h / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
