import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { createProject, deleteProject, fetchProjects, updateProject, } from "../api";
import { DocumentList } from "../components/DocumentList";
import { DocumentViewer } from "../components/DocumentViewer";
import { Tasks } from "./Tasks";
const STATUS_LABELS = {
    active: "Active",
    completed: "Completed",
    archived: "Archived",
};
export function Projects({ projectId, tab, taskId, docId, }) {
    const [projects, setProjects] = useState([]);
    const [selectedId, setSelectedId] = useState(projectId ?? null);
    const [activeTab, setActiveTab] = useState(tab ?? "tasks");
    const [showForm, setShowForm] = useState(false);
    const [editingProject, setEditingProject] = useState(null);
    const [formTitle, setFormTitle] = useState("");
    const [formDesc, setFormDesc] = useState("");
    const [formDue, setFormDue] = useState("");
    const [formStatus, setFormStatus] = useState("active");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
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
        }
        catch (e) {
            setError(e.message);
        }
        finally {
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
    const selectProject = (id) => {
        setSelectedId(id);
        window.location.hash = `#/projects/${id}/${activeTab}`;
    };
    const switchTab = (t) => {
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
    const openEdit = (p) => {
        setEditingProject(p);
        setFormTitle(p.title);
        setFormDesc(p.description);
        setFormDue(p.due_date ?? "");
        setFormStatus(p.status);
        setShowForm(true);
    };
    const handleSubmit = async () => {
        if (!formTitle.trim())
            return;
        try {
            if (editingProject) {
                await updateProject(editingProject.id, {
                    title: formTitle,
                    description: formDesc,
                    status: formStatus,
                    due_date: formDue || null,
                });
            }
            else {
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
        }
        catch (e) {
            setError(e.message);
        }
    };
    const handleDelete = async (id) => {
        try {
            await deleteProject(id);
            if (selectedId === id) {
                setSelectedId(null);
            }
            await loadProjects();
        }
        catch (e) {
            setError(e.message);
        }
    };
    const selected = projects.find((p) => p.id === selectedId);
    return (_jsxs("div", { className: "tasks-page", children: [_jsxs("div", { className: "tasks-header", children: [_jsxs("h2", { children: ["Projects", projects.length > 0 ? ` (${projects.length})` : ""] }), _jsx("div", { className: "tasks-header-actions", children: _jsx("button", { className: "tasks-new-btn", onClick: openCreate, children: "+ New Project" }) })] }), error && (_jsxs("div", { className: "tasks-error", children: [error, _jsx("button", { className: "tasks-error-dismiss", onClick: () => setError(null), children: "x" })] })), loading ? (_jsxs("div", { className: "project-tabs", children: [_jsx("div", { className: "project-tab skeleton-pulse", style: { width: 80, height: 32 } }), _jsx("div", { className: "project-tab skeleton-pulse", style: { width: 80, height: 32 } })] })) : projects.length === 0 ? (_jsxs("div", { className: "empty-state", children: ["No projects yet.", " ", _jsx("button", { className: "tasks-new-btn", onClick: openCreate, children: "+ Create one" })] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "project-tabs", children: projects.map((p) => (_jsxs("button", { className: `project-tab${p.id === selectedId ? " active" : ""}`, onClick: () => selectProject(p.id), children: [_jsx("span", { className: `project-status-dot ${p.status}` }), p.title, _jsx("span", { className: "project-tab-count", children: p.task_count })] }, p.id))) }), selected && (_jsxs("div", { className: "project-subtabs", children: [_jsxs("div", { className: "project-subtab-links", children: [_jsx("button", { className: `project-subtab${activeTab === "tasks" ? " active" : ""}`, onClick: () => switchTab("tasks"), children: "Tasks" }), _jsx("button", { className: `project-subtab${activeTab === "documents" ? " active" : ""}`, onClick: () => switchTab("documents"), children: "Documents" })] }), _jsxs("div", { className: "project-subtab-actions", children: [_jsx("button", { className: "tasks-edit-btn", onClick: () => openEdit(selected), children: "Edit" }), _jsx("button", { className: "tasks-delete-btn", onClick: () => handleDelete(selected.id), children: "Delete" })] })] })), selected && activeTab === "tasks" && (_jsx(Tasks, { projectId: selected.id, taskId: taskId })), selected && activeTab === "documents" && (docId
                        ? _jsx(DocumentViewer, { projectId: selected.id, docId: docId })
                        : _jsx(DocumentList, { projectId: selected.id }))] })), showForm && (_jsx("div", { className: "tasks-form-overlay", onClick: () => setShowForm(false), children: _jsxs("div", { className: "tasks-form", onClick: (e) => e.stopPropagation(), children: [_jsx("h3", { children: editingProject ? "Edit Project" : "New Project" }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Title" }), _jsx("input", { className: "field-input", value: formTitle, onChange: (e) => setFormTitle(e.target.value), onKeyDown: (e) => {
                                        if (e.key === "Enter")
                                            handleSubmit();
                                    }, autoFocus: true })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("textarea", { className: "field-textarea", value: formDesc, onChange: (e) => setFormDesc(e.target.value), rows: 3 })] }), _jsxs("div", { className: "tasks-form-row", children: [editingProject && (_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Status" }), _jsx("select", { className: "field-select", value: formStatus, onChange: (e) => setFormStatus(e.target.value), children: Object.entries(STATUS_LABELS).map(([k, v]) => (_jsx("option", { value: k, children: v }, k))) })] })), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Due Date" }), _jsx("input", { className: "field-input", type: "date", value: formDue, onChange: (e) => setFormDue(e.target.value) })] })] }), _jsxs("div", { className: "tasks-form-actions", children: [_jsx("button", { className: "tasks-cancel-btn", onClick: () => setShowForm(false), children: "Cancel" }), _jsx("button", { className: "tasks-submit-btn", onClick: handleSubmit, disabled: !formTitle.trim(), children: editingProject ? "Save" : "Create" })] })] }) }))] }));
}
