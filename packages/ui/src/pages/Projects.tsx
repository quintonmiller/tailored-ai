import { useCallback, useEffect, useState } from "react";
import {
  type ProjectWithCounts,
  createProject,
  deleteProject,
  fetchProjects,
  updateProject,
} from "../api";
import { DocumentList } from "../components/DocumentList";
import { DocumentViewer } from "../components/DocumentViewer";
import { Tasks } from "./Tasks";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

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
  const [selectedId, setSelectedId] = useState<string | null>(projectId ?? null);
  const [activeTab, setActiveTab] = useState<"tasks" | "documents">(tab ?? "tasks");
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectWithCounts | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formDue, setFormDue] = useState("");
  const [formStatus, setFormStatus] = useState("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetchProjects({ limit: 100 });
      setProjects(res.projects);
      // Auto-select first project if none selected
      if (!selectedId && res.projects.length > 0) {
        const id = projectId ?? res.projects[0].id;
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
    window.location.hash = `#/projects/${id}/${activeTab}`;
  };

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
    setShowForm(true);
  };

  const openEdit = (p: ProjectWithCounts) => {
    setEditingProject(p);
    setFormTitle(p.title);
    setFormDesc(p.description);
    setFormDue(p.due_date ?? "");
    setFormStatus(p.status);
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
        });
      } else {
        const created = await createProject({
          title: formTitle,
          description: formDesc || undefined,
          due_date: formDue || undefined,
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
          <button className="tasks-new-btn" onClick={openCreate}>
            + New Project
          </button>
        </div>
      </div>

      {error && (
        <div className="tasks-error">
          {error}
          <button className="tasks-error-dismiss" onClick={() => setError(null)}>
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
          <button className="tasks-new-btn" onClick={openCreate}>
            + Create one
          </button>
        </div>
      ) : (
        <>
          <div className="project-tabs">
            {projects.map((p) => (
              <button
                key={p.id}
                className={`project-tab${p.id === selectedId ? " active" : ""}`}
                onClick={() => selectProject(p.id)}
              >
                <span className={`project-status-dot ${p.status}`} />
                {p.title}
                <span className="project-tab-count">{p.task_count}</span>
              </button>
            ))}
          </div>

          {/* Sub-tabs + project actions */}
          {selected && (
            <div className="project-subtabs">
              <div className="project-subtab-links">
                <button
                  className={`project-subtab${activeTab === "tasks" ? " active" : ""}`}
                  onClick={() => switchTab("tasks")}
                >
                  Tasks
                </button>
                <button
                  className={`project-subtab${activeTab === "documents" ? " active" : ""}`}
                  onClick={() => switchTab("documents")}
                >
                  Documents
                </button>
              </div>
              <div className="project-subtab-actions">
                <button className="tasks-edit-btn" onClick={() => openEdit(selected)}>
                  Edit
                </button>
                <button className="tasks-delete-btn" onClick={() => handleDelete(selected.id)}>
                  Delete
                </button>
              </div>
            </div>
          )}

          {/* Content area */}
          {selected && activeTab === "tasks" && (
            <Tasks projectId={selected.id} taskId={taskId} />
          )}
          {selected && activeTab === "documents" && (
            docId
              ? <DocumentViewer projectId={selected.id} docId={docId} />
              : <DocumentList projectId={selected.id} />
          )}
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
                autoFocus
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
                  <select
                    className="field-select"
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value)}
                  >
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
            <div className="tasks-form-actions">
              <button className="tasks-cancel-btn" onClick={() => setShowForm(false)}>
                Cancel
              </button>
              <button
                className="tasks-submit-btn"
                onClick={handleSubmit}
                disabled={!formTitle.trim()}
              >
                {editingProject ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
