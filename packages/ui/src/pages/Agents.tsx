import { useEffect, useState } from "react";
import {
  type AgentDefinitionPatch,
  type AgentInfo,
  createAgent,
  deleteAgent,
  disableExploratoryAgent,
  type ExploratoryActivity,
  type ExploratoryAgent,
  type ExploratoryRun,
  fetchAgents,
  fetchExploratoryAgents,
  fetchExploratoryRun,
  fetchExploratoryRuns,
  fetchMemoryNotes,
  fetchProjectTasks,
  fetchSessions,
  fetchSkills,
  fetchTaskCommentsByAuthor,
  fetchTools,
  type MemoryNote,
  type ProjectTask,
  pauseExploratoryAgent,
  resumeExploratoryAgent,
  runExploratoryAgent,
  type SessionRow,
  type SkillCatalogEntry,
  type TaskCommentWithTask,
  updateAgent,
} from "../api";
import { describeError, useToast } from "../components/Toast";

interface AgentsPageProps {
  agentName?: string;
}

interface CombinedAgent {
  name: string;
  info: AgentInfo;
  watcher: ExploratoryAgent | null;
}

export function Agents({ agentName }: AgentsPageProps) {
  const [agents, setAgents] = useState<CombinedAgent[] | null>(null);
  const [activity, setActivity] = useState<ExploratoryActivity | null>(null);
  const [exploratoryEnabled, setExploratoryEnabled] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [editor, setEditor] = useState<null | { mode: "create" } | { mode: "edit"; name: string; info: AgentInfo }>(
    null,
  );
  const toast = useToast();

  const reload = () => {
    Promise.all([fetchAgents(), fetchExploratoryAgents()])
      .then(([all, exp]) => {
        const watcherByName = new Map(exp.agents.map((w) => [w.name, w]));
        const combined: CombinedAgent[] = Object.entries(all).map(([name, info]) => ({
          name,
          info,
          watcher: watcherByName.get(name) ?? null,
        }));
        combined.sort((a, b) => {
          // online-enabled agents first, then alpha
          const aOnline = a.watcher ? 1 : 0;
          const bOnline = b.watcher ? 1 : 0;
          if (aOnline !== bOnline) return bOnline - aOnline;
          return a.name.localeCompare(b.name);
        });
        setAgents(combined);
        setActivity(exp.activity);
        setExploratoryEnabled(exp.enabled);
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(() => {
    reload();
    const id = setInterval(reload, 5_000);
    return () => clearInterval(id);
  }, [reload]);

  if (err) return <div className="page-error">Error: {err}</div>;
  if (!agents) return <div className="page-loading">Loading…</div>;

  if (agents.length === 0) {
    return (
      <div className="agents-page">
        <h1>Agents</h1>
        <div className="agents-empty">
          No agents defined in <code>config.yaml</code>.
        </div>
      </div>
    );
  }

  const selected = agentName ? agents.find((a) => a.name === agentName) : null;

  return (
    <div className="agents-page">
      <div className="agents-layout">
        <aside className="agents-sidebar">
          <header className="agents-sidebar-header">
            <h2>Agents</h2>
            <div className="agents-sidebar-header-actions">
              <span className="agents-count">{agents.length}</span>
              <button
                type="button"
                className="agents-new-btn"
                onClick={() => setEditor({ mode: "create" })}
                aria-label="Create new agent"
              >
                + New
              </button>
            </div>
          </header>
          <ul className="agents-sidebar-list">
            {agents.map((a) => {
              const running = activity?.agentName === a.name;
              const paused = a.watcher?.paused_until && new Date(a.watcher.paused_until) > new Date();
              const status: string = a.watcher
                ? !a.watcher.enabled_in_state
                  ? "off"
                  : paused
                    ? "paused"
                    : running
                      ? "running"
                      : (a.watcher.last_tick_status ?? "idle")
                : "static";
              const isActive = a.name === agentName;
              return (
                <li key={a.name}>
                  <a href={`#/agents/${a.name}`} className={`agents-sidebar-item ${isActive ? "active" : ""}`}>
                    <span className={`agent-state state-${status}`}>{status}</span>
                    <div className="agents-sidebar-meta">
                      <div className="agents-sidebar-name">{a.name}</div>
                      <div className="agents-sidebar-sub">
                        {a.watcher ? (
                          <>
                            {a.watcher.runs_today} runs · {a.watcher.tokens_today.toLocaleString()} tok
                          </>
                        ) : (
                          <>{a.info.tools?.length ?? 0} tools</>
                        )}
                      </div>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        </aside>
        <section className="agents-detail">
          {selected ? (
            <AgentDetail
              agent={selected}
              activity={activity?.agentName === selected.name ? activity : null}
              exploratoryEnabled={exploratoryEnabled}
              onAction={reload}
              onEdit={() => setEditor({ mode: "edit", name: selected.name, info: selected.info })}
              onDelete={async () => {
                if (!confirm(`Delete agent "${selected.name}"? This is permanent.`)) return;
                try {
                  await deleteAgent(selected.name);
                  toast.success(`Agent "${selected.name}" deleted`);
                  window.location.hash = "/agents";
                  reload();
                } catch (e) {
                  toast.error(`Delete failed: ${describeError(e)}`);
                }
              }}
            />
          ) : (
            <AgentOverview agents={agents} activity={activity} />
          )}
        </section>
      </div>
      {editor && (
        <AgentEditorModal
          mode={editor.mode}
          existingNames={agents.map((a) => a.name)}
          initialName={editor.mode === "edit" ? editor.name : ""}
          initialInfo={editor.mode === "edit" ? editor.info : undefined}
          onClose={() => setEditor(null)}
          onSaved={(name) => {
            setEditor(null);
            reload();
            window.location.hash = `/agents/${name}`;
          }}
        />
      )}
    </div>
  );
}

function AgentOverview({ agents, activity }: { agents: CombinedAgent[]; activity: ExploratoryActivity | null }) {
  const watchers = agents.filter((a) => a.watcher);
  return (
    <div className="agent-overview">
      <h1>Agents</h1>
      <p className="agent-overview-lead">
        {activity ? (
          <>
            <strong>{activity.agentName}</strong> is running right now (started {timeAgo(activity.startedAt)}).
          </>
        ) : watchers.length === 0 ? (
          <>No agents in online mode. All agents are available for chat or cron-triggered runs.</>
        ) : (
          <>
            {watchers.length} watcher{watchers.length === 1 ? "" : "s"} configured · all idle.
          </>
        )}
      </p>
      <p className="agent-overview-hint">
        Pick an agent on the left to see its config, recent activity, and (for online agents) live runs.
      </p>
    </div>
  );
}

function AgentDetail({
  agent,
  activity,
  exploratoryEnabled,
  onAction,
  onEdit,
  onDelete,
}: {
  agent: CombinedAgent;
  activity: ExploratoryActivity | null;
  exploratoryEnabled: boolean;
  onAction: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const w = agent.watcher;
  const paused = w?.paused_until && new Date(w.paused_until) > new Date();
  const running = !!activity;
  const status: string = w
    ? !w.enabled_in_state
      ? "off"
      : paused
        ? "paused"
        : running
          ? "running"
          : (w.last_tick_status ?? "idle")
    : "static";

  return (
    <div className="agent-detail">
      <AgentDetailHeader
        agent={agent}
        status={status}
        paused={!!paused}
        onAction={onAction}
        onEdit={onEdit}
        onDelete={onDelete}
      />
      <AgentConfigCard info={agent.info} hasWatcher={!!w} />
      {w ? (
        <>
          <div className="agent-detail-grid">
            <StatTile label="Runs today" value={w.runs_today.toLocaleString()} />
            <StatTile label="Tokens today" value={w.tokens_today.toLocaleString()} />
            <StatTile
              label="Current interval"
              value={w.current_interval_ms ? formatInterval(w.current_interval_ms) : "—"}
            />
            <StatTile
              label="Last tick"
              value={w.last_tick_at ? timeAgo(w.last_tick_at) : "never"}
              sub={w.last_tick_status ?? undefined}
            />
          </div>
          <AgentNowSection watcher={w} activity={activity} />
          <AgentRecentWorkSection name={agent.name} />
          <AgentUpcomingSection name={agent.name} watcher={w} />
          <AgentHistorySection name={agent.name} activity={activity} />
        </>
      ) : (
        <>
          <AgentRecentWorkSection name={agent.name} />
          <AgentStaticActivity name={agent.name} exploratoryEnabled={exploratoryEnabled} />
        </>
      )}
    </div>
  );
}

function AgentDetailHeader({
  agent,
  status,
  paused,
  onAction,
  onEdit,
  onDelete,
}: {
  agent: CombinedAgent;
  status: string;
  paused: boolean;
  onAction: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const handle = async (action: "pause" | "resume" | "run" | "disable") => {
    setBusy(action);
    try {
      if (action === "pause") await pauseExploratoryAgent(agent.name, 4);
      else if (action === "resume") await resumeExploratoryAgent(agent.name);
      else if (action === "disable") await disableExploratoryAgent(agent.name);
      else if (action === "run") await runExploratoryAgent(agent.name);
      onAction();
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="agent-detail-header">
      <div className="agent-detail-title">
        <span className={`agent-state agent-state-lg state-${status}`}>{status}</span>
        <h1>{agent.name}</h1>
      </div>
      <div className="agent-detail-actions">
        {agent.watcher ? (
          <>
            <button type="button" disabled={busy !== null} onClick={() => handle("run")}>
              {busy === "run" ? "Starting…" : "Run now"}
            </button>
            {paused ? (
              <button type="button" disabled={busy !== null} onClick={() => handle("resume")}>
                Resume
              </button>
            ) : (
              <button type="button" disabled={busy !== null} onClick={() => handle("pause")}>
                Pause 4h
              </button>
            )}
            {agent.watcher.enabled_in_state && (
              <button type="button" className="danger" disabled={busy !== null} onClick={() => handle("disable")}>
                Disable
              </button>
            )}
          </>
        ) : (
          <a className="agent-chat-link" href={`#/chat?key=${encodeURIComponent(`web:${agent.name}:${Date.now()}`)}`}>
            Open in chat
          </a>
        )}
        <button type="button" onClick={onEdit} disabled={busy !== null}>
          Edit
        </button>
        <button type="button" className="danger" onClick={onDelete} disabled={busy !== null}>
          Delete
        </button>
      </div>
    </header>
  );
}

function AgentConfigCard({ info, hasWatcher }: { info: AgentInfo; hasWatcher: boolean }) {
  return (
    <section className="agent-section">
      <h2>Configuration</h2>
      {info.description && <p className="agent-config-description">{info.description}</p>}
      <div className="agent-config-row">
        {info.model && (
          <span>
            <strong>Model:</strong> {info.model}
          </span>
        )}
        {info.temperature !== undefined && (
          <span>
            <strong>Temp:</strong> {info.temperature}
          </span>
        )}
        {info.maxToolRounds !== undefined && (
          <span>
            <strong>Max rounds:</strong> {info.maxToolRounds}
          </span>
        )}
        <span>
          <strong>Online:</strong> {hasWatcher ? "yes" : "no"}
        </span>
      </div>
      {info.tools && info.tools.length > 0 && (
        <div className="agent-config-tools">
          <strong>Tools:</strong>{" "}
          {info.tools.map((t) => (
            <span key={t} className="agent-tool-chip">
              {t}
            </span>
          ))}
        </div>
      )}
      {info.skills && info.skills.length > 0 && (
        <div className="agent-config-tools">
          <strong>Skills:</strong>{" "}
          {info.skills.map((s) => (
            <span key={s} className="agent-tool-chip">
              {s}
            </span>
          ))}
          {info.skillLoading && (
            <span className="agent-tool-chip" style={{ opacity: 0.7 }}>
              {info.skillLoading}
            </span>
          )}
        </div>
      )}
      {info.instructions && (
        <details className="agent-config-instructions">
          <summary>Instructions</summary>
          <pre>{info.instructions.trim()}</pre>
        </details>
      )}
    </section>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="agent-stat-tile">
      <div className="agent-stat-label">{label}</div>
      <div className="agent-stat-value">{value}</div>
      {sub && <div className="agent-stat-sub">{sub}</div>}
    </div>
  );
}

function AgentNowSection({ watcher, activity }: { watcher: ExploratoryAgent; activity: ExploratoryActivity | null }) {
  const [run, setRun] = useState<ExploratoryRun | null>(null);

  useEffect(() => {
    if (!activity) {
      setRun(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetchExploratoryRun(activity.runId)
        .then((r) => !cancelled && setRun(r))
        .catch(() => {});
    load();
    const id = setInterval(load, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activity?.runId, activity]);

  if (!activity) {
    const nextAt =
      watcher.last_tick_at && watcher.current_interval_ms
        ? new Date(new Date(watcher.last_tick_at).getTime() + watcher.current_interval_ms)
        : null;
    return (
      <section className="agent-section">
        <h2>Now</h2>
        <div className="agent-now-idle">
          Not running.{" "}
          {nextAt ? (
            <>
              Next tick {timeAgo(nextAt.toISOString())} ({nextAt.toLocaleTimeString()}).
            </>
          ) : (
            <>Awaiting first tick.</>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="agent-section">
      <h2>Now</h2>
      <div className="agent-now-running">
        <div className="agent-now-row">
          <span className="agent-now-pulse" />
          <span>
            Running <code>{activity.runId}</code> · started {timeAgo(activity.startedAt)}
          </span>
        </div>
        {run && (
          <div className="agent-now-stats">
            {(run.tool_calls ?? 0) > 0 && <span>{run.tool_calls} tool calls</span>}
            {(run.tokens_used ?? 0) > 0 && <span>{run.tokens_used?.toLocaleString()} tokens</span>}
            {run.note_ids.length > 0 && (
              <span>
                {run.note_ids.length} note{run.note_ids.length === 1 ? "" : "s"}
              </span>
            )}
            {run.task_ids.length > 0 && (
              <span>
                {run.task_ids.length} task{run.task_ids.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Surfaces "what has this agent been working on?" for any agent — online,
 * task-watcher-dispatched (coder/reviewer), or chat-only. Two data sources:
 *   1) tasks currently assigned to the agent (any non-archived status)
 *   2) recent comments authored by the agent (catches work the agent did
 *      before handing the task off; the assignee field forgets old owners)
 * Both feeds dedupe by task_id; the assigned task wins so the live status
 * is shown.
 */
function AgentRecentWorkSection({ name }: { name: string }) {
  const [assigned, setAssigned] = useState<ProjectTask[] | null>(null);
  const [comments, setComments] = useState<TaskCommentWithTask[] | null>(null);

  const reload = () => {
    Promise.all([
      fetchProjectTasks({ assignee: name, limit: 20 }).catch(() => ({ tasks: [] as ProjectTask[], total: 0 })),
      fetchTaskCommentsByAuthor(name, 20).catch(() => ({ comments: [] as TaskCommentWithTask[] })),
    ]).then(([t, c]) => {
      setAssigned(t.tasks);
      setComments(c.comments);
    });
  };

  useEffect(() => {
    reload();
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [reload]);

  if (assigned === null || comments === null) {
    return (
      <section className="agent-section">
        <h2>Recent work</h2>
        <div className="agent-loading">Loading…</div>
      </section>
    );
  }

  const assignedIds = new Set(assigned.map((t) => t.id));
  // Group comments by task; keep the latest comment per task as the row label.
  const commentsByTask = new Map<string, TaskCommentWithTask>();
  for (const c of comments) {
    if (assignedIds.has(c.task_id)) continue;
    if (!commentsByTask.has(c.task_id)) commentsByTask.set(c.task_id, c);
  }

  if (assigned.length === 0 && commentsByTask.size === 0) {
    return (
      <section className="agent-section">
        <h2>Recent work</h2>
        <div className="agent-empty">
          No task activity yet. When this agent is assigned a task or comments on one, it will appear here.
        </div>
      </section>
    );
  }

  return (
    <section className="agent-section">
      <h2>Recent work</h2>

      {assigned.length > 0 && (
        <>
          <h3 className="agent-subhead">Currently assigned ({assigned.length})</h3>
          <ul className="agent-task-list">
            {assigned.map((t) => (
              <li key={t.id}>
                <span className={`agent-state state-${t.status}`}>{t.status}</span>{" "}
                <a href={`#/tasks/${t.id}`}>{t.title}</a>
                <span className="agent-task-meta">
                  updated {timeAgo(t.updated_at)}
                  {t.tags.length > 0 && <> · {t.tags.join(", ")}</>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {commentsByTask.size > 0 && (
        <>
          <h3 className="agent-subhead">Recent comments on other tasks ({commentsByTask.size})</h3>
          <ul className="agent-comment-list">
            {Array.from(commentsByTask.values()).map((c) => (
              <li key={c.id}>
                <div className="agent-comment-head">
                  <span className={`agent-state state-${c.task_status}`}>{c.task_status}</span>{" "}
                  <a href={`#/tasks/${c.task_id}`}>{c.task_title}</a>
                  <span className="agent-task-meta">
                    {timeAgo(c.created_at)}
                    {c.task_assignee && c.task_assignee !== name && <> · now assigned to {c.task_assignee}</>}
                  </span>
                </div>
                <div className="agent-comment-body">
                  {c.content.length > 200 ? `${c.content.slice(0, 200)}…` : c.content}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AgentUpcomingSection({ name, watcher }: { name: string; watcher: ExploratoryAgent }) {
  const [tasks, setTasks] = useState<ProjectTask[] | null>(null);
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchProjectTasks({ assignee: name, status: "backlog", limit: 10, order_by: "rank" }).catch(() => ({
        tasks: [] as ProjectTask[],
        total: 0,
      })),
      fetchMemoryNotes({ agent: name, tag: "goal", limit: 5 }).catch(() => [] as MemoryNote[]),
    ]).then(([t, n]) => {
      if (cancelled) return;
      setTasks(t.tasks ?? []);
      setNotes(n);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  const cadence = watcher.cadence;
  const win = cadence?.window;
  const intervalMin = cadence?.interval_minutes;

  return (
    <section className="agent-section">
      <h2>Upcoming</h2>
      <div className="agent-upcoming-cadence">
        {intervalMin !== undefined && (
          <span>
            Every <strong>{formatMinutes(intervalMin)}</strong>
          </span>
        )}
        {win && (
          <span>
            Window{" "}
            <strong>
              {win.start}–{win.end}
            </strong>
          </span>
        )}
        {cadence?.idle_backoff_multiplier !== undefined && cadence.idle_backoff_multiplier > 1 && (
          <span>
            Backoff ×<strong>{cadence.idle_backoff_multiplier}</strong>
          </span>
        )}
      </div>

      <h3 className="agent-subhead">Backlog tasks assigned to {name}</h3>
      {tasks === null ? (
        <div className="agent-loading">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="agent-empty">No backlog tasks assigned to this agent.</div>
      ) : (
        <ul className="agent-task-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <a href={`#/tasks/${t.id}`}>{t.title}</a>
              <span className="agent-task-meta">
                rank {t.rank} · {t.tags.join(", ") || "no tags"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="agent-subhead">Goals (tagged notes)</h3>
      {notes === null ? (
        <div className="agent-loading">Loading…</div>
      ) : notes.length === 0 ? (
        <div className="agent-empty">
          No goal notes. Tag a note with <code>goal</code> via the agent's <code>recall</code> tool to set standing
          intent.
        </div>
      ) : (
        <ul className="agent-note-list">
          {notes.map((n) => (
            <li key={n.id}>
              <div className="agent-note-content">{n.content}</div>
              <div className="agent-note-meta">
                {timeAgo(n.created_at)} · refs {n.ref_count}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentHistorySection({ name, activity }: { name: string; activity: ExploratoryActivity | null }) {
  const [runs, setRuns] = useState<ExploratoryRun[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = () => {
    fetchExploratoryRuns({ agent: name, limit: 30 })
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  };

  useEffect(() => {
    reload();
    const id = setInterval(reload, 10_000);
    return () => clearInterval(id);
  }, [reload]);

  if (runs === null)
    return (
      <section className="agent-section">
        <h2>History</h2>
        <div className="agent-loading">Loading…</div>
      </section>
    );

  return (
    <section className="agent-section">
      <h2>History</h2>
      {runs.length === 0 ? (
        <div className="agent-empty">No runs yet.</div>
      ) : (
        <ul className="agent-history-list">
          {runs.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              expanded={expanded === r.id}
              onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentStaticActivity({ name, exploratoryEnabled }: { name: string; exploratoryEnabled: boolean }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessions({ project: null })
      .then((rows) => {
        if (cancelled) return;
        const matches = rows.filter((s) => {
          if (!s.key) return false;
          // Match sessions that have this agent's name in their key segments.
          return s.key.split(":").includes(name);
        });
        matches.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        setSessions(matches.slice(0, 20));
      })
      .catch(() => setSessions([]));
    return () => {
      cancelled = true;
    };
  }, [name]);

  return (
    <>
      <section className="agent-section">
        <h2>Online mode</h2>
        <div className="agent-empty">
          This agent is not in online mode. Add an <code>online:</code> block to <code>agents.{name}</code> in your
          config to have it work autonomously on a cadence.
          {!exploratoryEnabled && (
            <>
              {" "}
              Note: <code>exploratory.enabled</code> is also off — set it to <code>true</code> first.
            </>
          )}
        </div>
      </section>
      <section className="agent-section">
        <h2>Recent sessions</h2>
        {sessions === null ? (
          <div className="agent-loading">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="agent-empty">No sessions associated with this agent.</div>
        ) : (
          <ul className="agent-session-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <a href={`#/chat?session=${s.id}`}>{s.key ?? s.id}</a>
                <span className="agent-task-meta">
                  {timeAgo(s.updated_at)} · {s.provider}/{s.model}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function RunRow({ run, expanded, onToggle }: { run: ExploratoryRun; expanded: boolean; onToggle: () => void }) {
  const duration = run.ended_at
    ? Math.max(0, new Date(run.ended_at).getTime() - new Date(run.started_at).getTime())
    : null;
  return (
    <li className={`agent-run-row ${expanded ? "expanded" : ""}`}>
      <button type="button" className="agent-run-summary" onClick={onToggle}>
        <span className={`agent-state state-${run.status}`}>{run.status}</span>
        <span className="agent-run-time">{timeAgo(run.started_at)}</span>
        <span className="agent-run-stats">
          {(run.tool_calls ?? 0) > 0 && <>{run.tool_calls} tools · </>}
          {(run.tokens_used ?? 0) > 0 && <>{run.tokens_used?.toLocaleString()} tok · </>}
          {run.note_ids.length > 0 && <>{run.note_ids.length} notes · </>}
          {run.task_ids.length > 0 && <>{run.task_ids.length} tasks · </>}
          {duration !== null && <>{formatDuration(duration)}</>}
        </span>
        <span className="agent-run-toggle">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="agent-run-detail">
          <div className="agent-run-id">
            <code>{run.id}</code> · session{" "}
            <a href={`#/chat?key=${encodeURIComponent(`exploratory:${run.agent_name}:${run.id}`)}`}>view transcript</a>
          </div>
          {run.summary && <div className="agent-run-summary-text">{run.summary}</div>}
          {run.error && <div className="agent-run-error">Error: {run.error}</div>}
          {run.note_ids.length > 0 && (
            <div className="agent-run-refs">
              <strong>Notes:</strong>{" "}
              {run.note_ids.map((id, i) => (
                <span key={id}>
                  {i > 0 && ", "}
                  <a href={`#/memory?id=${id}`}>{id}</a>
                </span>
              ))}
            </div>
          )}
          {run.task_ids.length > 0 && (
            <div className="agent-run-refs">
              <strong>Tasks:</strong>{" "}
              {run.task_ids.map((id, i) => (
                <span key={id}>
                  {i > 0 && ", "}
                  <a href={`#/tasks/${id}`}>{id}</a>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatMinutes(m: number): string {
  if (m < 1) return `${Math.round(m * 60)}s`;
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function AgentEditorModal({
  mode,
  existingNames,
  initialName,
  initialInfo,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  existingNames: string[];
  initialName: string;
  initialInfo?: AgentInfo;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialInfo?.description ?? "");
  const [model, setModel] = useState(initialInfo?.model ?? "");
  const [instructions, setInstructions] = useState(initialInfo?.instructions ?? "");
  const [temperature, setTemperature] = useState<string>(
    initialInfo?.temperature !== undefined ? String(initialInfo.temperature) : "",
  );
  const [maxToolRounds, setMaxToolRounds] = useState<string>(
    initialInfo?.maxToolRounds !== undefined ? String(initialInfo.maxToolRounds) : "",
  );
  const [injectMemory, setInjectMemory] = useState<boolean>(initialInfo?.injectMemory ?? false);
  const [summarizeOnTrim, setSummarizeOnTrim] = useState<boolean>(initialInfo?.summarizeOnTrim ?? false);
  const [toolList, setToolList] = useState<string[]>(initialInfo?.tools ?? []);
  const [allTools, setAllTools] = useState<string[]>([]);
  const [skillList, setSkillList] = useState<string[]>(initialInfo?.skills ?? []);
  const [skillLoading, setSkillLoading] = useState<"eager" | "progressive">(initialInfo?.skillLoading ?? "progressive");
  const [allSkills, setAllSkills] = useState<SkillCatalogEntry[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchTools()
      .then((tools) => setAllTools(tools.map((t) => t.name).sort()))
      .catch(() => {});
    fetchSkills()
      .then((skills) => setAllSkills(skills))
      .catch(() => {});
  }, []);

  const nameError =
    mode === "create"
      ? !name.trim()
        ? "Name is required"
        : !/^[A-Za-z0-9_-]+$/.test(name)
          ? "Letters, digits, underscore, dash only"
          : existingNames.includes(name)
            ? "An agent with that name already exists"
            : null
      : null;

  const tempError =
    temperature && (Number.isNaN(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2)
      ? "Temperature must be between 0 and 2"
      : null;

  const canSave = !nameError && !tempError && !saving;

  async function handleSubmit() {
    if (!canSave) return;
    const definition: AgentDefinitionPatch = {};
    if (description.trim()) definition.description = description.trim();
    if (model.trim()) definition.model = model.trim();
    if (instructions.trim()) definition.instructions = instructions.trim();
    if (temperature.trim()) definition.temperature = Number(temperature);
    if (maxToolRounds.trim()) definition.maxToolRounds = Number(maxToolRounds);
    if (toolList.length > 0) definition.tools = toolList;
    if (skillList.length > 0) {
      definition.skills = skillList;
      definition.skillLoading = skillLoading;
    } else {
      // Empty list = clear any existing skills on the agent.
      definition.skills = [];
    }
    definition.injectMemory = injectMemory;
    definition.summarizeOnTrim = summarizeOnTrim;

    setSaving(true);
    try {
      if (mode === "create") {
        const res = await createAgent(name.trim(), definition);
        toast.success(`Agent "${res.name}" created`);
        onSaved(res.name);
      } else {
        const res = await updateAgent(initialName, definition);
        toast.success(`Agent "${res.name}" updated`);
        onSaved(res.name);
      }
    } catch (e) {
      toast.error(`${mode === "create" ? "Create" : "Update"} failed: ${describeError(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function toggleTool(t: string) {
    setToolList((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  function toggleSkill(id: string) {
    setSkillList((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div className="agents-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="agents-modal" onClick={(e) => e.stopPropagation()}>
        <header className="agents-modal-header">
          <h2>{mode === "create" ? "New agent" : `Edit ${initialName}`}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="agents-modal-body">
          {mode === "create" && (
            <label className="agents-field">
              <span>Name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="researcher" />
              {nameError && <em className="agents-field-error">{nameError}</em>}
            </label>
          )}
          <label className="agents-field">
            <span>Description</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this agent does"
            />
          </label>
          <label className="agents-field">
            <span>Model</span>
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="(default)" />
          </label>
          <label className="agents-field">
            <span>Instructions</span>
            <textarea
              rows={6}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="System prompt for this agent"
            />
          </label>
          <div className="agents-field-row">
            <label className="agents-field">
              <span>Temperature</span>
              <input
                type="text"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="0.3"
              />
              {tempError && <em className="agents-field-error">{tempError}</em>}
            </label>
            <label className="agents-field">
              <span>Max tool rounds</span>
              <input
                type="text"
                value={maxToolRounds}
                onChange={(e) => setMaxToolRounds(e.target.value)}
                placeholder="10"
              />
            </label>
          </div>
          <label className="agents-field-check">
            <input type="checkbox" checked={injectMemory} onChange={(e) => setInjectMemory(e.target.checked)} />
            <span>Inject recall results into system prompt (recommended for chat agents)</span>
          </label>
          <label className="agents-field-check">
            <input type="checkbox" checked={summarizeOnTrim} onChange={(e) => setSummarizeOnTrim(e.target.checked)} />
            <span>Summarize trimmed history with LLM (more context preserved)</span>
          </label>
          <div className="agents-field">
            <span>Tools allowlist (leave empty for default — all tools)</span>
            <div className="agents-tool-grid">
              {allTools.map((t) => (
                <label key={t} className="agents-tool-check">
                  <input type="checkbox" checked={toolList.includes(t)} onChange={() => toggleTool(t)} />
                  <span>{t}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="agents-field">
            <span>
              Skills (
              <a href="/resources" style={{ color: "inherit" }}>
                install more via Resources
              </a>
              )
            </span>
            {allSkills.length === 0 ? (
              <p className="agents-field-hint">
                No skills installed. Install one with <code>tai resources install &lt;path-or-uri&gt;</code> or via the
                Resources page.
              </p>
            ) : (
              <>
                <div className="agents-tool-grid">
                  {allSkills.map((s) => (
                    <label key={s.id} className="agents-tool-check" title={s.description}>
                      <input type="checkbox" checked={skillList.includes(s.id)} onChange={() => toggleSkill(s.id)} />
                      <span>{s.id}</span>
                    </label>
                  ))}
                </div>
                {skillList.length > 0 && (
                  <label className="agents-checkbox" style={{ marginTop: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={skillLoading === "progressive"}
                      onChange={(e) => setSkillLoading(e.target.checked ? "progressive" : "eager")}
                    />
                    <span>
                      Progressive loading (agent calls <code>load_skill</code> on demand — recommended; smaller prompts)
                    </span>
                  </label>
                )}
              </>
            )}
          </div>
        </div>
        <footer className="agents-modal-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={!canSave}>
            {saving ? "Saving…" : mode === "create" ? "Create agent" : "Save changes"}
          </button>
        </footer>
      </div>
    </div>
  );
}
