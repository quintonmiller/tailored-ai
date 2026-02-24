import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { addProjectTaskComment, createProjectTask, deleteProjectTask, fetchProjectTask, fetchProjectTasks, updateProjectTask, } from "../api";
const BOARD_STATUSES = ["backlog", "in_progress", "blocked", "in_review", "done"];
const ALL_STATUSES = ["backlog", "in_progress", "blocked", "in_review", "done", "archived"];
const STATUS_LABELS = {
    backlog: "Backlog",
    in_progress: "In Progress",
    blocked: "Blocked",
    in_review: "In Review",
    done: "Done",
    archived: "Archived",
};
function relativeTime(iso) {
    const diff = Date.now() - new Date(iso + "Z").getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1)
        return "just now";
    if (mins < 60)
        return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}
const emptyForm = { title: "", description: "", status: "backlog", author: "", tags: "" };
export function Tasks({ taskId, initialStatus, projectId, }) {
    const [tasks, setTasks] = useState([]);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState("");
    const [detail, setDetail] = useState(null);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [form, setForm] = useState(emptyForm);
    const [commentText, setCommentText] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showArchived, setShowArchived] = useState(false);
    // Drag state
    const [dragTaskId, setDragTaskId] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);
    const loadTasks = useCallback(async () => {
        try {
            const res = await fetchProjectTasks({
                search: search || undefined,
                project_id: projectId,
                limit: 200,
            });
            setTasks(res.tasks);
            setTotal(res.total);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
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
    const openDetail = async (id) => {
        window.location.hash = `${basePath}/${id}`;
        try {
            const t = await fetchProjectTask(id);
            setDetail(t);
        }
        catch {
            setError("Failed to load task");
        }
    };
    const closeDetail = () => {
        setDetail(null);
        window.location.hash = basePath;
    };
    const openCreate = (status) => {
        setForm({ ...emptyForm, status: status ?? "backlog" });
        setEditingId(null);
        setShowForm(true);
    };
    const openEdit = (task) => {
        setForm({
            title: task.title,
            description: task.description,
            status: task.status,
            author: task.author,
            tags: task.tags.join(", "),
        });
        setEditingId(task.id);
        setShowForm(true);
    };
    const handleSubmit = async () => {
        if (!form.title.trim())
            return;
        const tags = form.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        try {
            if (editingId) {
                const updated = await updateProjectTask(editingId, {
                    title: form.title,
                    description: form.description,
                    status: form.status,
                    author: form.author,
                    tags,
                });
                if (detail && detail.id === editingId) {
                    setDetail({ ...detail, ...updated });
                }
            }
            else {
                await createProjectTask({
                    title: form.title,
                    description: form.description || undefined,
                    author: form.author || undefined,
                    tags: tags.length ? tags : undefined,
                    status: form.status,
                    project_id: projectId,
                });
            }
            setShowForm(false);
            setEditingId(null);
            await loadTasks();
        }
        catch (e) {
            setError(e.message);
        }
    };
    const handleDelete = async (id) => {
        try {
            await deleteProjectTask(id);
            if (detail?.id === id)
                closeDetail();
            await loadTasks();
        }
        catch (e) {
            setError(e.message);
        }
    };
    const handleComment = async () => {
        if (!detail || !commentText.trim())
            return;
        try {
            const comment = await addProjectTaskComment(detail.id, { content: commentText });
            setDetail({ ...detail, comments: [...detail.comments, comment] });
            setCommentText("");
        }
        catch (e) {
            setError(e.message);
        }
    };
    const handleStatusChange = async (task, newStatus) => {
        // Optimistic update
        setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)));
        try {
            const updated = await updateProjectTask(task.id, { status: newStatus });
            setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...updated } : t)));
            if (detail && detail.id === task.id) {
                setDetail({ ...detail, ...updated });
            }
        }
        catch (e) {
            // Revert
            setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: task.status } : t)));
            setError(e.message);
        }
    };
    // --- Drag handlers ---
    const handleDragStart = (e, taskId) => {
        setDragTaskId(taskId);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", taskId);
        // Make the drag image slightly transparent
        if (e.currentTarget instanceof HTMLElement) {
            e.currentTarget.style.opacity = "0.5";
        }
    };
    const handleDragEnd = (e) => {
        if (e.currentTarget instanceof HTMLElement) {
            e.currentTarget.style.opacity = "1";
        }
        setDragTaskId(null);
        setDropTarget(null);
    };
    const handleDragOver = (e, status) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(status);
    };
    const handleDragLeave = (e, status) => {
        // Only clear if we actually left the lane (not entering a child)
        const related = e.relatedTarget;
        if (related && e.currentTarget.contains(related))
            return;
        if (dropTarget === status)
            setDropTarget(null);
    };
    const handleDrop = async (e, targetStatus) => {
        e.preventDefault();
        setDropTarget(null);
        const droppedId = e.dataTransfer.getData("text/plain");
        if (!droppedId)
            return;
        const task = tasks.find((t) => t.id === droppedId);
        if (!task || task.status === targetStatus)
            return;
        await handleStatusChange(task, targetStatus);
    };
    // Group tasks by status for the board
    const tasksByStatus = new Map();
    for (const status of BOARD_STATUSES) {
        tasksByStatus.set(status, []);
    }
    if (showArchived)
        tasksByStatus.set("archived", []);
    for (const task of tasks) {
        const bucket = tasksByStatus.get(task.status);
        if (bucket) {
            if (!search || task.title.toLowerCase().includes(search.toLowerCase()) ||
                task.description.toLowerCase().includes(search.toLowerCase())) {
                bucket.push(task);
            }
        }
    }
    const archivedCount = tasks.filter((t) => t.status === "archived").length;
    return (_jsxs("div", { className: "tasks-page", children: [_jsxs("div", { className: "tasks-header", children: [_jsxs("h2", { children: ["Project Tasks", total > 0 ? ` (${total})` : ""] }), _jsxs("div", { className: "tasks-header-actions", children: [_jsx("input", { className: "tasks-search", placeholder: "Search...", value: search, onChange: (e) => setSearch(e.target.value) }), _jsx("button", { className: "tasks-new-btn", onClick: () => openCreate(), children: "+ New Task" })] })] }), error && _jsxs("div", { className: "tasks-error", children: [error, _jsx("button", { className: "tasks-error-dismiss", onClick: () => setError(null), children: "x" })] }), showForm && (_jsx("div", { className: "tasks-form-overlay", onClick: () => setShowForm(false), children: _jsxs("div", { className: "tasks-form", onClick: (e) => e.stopPropagation(), children: [_jsx("h3", { children: editingId ? "Edit Task" : "New Task" }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Title" }), _jsx("input", { className: "field-input", value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }), onKeyDown: (e) => { if (e.key === "Enter")
                                        handleSubmit(); }, autoFocus: true })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("textarea", { className: "field-textarea", value: form.description, onChange: (e) => setForm({ ...form, description: e.target.value }), rows: 3 })] }), _jsxs("div", { className: "tasks-form-row", children: [_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Status" }), _jsx("select", { className: "field-select", value: form.status, onChange: (e) => setForm({ ...form, status: e.target.value }), children: ALL_STATUSES.map((s) => (_jsx("option", { value: s, children: STATUS_LABELS[s] }, s))) })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Author" }), _jsx("input", { className: "field-input", value: form.author, onChange: (e) => setForm({ ...form, author: e.target.value }) })] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Tags (comma-separated)" }), _jsx("input", { className: "field-input", value: form.tags, onChange: (e) => setForm({ ...form, tags: e.target.value }) })] }), _jsxs("div", { className: "tasks-form-actions", children: [_jsx("button", { className: "tasks-cancel-btn", onClick: () => setShowForm(false), children: "Cancel" }), _jsx("button", { className: "tasks-submit-btn", onClick: handleSubmit, disabled: !form.title.trim(), children: editingId ? "Save" : "Create" })] })] }) })), detail && (_jsx("div", { className: "tasks-form-overlay", onClick: closeDetail, children: _jsxs("div", { className: "tasks-detail", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "tasks-detail-header", children: [_jsx("h3", { children: detail.title }), _jsxs("div", { className: "tasks-detail-actions", children: [_jsx("button", { className: "tasks-edit-btn", onClick: () => openEdit(detail), children: "Edit" }), _jsx("button", { className: "tasks-delete-btn", onClick: () => handleDelete(detail.id), children: "Delete" }), _jsx("button", { className: "tasks-close-btn", onClick: closeDetail, children: "x" })] })] }), _jsxs("div", { className: "tasks-detail-meta", children: [_jsx("span", { className: `ptask-status-badge ${detail.status}`, children: STATUS_LABELS[detail.status] ?? detail.status }), detail.author && _jsx("span", { className: "tasks-detail-author", children: detail.author }), _jsx("span", { className: "tasks-detail-time", children: relativeTime(detail.updated_at) }), _jsx("span", { className: "tasks-detail-id", children: detail.id })] }), detail.tags.length > 0 && (_jsx("div", { className: "tasks-detail-tags", children: detail.tags.map((tag) => (_jsx("span", { className: "ptask-tag", children: tag }, tag))) })), detail.description && (_jsx("div", { className: "tasks-detail-desc", children: detail.description })), _jsxs("div", { className: "tasks-detail-comments", children: [_jsxs("h4", { children: ["Comments (", detail.comments.length, ")"] }), detail.comments.map((c) => (_jsxs("div", { className: "tasks-comment", children: [_jsxs("div", { className: "tasks-comment-header", children: [c.author && _jsx("span", { className: "tasks-comment-author", children: c.author }), _jsx("span", { className: "tasks-comment-time", children: relativeTime(c.created_at) })] }), _jsx("div", { className: "tasks-comment-body", children: c.content })] }, c.id))), _jsxs("div", { className: "tasks-comment-form", children: [_jsx("input", { className: "field-input", placeholder: "Add a comment...", value: commentText, onChange: (e) => setCommentText(e.target.value), onKeyDown: (e) => {
                                                if (e.key === "Enter")
                                                    handleComment();
                                            } }), _jsx("button", { className: "tasks-submit-btn", onClick: handleComment, disabled: !commentText.trim(), children: "Send" })] })] })] }) })), loading ? (_jsx("div", { className: "board-skeleton", children: BOARD_STATUSES.map((s) => (_jsxs("div", { className: "board-lane skeleton-pulse", children: [_jsx("div", { className: "board-lane-header", children: _jsx("span", { children: STATUS_LABELS[s] }) }), _jsx("div", { className: "skeleton-card", style: { height: 60 } }), _jsx("div", { className: "skeleton-card", style: { height: 60 } })] }, s))) })) : tasks.length === 0 && !search ? (_jsxs("div", { className: "empty-state", children: ["No tasks yet.", " ", _jsx("button", { className: "tasks-new-btn", onClick: () => openCreate(), children: "+ Create one" })] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "board", children: Array.from(tasksByStatus.entries()).map(([status, laneTasks]) => (_jsxs("div", { className: `board-lane${dropTarget === status ? " board-lane-drop-active" : ""}`, onDragOver: (e) => handleDragOver(e, status), onDragLeave: (e) => handleDragLeave(e, status), onDrop: (e) => handleDrop(e, status), children: [_jsxs("div", { className: "board-lane-header", children: [_jsx("span", { className: `ptask-status-dot ${status}` }), _jsx("span", { className: "board-lane-title", children: STATUS_LABELS[status] }), _jsx("span", { className: "board-lane-count", children: laneTasks.length }), _jsx("button", { className: "board-lane-add", onClick: () => openCreate(status), title: `Add to ${STATUS_LABELS[status]}`, children: "+" })] }), _jsx("div", { className: "board-lane-body", children: laneTasks.map((task) => (_jsxs("div", { className: `board-card${dragTaskId === task.id ? " board-card-dragging" : ""}`, draggable: true, onDragStart: (e) => handleDragStart(e, task.id), onDragEnd: handleDragEnd, onClick: () => openDetail(task.id), children: [_jsx("div", { className: "board-card-title", children: task.title }), _jsxs("div", { className: "board-card-meta", children: [task.tags.length > 0 && (_jsx("span", { className: "ptask-card-tags", children: task.tags.map((tag) => (_jsx("span", { className: "ptask-tag", children: tag }, tag))) })), task.author && _jsx("span", { className: "board-card-author", children: task.author })] })] }, task.id))) })] }, status))) }), archivedCount > 0 && !showArchived && (_jsxs("button", { className: "board-show-archived", onClick: () => setShowArchived(true), children: ["Show ", archivedCount, " archived task", archivedCount !== 1 ? "s" : ""] })), showArchived && archivedCount > 0 && (_jsx("button", { className: "board-show-archived", onClick: () => setShowArchived(false), children: "Hide archived tasks" }))] }))] }));
}
