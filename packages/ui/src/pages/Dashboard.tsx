import { useEffect, useRef, useState } from "react";
import {
  type AgentInfo,
  type ContextData,
  type CronData,
  type ProjectsResponse,
  fetchContext,
  fetchCron,
  fetchHealth,
  fetchAgents,
  fetchProjects,
  fetchSessions,
  fetchBackgroundTasks,
  fetchActivity,
  type HealthInfo,
  type SessionRow,
  type SessionActivity,
  type TaskInfo,
} from "../api";
import { AgentCard } from "../components/AgentCard";
import { ContextFiles } from "../components/ContextFiles";
import { CronJobList } from "../components/CronJobList";
import { SessionList } from "../components/SessionList";
import { TaskList } from "../components/TaskList";

const PROJECT_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

export function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentInfo> | null>(null);
  const [cron, setCron] = useState<CronData | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [projects, setProjects] = useState<ProjectsResponse | null>(null);
  const [context, setContext] = useState<ContextData | null>(null);
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const activityPollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    const onError = (e: Error) => setError(e.message);

    fetchHealth().then(setHealth).catch(onError);
    fetchSessions().then(setSessions).catch(onError);
    fetchAgents().then(setAgents).catch(onError);
    fetchCron().then(setCron).catch(onError);
    fetchBackgroundTasks().then(setTasks).catch(onError);
    fetchProjects({ limit: 10 }).then(setProjects).catch(onError);
    fetchContext().then(setContext).catch(onError);
    fetchActivity().then(setActivity).catch(() => {});
  }, []);

  // Poll activity every 3s
  useEffect(() => {
    activityPollRef.current = setInterval(() => {
      fetchActivity().then(setActivity).catch(() => {});
    }, 3000);
    return () => {
      if (activityPollRef.current) clearInterval(activityPollRef.current);
    };
  }, []);

  // Auto-poll tasks when any are running
  useEffect(() => {
    if (!tasks) return;
    const hasRunning = tasks.some((t) => t.status === "running");
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(() => {
        fetchBackgroundTasks()
          .then(setTasks)
          .catch(() => {});
      }, 5000);
    } else if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = undefined;
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tasks]);

  const agentEntries = agents ? Object.entries(agents) : [];
  const activityByName = new Map(activity.map((a) => [a.agentName, a]));

  return (
    <div className="dashboard">
      <div className="dashboard-section-header">
        <h2>Status</h2>
        <a href="#/config" className="dashboard-section-link">Configure providers</a>
      </div>
      {health ? (
        <div className="health-grid">
          <div className="health-card">
            <div className="label">Status</div>
            <div className={`value ${health.status === "ok" ? "ok" : ""}`}>{health.status}</div>
          </div>
          <div className="health-card">
            <div className="label">Provider</div>
            <div className="value">{health.provider}</div>
          </div>
          <div className="health-card">
            <div className="label">Model</div>
            <div className="value">{health.model}</div>
          </div>
          <div className="health-card">
            <div className="label">Tools</div>
            <div className="value">
              <a href="#/tools" className="health-link">
                {health.tools}
              </a>
            </div>
          </div>
          <div className="health-card">
            <div className="label">Uptime</div>
            <div className="value">{formatUptime(health.uptime)}</div>
          </div>
        </div>
      ) : (
        <div className="health-grid">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="health-card skeleton-pulse">
              <div className="label">&nbsp;</div>
              <div className="value">&nbsp;</div>
            </div>
          ))}
        </div>
      )}

      <div className="dashboard-section-header">
        <h2>Agents</h2>
        <a href="#/config/agents" className="dashboard-section-link">+ Add agent</a>
      </div>
      {agents === null ? (
        <div className="skeleton-list">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      ) : agentEntries.length === 0 ? (
        <div className="empty-state">No agents configured. <a href="#/config/agents" className="dashboard-section-link">Add one</a></div>
      ) : (
        <div className="agent-grid">
          {agentEntries.map(([name, agentDef]) => (
            <AgentCard key={name} name={name} agent={agentDef} activity={activityByName.get(name)} />
          ))}
        </div>
      )}

      <div className="dashboard-section-header">
        <h2>Cron Jobs</h2>
        <a href="#/config/cron" className="dashboard-section-link">+ Add job</a>
      </div>
      {cron ? (
        <CronJobList data={cron} onJobTriggered={() => fetchCron().then(setCron)} />
      ) : (
        <div className="skeleton-list">
          <div className="skeleton-card" />
        </div>
      )}

      <div className="dashboard-section-header">
        <h2>Projects</h2>
        <a href="#/projects" className="dashboard-section-link">View all</a>
      </div>
      {projects ? (
        projects.total === 0 ? (
          <div className="empty-state">No projects yet. <a href="#/projects" className="dashboard-section-link">Create one</a></div>
        ) : (
          <div className="project-card-grid">
            {projects.projects.slice(0, 5).map((p) => (
              <a key={p.id} href={`#/projects/${p.id}`} className="project-card">
                <div className="project-card-header">
                  <span className={`project-status-dot ${p.status}`} />
                  <span className="project-card-title">{p.title}</span>
                  <span className="project-card-status">{PROJECT_STATUS_LABELS[p.status] ?? p.status}</span>
                </div>
                {p.description && (
                  <div className="project-card-desc">{p.description}</div>
                )}
                <div className="project-card-counts">
                  <span>{p.task_count} tasks</span>
                  <span>{p.document_count} docs</span>
                </div>
              </a>
            ))}
            {projects.total > 5 && (
              <a href="#/projects" className="ptask-recent-more">
                +{projects.total - 5} more
              </a>
            )}
          </div>
        )
      ) : (
        <div className="skeleton-list"><div className="skeleton-card" /></div>
      )}

      <h2>Background Tasks</h2>
      {tasks ? (
        <TaskList tasks={tasks} />
      ) : (
        <div className="skeleton-list">
          <div className="skeleton-card" />
        </div>
      )}

      <div className="dashboard-section-header">
        <h2>Context Files</h2>
      </div>
      {context ? (
        <ContextFiles data={context} />
      ) : (
        <div className="skeleton-list">
          <div className="skeleton-card" />
        </div>
      )}

      <h2>Sessions</h2>
      {sessions ? (
        <SessionList sessions={sessions} />
      ) : (
        <div className="skeleton-list">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
