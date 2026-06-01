import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AgentInfo,
  createProject,
  deleteProject,
  fetchAgents,
  fetchProjects,
  type ProjectWithCounts,
  setActiveProjectId,
  updateProject,
} from "../api";
import { DocumentList } from "../components/DocumentList";
import { DocumentViewer } from "../components/DocumentViewer";
import { useActiveProject } from "../hooks/useActiveProject";
import { Tasks } from "./Tasks";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

type StatusFilter = "active" | "completed" | "archived" | "all";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "completed", label: "Completed" },
  { key: "archived", label: "Archived" },
  { key: "all", label: "All" },
];

function sortByTitle(a: ProjectWithCounts, b: ProjectWithCounts): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

export function Projects({
  projectId,
  tab,
  taskId,
  docId,
}: {
  projectId?: string;
  tab?: "tasks" | "documents";
  taskId?: string;
  docId?: string;
}) {
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const headerActiveProject = useActiveProject();
  const [selectedId, setSelectedId] = useState<string | null>(
    projectId ?? (headerActiveProject && headerActiveProject !== "global" ? headerActiveProject : null),
  );
  const [activeTab, setActiveTab] = useState<"tasks" | "documents">(tab ?? "tasks");
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectWithCounts | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formDue, setFormDue] = useState("");
  const [formStatus, setFormStatus] = useState("active");
  const [formAssignee, setFormAssignee] = useState("");
  const [agents, setAgents] = useState<Record<string, AgentInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch(() => setAgents({}));
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetchProjects({ limit: 500 });
      setProjects(res.projects);
      // Auto-select first project (prefer an active one) if none selected
      if (!selectedId && res.projects.length > 0) {
        const sorted = [...res.projects].sort(sortByTitle);
        const firstActive = sorted.find((p) => p.status === "active") ?? sorted[0];
        const id = projectId ?? firstActive.id;
        setSelectedId(id);
        if (!projectId) {
          window.location.hash = `#/projects/${id}/${activeTab}`;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedId, projectId, activeTab]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { active: 0, completed: 0, archived: 0, all: projects.length };
    for (const p of projects) {
      if (p.status === "active") counts.active += 1;
      else if (p.status === "completed") counts.completed += 1;
      else if (p.status === "archived") counts.archived += 1;
    }
    return counts;
  }, [projects]);

  const visibleProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchesStatus = (p: ProjectWithCounts) => (statusFilter === "all" ? true : p.status === statusFilter);
    const matchesSearch = (p: ProjectWithCounts) =>
      q === "" ? true : p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);

    const list = projects.filter((p) => matchesStatus(p) && matchesSearch(p));
    // Always include the currently-selected project so it stays visible/selectable
    // even if it falls outside the current filter (e.g. you selected an archived
    // project and then switched the filter back to Active).
    if (selectedId && !list.some((p) => p.id === selectedId)) {
      const pinned = projects.find((p) => p.id === selectedId);
      if (pinned) list.push(pinned);
    }
    return list.sort(sortByTitle);
  }, [projects, statusFilter, searchQuery, selectedId]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Poll projects every 15s
  useEffect(() => {
    const id = setInterval(loadProjects, 15_000);
    return () => clearInterval(id);
  }, [loadProjects]);

  // Sync URL params
  useEffect(() => {
    if (projectId && projectId !== selectedId) {
      setSelectedId(projectId);
    }
  }, [projectId, selectedId]);

  useEffect(() => {
    if (tab && tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [tab, activeTab]);

  const selectProject = (id: string) => {
    setSelectedId(id);
    // Sync to the header dropdown so the rest of the UI scopes consistently.
    setActiveProjectId(id);
    window.location.hash = `#/projects/${id}/${activeTab}`;
  };

  // React to header dropdown changes.
  useEffect(() => {
    if (headerActiveProject && headerActiveProject !== "global" && headerActiveProject !== selectedId) {
      setSelectedId(headerActiveProject);
      window.location.hash = `#/projects/${headerActiveProject}/${activeTab}`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerActiveProject, activeTab, selectedId]);

  const switchTab = (t: "tasks" | "documents") => {
    setActiveTab(t);
    if (selectedId) {
      window.location.hash = `#/projects/${selectedId}/${t}`;
    }
  };

  const openCreate = () => {
    setEditingProject(null);
    setFormTitle("");
    setFormDesc("");
    setFormDue("");
    setFormStatus("active");
    setFormAssignee("");
    setShowForm(true);
  };

  const openEdit = (p: ProjectWithCounts) => {
    setEditingProject(p);
    setFormTitle(p.title);
    setFormDesc(p.description);
    setFormDue(p.due_date ?? "");
    setFormStatus(p.status);
    setFormAssignee(p.default_assignee ?? "");
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!formTitle.trim()) return;
    try {
      if (editingProject) {
        await updateProject(editingProject.id, {
          title: formTitle,
          description: formDesc,
          status: formStatus,
          due_date: formDue || null,
          default_assignee: formAssignee || null,
        });
      } else {
        const created = await createProject({
          title: formTitle,
          description: formDesc || undefined,
          due_date: formDue || undefined,
          default_assignee: formAssignee || null,
        });
        setSelectedId(created.id);
        window.location.hash = `#/projects/${created.id}/${activeTab}`;
      }
      setShowForm(false);
      await loadProjects();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProject(id);
      if (selectedId === id) {
        setSelectedId(null);
      }
      await loadProjects();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const selected = projects.find((p) => p.id === selectedId);

  return (
    <div className="tasks-page">
      {/* Header */}
      <div className="tasks-header">
        <h2>Projects{projects.length > 0 ? ` (${projects.length})` : ""}</h2>
        <div className="tasks-header-actions">
          <button type="button" className="tasks-new-btn" onClick={openCreate}>
            + New Project
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

      {/* Project tabs */}
      {loading ? (
        <div className="project-tabs">
          <div className="project-tab skeleton-pulse" style={{ width: 80, height: 32 }} />
          <div className="project-tab skeleton-pulse" style={{ width: 80, height: 32 }} />
        </div>
      ) : projects.length === 0 ? (
        <div className="empty-state">
          No projects yet.{" "}
          <button type="button" className="tasks-new-btn" onClick={openCreate}>
            + Create one
          </button>
        </div>
      ) : (
        <>
          <div className="project-filter-bar">
            <div className="project-filter-chips">
              {STATUS_FILTERS.map(({ key, label }) => (
                <button
                  type="button"
                  key={key}
                  className={`project-filter-chip${statusFilter === key ? " active" : ""}`}
                  onClick={() => setStatusFilter(key)}
                  title={`Show ${label.toLowerCase()} projects`}
                >
                  {label}
                  <span className="project-filter-chip-count">{statusCounts[key]}</span>
                </button>
              ))}
            </div>
            <input
              type="search"
              className="project-filter-search"
              placeholder={`Search ${visibleProjects.length} project${visibleProjects.length === 1 ? "" : "s"}…`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {visibleProjects.length === 0 ? (
            <div className="empty-state">
              No projects match the current filter.{" "}
              <button
                type="button"
                className="tasks-edit-btn"
                onClick={() => {
                  setStatusFilter("all");
                  setSearchQuery("");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="project-tabs">
              {visibleProjects.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`project-tab${p.id === selectedId ? " active" : ""}`}
                  onClick={() => selectProject(p.id)}
                  title={p.description || p.title}
                >
                  <span className={`project-status-dot ${p.status}`} />
                  {p.title}
                  <span className="project-tab-count">{p.task_count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Sub-tabs + project actions */}
          {selected && (
            <div className="project-subtabs">
              <div className="project-subtab-links">
                <button
                  type="button"
                  className={`project-subtab${activeTab === "tasks" ? " active" : ""}`}
                  onClick={() => switchTab("tasks")}
                >
                  Tasks
                </button>
                <button
                  type="button"
                  className={`project-subtab${activeTab === "documents" ? " active" : ""}`}
                  onClick={() => switchTab("documents")}
                >
                  Documents
                </button>
              </div>
              <div className="project-subtab-actions">
                {selected.default_assignee ? (
                  <span className="autopilot-pill autopilot-pill-on" title="Autopilot agent for this project">
                    <span className="autopilot-pill-dot" /> Autopilot: @{selected.default_assignee}
                    <a href="#/config/autopilot" className="autopilot-pill-settings">
                      settings
                    </a>
                  </span>
                ) : (
                  <span className="autopilot-pill autopilot-pill-off">
                    Autopilot: off
                    <button type="button" className="autopilot-pill-cta" onClick={() => openEdit(selected)}>
                      Set agent
                    </button>
                  </span>
                )}
                <button type="button" className="tasks-edit-btn" onClick={() => openEdit(selected)}>
                  Edit
                </button>
                <button type="button" className="tasks-delete-btn" onClick={() => handleDelete(selected.id)}>
                  Delete
                </button>
              </div>
            </div>
          )}

          {selected && !selected.default_assignee && activeTab === "tasks" && (
            <div className="autopilot-hint">
              <strong>Autopilot isn't set up for this project.</strong>
              <p>
                Assign a default agent and the agent will automatically work your backlog — top-ranked card first,
                asking you when stuck, reporting progress on each card. You can still assign specific tasks to other
                agents (or to yourself) from each task's form.
              </p>
              <div className="autopilot-hint-actions">
                <button type="button" className="tasks-new-btn" onClick={() => openEdit(selected)}>
                  Set default agent
                </button>
                <a href="#/config/autopilot" className="autopilot-hint-link">
                  Autopilot settings →
                </a>
              </div>
            </div>
          )}

          {/* Content area */}
          {selected && activeTab === "tasks" && <Tasks projectId={selected.id} taskId={taskId} />}
          {selected &&
            activeTab === "documents" &&
            (docId ? (
              <DocumentViewer projectId={selected.id} docId={docId} />
            ) : (
              <DocumentList projectId={selected.id} />
            ))}
        </>
      )}

      {/* Create/Edit form modal */}
      {showForm && (
        <div className="tasks-form-overlay" onClick={() => setShowForm(false)}>
          <div className="tasks-form" onClick={(e) => e.stopPropagation()}>
            <h3>{editingProject ? "Edit Project" : "New Project"}</h3>
            <div className="field-group">
              <label className="field-label">Title</label>
              <input
                className="field-input"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                }}
              />
            </div>
            <div className="field-group">
              <label className="field-label">Description</label>
              <textarea
                className="field-textarea"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                rows={3}
              />
            </div>
            <div className="tasks-form-row">
              {editingProject && (
                <div className="field-group" style={{ flex: 1 }}>
                  <label className="field-label">Status</label>
                  <select className="field-select" value={formStatus} onChange={(e) => setFormStatus(e.target.value)}>
                    {Object.entries(STATUS_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field-group" style={{ flex: 1 }}>
                <label className="field-label">Due Date</label>
                <input
                  className="field-input"
                  type="date"
                  value={formDue}
                  onChange={(e) => setFormDue(e.target.value)}
                />
              </div>
            </div>
            <div className="field-group">
              <label className="field-label">Default assignee (autopilot agent)</label>
              <select className="field-select" value={formAssignee} onChange={(e) => setFormAssignee(e.target.value)}>
                <option value="">(none — tasks unassigned by default)</option>
                {Object.keys(agents).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="tasks-form-actions">
              <button type="button" className="tasks-cancel-btn" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button type="button" className="tasks-submit-btn" onClick={handleSubmit} disabled={!formTitle.trim()}>
                {editingProject ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
