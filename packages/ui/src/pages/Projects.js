import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { createProject, deleteProject, fetchAgents, fetchProjects, updateProject, } from "../api";
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
    const [formAssignee, setFormAssignee] = useState("");
    const [agents, setAgents] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    useEffect(() => {
        fetchAgents()
            .then(setAgents)
            .catch(() => setAgents({}));
    }, []);
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
        setFormAssignee("");
        setShowForm(true);
    };
    const openEdit = (p) => {
        setEditingProject(p);
        setFormTitle(p.title);
        setFormDesc(p.description);
        setFormDue(p.due_date ?? "");
        setFormStatus(p.status);
        setFormAssignee(p.default_assignee ?? "");
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
                    default_assignee: formAssignee || null,
                });
            }
            else {
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
    return (_jsxs("div", { className: "tasks-page", children: [_jsxs("div", { className: "tasks-header", children: [_jsxs("h2", { children: ["Projects", projects.length > 0 ? ` (${projects.length})` : ""] }), _jsx("div", { className: "tasks-header-actions", children: _jsx("button", { className: "tasks-new-btn", onClick: openCreate, children: "+ New Project" }) })] }), error && (_jsxs("div", { className: "tasks-error", children: [error, _jsx("button", { className: "tasks-error-dismiss", onClick: () => setError(null), children: "x" })] })), loading ? (_jsxs("div", { className: "project-tabs", children: [_jsx("div", { className: "project-tab skeleton-pulse", style: { width: 80, height: 32 } }), _jsx("div", { className: "project-tab skeleton-pulse", style: { width: 80, height: 32 } })] })) : projects.length === 0 ? (_jsxs("div", { className: "empty-state", children: ["No projects yet.", " ", _jsx("button", { className: "tasks-new-btn", onClick: openCreate, children: "+ Create one" })] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "project-tabs", children: projects.map((p) => (_jsxs("button", { className: `project-tab${p.id === selectedId ? " active" : ""}`, onClick: () => selectProject(p.id), children: [_jsx("span", { className: `project-status-dot ${p.status}` }), p.title, _jsx("span", { className: "project-tab-count", children: p.task_count })] }, p.id))) }), selected && (_jsxs("div", { className: "project-subtabs", children: [_jsxs("div", { className: "project-subtab-links", children: [_jsx("button", { className: `project-subtab${activeTab === "tasks" ? " active" : ""}`, onClick: () => switchTab("tasks"), children: "Tasks" }), _jsx("button", { className: `project-subtab${activeTab === "documents" ? " active" : ""}`, onClick: () => switchTab("documents"), children: "Documents" })] }), _jsxs("div", { className: "project-subtab-actions", children: [selected.default_assignee ? (_jsxs("span", { className: "autopilot-pill autopilot-pill-on", title: "Autopilot agent for this project", children: [_jsx("span", { className: "autopilot-pill-dot" }), " Autopilot: @", selected.default_assignee, _jsx("a", { href: "#/config/autopilot", className: "autopilot-pill-settings", children: "settings" })] })) : (_jsxs("span", { className: "autopilot-pill autopilot-pill-off", children: ["Autopilot: off", _jsx("button", { type: "button", className: "autopilot-pill-cta", onClick: () => openEdit(selected), children: "Set agent" })] })), _jsx("button", { className: "tasks-edit-btn", onClick: () => openEdit(selected), children: "Edit" }), _jsx("button", { className: "tasks-delete-btn", onClick: () => handleDelete(selected.id), children: "Delete" })] })] })), selected && !selected.default_assignee && activeTab === "tasks" && (_jsxs("div", { className: "autopilot-hint", children: [_jsx("strong", { children: "Autopilot isn't set up for this project." }), _jsx("p", { children: "Assign a default agent and the agent will automatically work your backlog \u2014 top-ranked card first, asking you when stuck, reporting progress on each card. You can still assign specific tasks to other agents (or to yourself) from each task's form." }), _jsxs("div", { className: "autopilot-hint-actions", children: [_jsx("button", { className: "tasks-new-btn", onClick: () => openEdit(selected), children: "Set default agent" }), _jsx("a", { href: "#/config/autopilot", className: "autopilot-hint-link", children: "Autopilot settings \u2192" })] })] })), selected && activeTab === "tasks" && (_jsx(Tasks, { projectId: selected.id, taskId: taskId })), selected && activeTab === "documents" && (docId
                        ? _jsx(DocumentViewer, { projectId: selected.id, docId: docId })
                        : _jsx(DocumentList, { projectId: selected.id }))] })), showForm && (_jsx("div", { className: "tasks-form-overlay", onClick: () => setShowForm(false), children: _jsxs("div", { className: "tasks-form", onClick: (e) => e.stopPropagation(), children: [_jsx("h3", { children: editingProject ? "Edit Project" : "New Project" }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Title" }), _jsx("input", { className: "field-input", value: formTitle, onChange: (e) => setFormTitle(e.target.value), onKeyDown: (e) => {
                                        if (e.key === "Enter")
                                            handleSubmit();
                                    }, autoFocus: true })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("textarea", { className: "field-textarea", value: formDesc, onChange: (e) => setFormDesc(e.target.value), rows: 3 })] }), _jsxs("div", { className: "tasks-form-row", children: [editingProject && (_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Status" }), _jsx("select", { className: "field-select", value: formStatus, onChange: (e) => setFormStatus(e.target.value), children: Object.entries(STATUS_LABELS).map(([k, v]) => (_jsx("option", { value: k, children: v }, k))) })] })), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Due Date" }), _jsx("input", { className: "field-input", type: "date", value: formDue, onChange: (e) => setFormDue(e.target.value) })] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Default assignee (autopilot agent)" }), _jsxs("select", { className: "field-select", value: formAssignee, onChange: (e) => setFormAssignee(e.target.value), children: [_jsx("option", { value: "", children: "(none \u2014 tasks unassigned by default)" }), Object.keys(agents).map((name) => (_jsx("option", { value: name, children: name }, name)))] })] }), _jsxs("div", { className: "tasks-form-actions", children: [_jsx("button", { className: "tasks-cancel-btn", onClick: () => setShowForm(false), children: "Cancel" }), _jsx("button", { className: "tasks-submit-btn", onClick: handleSubmit, disabled: !formTitle.trim(), children: editingProject ? "Save" : "Create" })] })] }) }))] }));
}
