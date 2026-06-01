import { useCallback, useEffect, useState } from "react";
import {
  type AgentInfo,
  addProjectTaskComment,
  createProjectTask,
  deleteProjectTask,
  fetchAgents,
  fetchProjectTask,
  fetchProjectTasks,
  type ProjectTask,
  type ProjectTaskWithComments,
  type TaskComment,
  updateProjectTask,
} from "../api";

const BOARD_STATUSES = ["backlog", "in_progress", "blocked", "in_review", "done"] as const;
const ALL_STATUSES = ["backlog", "in_progress", "blocked", "in_review", "done", "archived"] as const;

const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  blocked: "Blocked",
  in_review: "In Review",
  done: "Done",
  archived: "Archived",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(`${iso}Z`).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

interface TaskFormData {
  title: string;
  description: string;
  status: string;
  author: string;
  tags: string;
  assignee: string;
  rank: string;
}

const emptyForm: TaskFormData = {
  title: "",
  description: "",
  status: "backlog",
  author: "",
  tags: "",
  assignee: "",
  rank: "",
};

function blockedReasonLabel(reason: string | null): string {
  switch (reason) {
    case "question":
      return "Waiting on you";
    case "budget":
      return "Budget-deferred";
    case "error":
      return "Errored";
    default:
      return "Blocked";
  }
}

export function Tasks({
  taskId,
  initialStatus,
  projectId,
}: {
  taskId?: string;
  initialStatus?: string;
  projectId?: string;
}) {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<ProjectTaskWithComments | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskFormData>(emptyForm);
  const [commentText, setCommentText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [answerText, setAnswerText] = useState("");

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch(() => setAgents({}));
  }, []);

  // Drag state
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetchProjectTasks({
        search: search || undefined,
        project_id: projectId,
        limit: 200,
      });
      setTasks(res.tasks);
      setTotal(res.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, projectId]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Poll tasks every 10s
  useEffect(() => {
    const id = setInterval(loadTasks, 10_000);
    return () => clearInterval(id);
  }, [loadTasks]);

  useEffect(() => {
    if (taskId) {
      fetchProjectTask(taskId)
        .then(setDetail)
        .catch(() => setDetail(null));
    }
  }, [taskId]);

  // If initialStatus, pre-fill create form
  useEffect(() => {
    if (initialStatus) {
      setForm({ ...emptyForm, status: initialStatus });
    }
  }, [initialStatus]);

  const basePath = projectId ? `#/projects/${projectId}/tasks` : "#/tasks";

  const openDetail = async (id: string) => {
    window.location.hash = `${basePath}/${id}`;
    try {
      const t = await fetchProjectTask(id);
      setDetail(t);
    } catch {
      setError("Failed to load task");
    }
  };

  const closeDetail = () => {
    setDetail(null);
    window.location.hash = basePath;
  };

  const openCreate = (status?: string) => {
    setForm({ ...emptyForm, status: status ?? "backlog" });
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (task: ProjectTask) => {
    setForm({
      title: task.title,
      description: task.description,
      status: task.status,
      author: task.author,
      tags: task.tags.join(", "),
      assignee: task.assignee ?? "",
      rank: String(task.rank ?? ""),
    });
    setEditingId(task.id);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!form.title.trim()) return;
    const tags = form.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const parsedRank = form.rank.trim() ? Number.parseInt(form.rank, 10) : undefined;

    try {
      if (editingId) {
        const updated = await updateProjectTask(editingId, {
          title: form.title,
          description: form.description,
          status: form.status,
          author: form.author,
          tags,
          assignee: form.assignee || null,
          rank: parsedRank,
        });
        if (detail && detail.id === editingId) {
          setDetail({ ...detail, ...updated });
        }
      } else {
        await createProjectTask({
          title: form.title,
          description: form.description || undefined,
          author: form.author || undefined,
          tags: tags.length ? tags : undefined,
          status: form.status,
          project_id: projectId,
          assignee: form.assignee || null,
          rank: parsedRank,
        });
      }
      setShowForm(false);
      setEditingId(null);
      await loadTasks();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProjectTask(id);
      if (detail?.id === id) closeDetail();
      await loadTasks();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleComment = async () => {
    if (!detail || !commentText.trim()) return;
    try {
      const comment = await addProjectTaskComment(detail.id, { content: commentText });
      setDetail({ ...detail, comments: [...detail.comments, comment] });
      setCommentText("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleStatusChange = async (task: ProjectTask, newStatus: string) => {
    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)));
    try {
      const updated = await updateProjectTask(task.id, { status: newStatus });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...updated } : t)));
      if (detail && detail.id === task.id) {
        setDetail({ ...detail, ...updated });
      }
    } catch (e) {
      // Revert
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: task.status } : t)));
      setError((e as Error).message);
    }
  };

  // --- Drag handlers ---
  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    setDragTaskId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
    // Make the drag image slightly transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "0.5";
    }
  };

  const handleDragEnd = (e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "1";
    }
    setDragTaskId(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: React.DragEvent, status: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(status);
  };

  const handleDragLeave = (e: React.DragEvent, status: string) => {
    // Only clear if we actually left the lane (not entering a child)
    const related = e.relatedTarget as HTMLElement | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    if (dropTarget === status) setDropTarget(null);
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    setDropTarget(null);
    const droppedId = e.dataTransfer.getData("text/plain");
    if (!droppedId) return;

    const task = tasks.find((t) => t.id === droppedId);
    if (!task || task.status === targetStatus) return;

    await handleStatusChange(task, targetStatus);
  };

  // Group tasks by status for the board
  const tasksByStatus = new Map<string, ProjectTask[]>();
  for (const status of BOARD_STATUSES) {
    tasksByStatus.set(status, []);
  }
  if (showArchived) tasksByStatus.set("archived", []);

  for (const task of tasks) {
    const bucket = tasksByStatus.get(task.status);
    if (bucket) {
      if (
        !search ||
        task.title.toLowerCase().includes(search.toLowerCase()) ||
        task.description.toLowerCase().includes(search.toLowerCase())
      ) {
        bucket.push(task);
      }
    }
  }

  // Sort backlog by rank ascending, in_progress/blocked/in_review by updated_at.
  const backlog = tasksByStatus.get("backlog");
  if (backlog) backlog.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));

  const archivedCount = tasks.filter((t) => t.status === "archived").length;

  const handleResumeFromQuestion = async () => {
    if (!detail || !answerText.trim()) return;
    try {
      await addProjectTaskComment(detail.id, { author: "user", content: answerText });
      // Back to backlog — autopilot only scans backlog, so this is what puts the
      // task back in the queue for the next worker tick.
      const updated = await updateProjectTask(detail.id, {
        status: "backlog",
        blocked_reason: null,
      });
      const fresh = await fetchProjectTask(detail.id);
      setDetail(fresh);
      setAnswerText("");
      setTasks((prev) => prev.map((t) => (t.id === detail.id ? { ...t, ...updated } : t)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="tasks-page">
      {/* Header */}
      <div className="tasks-header">
        <h2>Project Tasks{total > 0 ? ` (${total})` : ""}</h2>
        <div className="tasks-header-actions">
          <input
            className="tasks-search"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="button" className="tasks-new-btn" onClick={() => openCreate()}>
            + New Task
          </button>
        </div>
      </div>

      {error && (
        <div className="tasks-error">
          {error}
          <button type="button" className="tasks-error-dismiss" onClick={() => setError(null)}>
            x
          </button>
        </div>
      )}

      {/* Create/Edit form */}
      {showForm && (
        <div className="tasks-form-overlay" onClick={() => setShowForm(false)}>
          <div className="tasks-form" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId ? "Edit Task" : "New Task"}</h3>
            <div className="field-group">
              <label className="field-label">Title</label>
              <input
                className="field-input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Description</label>
              <textarea
                className="field-textarea"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
              />
            </div>
            <div className="tasks-form-row">
              <div className="field-group" style={{ flex: 1 }}>
                <label className="field-label">Status</label>
                <select
                  className="field-select"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  {ALL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-group" style={{ flex: 1 }}>
                <label className="field-label">Author</label>
                <input
                  className="field-input"
                  value={form.author}
                  onChange={(e) => setForm({ ...form, author: e.target.value })}
                />
              </div>
            </div>
            <div className="tasks-form-row">
              <div className="field-group" style={{ flex: 2 }}>
                <label className="field-label">Assignee</label>
                <select
                  className="field-select"
                  value={form.assignee}
                  onChange={(e) => setForm({ ...form, assignee: e.target.value })}
                >
                  <option value="">(unassigned)</option>
                  {Object.keys(agents).map((name) => (
                    <option key={name} value={name}>
                      @{name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-group" style={{ flex: 1 }}>
                <label className="field-label">Rank</label>
                <input
                  className="field-input"
                  type="number"
                  min={1}
                  placeholder="auto"
                  value={form.rank}
                  onChange={(e) => setForm({ ...form, rank: e.target.value })}
                />
              </div>
            </div>
            <div className="field-group">
              <label className="field-label">Tags (comma-separated)</label>
              <input
                className="field-input"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
              />
            </div>
            <div className="tasks-form-actions">
              <button type="button" className="tasks-cancel-btn" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="button" className="tasks-submit-btn" onClick={handleSubmit} disabled={!form.title.trim()}>
                {editingId ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task detail */}
      {detail && (
        <div className="tasks-form-overlay" onClick={closeDetail}>
          <div className="tasks-detail" onClick={(e) => e.stopPropagation()}>
            <div className="tasks-detail-header">
              <h3>{detail.title}</h3>
              <div className="tasks-detail-actions">
                <button type="button" className="tasks-edit-btn" onClick={() => openEdit(detail)}>
                  Edit
                </button>
                <button type="button" className="tasks-delete-btn" onClick={() => handleDelete(detail.id)}>
                  Delete
                </button>
                <button type="button" className="tasks-close-btn" onClick={closeDetail}>
                  x
                </button>
              </div>
            </div>
            <div className="tasks-detail-meta">
              <span className={`ptask-status-badge ${detail.status}`} style={{ whiteSpace: "nowrap" }}>
                {detail.status === "blocked"
                  ? blockedReasonLabel(detail.blocked_reason)
                  : (STATUS_LABELS[detail.status] ?? detail.status)}
              </span>
              {detail.assignee && (
                <span className="tasks-detail-author" title="Assignee">
                  @{detail.assignee}
                </span>
              )}
              {detail.author && <span className="tasks-detail-author">{detail.author}</span>}
              <span className="tasks-detail-time">{relativeTime(detail.updated_at)}</span>
              <span className="tasks-detail-id">{detail.id}</span>
            </div>
            {detail.status === "blocked" && detail.blocked_reason === "question" && (
              <div
                className="tasks-form-row"
                style={{ background: "rgba(255,170,0,0.08)", padding: 12, borderRadius: 6, marginBottom: 12 }}
              >
                <div className="field-group" style={{ flex: 1 }}>
                  <label className="field-label">Answer — unblocks the agent and resumes work</label>
                  <input
                    className="field-input"
                    placeholder="Your answer..."
                    value={answerText}
                    onChange={(e) => setAnswerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleResumeFromQuestion();
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="tasks-submit-btn"
                  onClick={handleResumeFromQuestion}
                  disabled={!answerText.trim()}
                  style={{ alignSelf: "flex-end" }}
                >
                  Resume
                </button>
              </div>
            )}
            {detail.tags.length > 0 && (
              <div className="tasks-detail-tags">
                {detail.tags.map((tag) => (
                  <span key={tag} className="ptask-tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {detail.description && <div className="tasks-detail-desc">{detail.description}</div>}
            <div className="tasks-detail-comments">
              <h4>Comments ({detail.comments.length})</h4>
              {detail.comments.map((c: TaskComment) => (
                <div key={c.id} className="tasks-comment">
                  <div className="tasks-comment-header">
                    {c.author && <span className="tasks-comment-author">{c.author}</span>}
                    <span className="tasks-comment-time">{relativeTime(c.created_at)}</span>
                  </div>
                  <div className="tasks-comment-body">{c.content}</div>
                </div>
              ))}
              <div className="tasks-comment-form">
                <input
                  className="field-input"
                  placeholder="Add a comment..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleComment();
                  }}
                />
                <button
                  type="button"
                  className="tasks-submit-btn"
                  onClick={handleComment}
                  disabled={!commentText.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Kanban Board */}
      {loading ? (
        <div className="board-skeleton">
          {BOARD_STATUSES.map((s) => (
            <div key={s} className="board-lane skeleton-pulse">
              <div className="board-lane-header">
                <span>{STATUS_LABELS[s]}</span>
              </div>
              <div className="skeleton-card" style={{ height: 60 }} />
              <div className="skeleton-card" style={{ height: 60 }} />
            </div>
          ))}
        </div>
      ) : tasks.length === 0 && !search ? (
        <div className="empty-state">
          No tasks yet.{" "}
          <button type="button" className="tasks-new-btn" onClick={() => openCreate()}>
            + Create one
          </button>
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div className="board">
              {Array.from(tasksByStatus.entries()).map(([status, laneTasks]) => (
                <div
                  key={status}
                  className={`board-lane${dropTarget === status ? " board-lane-drop-active" : ""}`}
                  onDragOver={(e) => handleDragOver(e, status)}
                  onDragLeave={(e) => handleDragLeave(e, status)}
                  onDrop={(e) => handleDrop(e, status)}
                >
                  <div className="board-lane-header">
                    <span className={`ptask-status-dot ${status}`} />
                    <span className="board-lane-title">{STATUS_LABELS[status]}</span>
                    <span className="board-lane-count">{laneTasks.length}</span>
                    <button
                      type="button"
                      className="board-lane-add"
                      onClick={() => openCreate(status)}
                      title={`Add to ${STATUS_LABELS[status]}`}
                    >
                      +
                    </button>
                  </div>
                  <div className="board-lane-body">
                    {laneTasks.map((task) => (
                      <div
                        key={task.id}
                        className={`board-card${dragTaskId === task.id ? " board-card-dragging" : ""}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, task.id)}
                        onDragEnd={handleDragEnd}
                        onClick={() => openDetail(task.id)}
                      >
                        <div className="board-card-title">{task.title}</div>
                        {task.status === "blocked" && task.blocked_reason && (
                          <div className={`board-card-blocked-reason reason-${task.blocked_reason}`}>
                            {blockedReasonLabel(task.blocked_reason)}
                          </div>
                        )}
                        <div className="board-card-meta">
                          {status === "backlog" && task.rank ? (
                            <span className="board-card-rank" title="Rank">
                              #{task.rank}
                            </span>
                          ) : null}
                          {task.assignee && (
                            <span className="board-card-assignee" title="Assignee">
                              @{task.assignee}
                            </span>
                          )}
                          {task.tags.length > 0 && (
                            <span className="ptask-card-tags">
                              {task.tags.map((tag) => (
                                <span key={tag} className="ptask-tag">
                                  {tag}
                                </span>
                              ))}
                            </span>
                          )}
                          {task.author && !task.assignee && <span className="board-card-author">{task.author}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {archivedCount > 0 && !showArchived && (
            <button type="button" className="board-show-archived" onClick={() => setShowArchived(true)}>
              Show {archivedCount} archived task{archivedCount !== 1 ? "s" : ""}
            </button>
          )}
          {showArchived && archivedCount > 0 && (
            <button type="button" className="board-show-archived" onClick={() => setShowArchived(false)}>
              Hide archived tasks
            </button>
          )}
        </>
      )}
    </div>
  );
}
