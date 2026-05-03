import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { addProjectTaskComment, createProjectTask, deleteProjectTask, fetchAgents, fetchProjectTask, fetchProjectTasks, updateProjectTask, } from "../api";
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
const emptyForm = {
    title: "",
    description: "",
    status: "backlog",
    author: "",
    tags: "",
    assignee: "",
    rank: "",
};
function blockedReasonLabel(reason) {
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
    const [agents, setAgents] = useState({});
    const [answerText, setAnswerText] = useState("");
    useEffect(() => {
        fetchAgents()
            .then(setAgents)
            .catch(() => setAgents({}));
    }, []);
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
            assignee: task.assignee ?? "",
            rank: String(task.rank ?? ""),
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
            }
            else {
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
    // Sort backlog by rank ascending, in_progress/blocked/in_review by updated_at.
    const backlog = tasksByStatus.get("backlog");
    if (backlog)
        backlog.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
    const archivedCount = tasks.filter((t) => t.status === "archived").length;
    const handleResumeFromQuestion = async () => {
        if (!detail || !answerText.trim())
            return;
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
        }
        catch (e) {
            setError(e.message);
        }
    };
    return (_jsxs("div", { className: "tasks-page", children: [_jsxs("div", { className: "tasks-header", children: [_jsxs("h2", { children: ["Project Tasks", total > 0 ? ` (${total})` : ""] }), _jsxs("div", { className: "tasks-header-actions", children: [_jsx("input", { className: "tasks-search", placeholder: "Search...", value: search, onChange: (e) => setSearch(e.target.value) }), _jsx("button", { className: "tasks-new-btn", onClick: () => openCreate(), children: "+ New Task" })] })] }), error && _jsxs("div", { className: "tasks-error", children: [error, _jsx("button", { className: "tasks-error-dismiss", onClick: () => setError(null), children: "x" })] }), showForm && (_jsx("div", { className: "tasks-form-overlay", onClick: () => setShowForm(false), children: _jsxs("div", { className: "tasks-form", onClick: (e) => e.stopPropagation(), children: [_jsx("h3", { children: editingId ? "Edit Task" : "New Task" }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Title" }), _jsx("input", { className: "field-input", value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }), onKeyDown: (e) => { if (e.key === "Enter")
                                        handleSubmit(); }, autoFocus: true })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Description" }), _jsx("textarea", { className: "field-textarea", value: form.description, onChange: (e) => setForm({ ...form, description: e.target.value }), rows: 3 })] }), _jsxs("div", { className: "tasks-form-row", children: [_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Status" }), _jsx("select", { className: "field-select", value: form.status, onChange: (e) => setForm({ ...form, status: e.target.value }), children: ALL_STATUSES.map((s) => (_jsx("option", { value: s, children: STATUS_LABELS[s] }, s))) })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Author" }), _jsx("input", { className: "field-input", value: form.author, onChange: (e) => setForm({ ...form, author: e.target.value }) })] })] }), _jsxs("div", { className: "tasks-form-row", children: [_jsxs("div", { className: "field-group", style: { flex: 2 }, children: [_jsx("label", { className: "field-label", children: "Assignee" }), _jsxs("select", { className: "field-select", value: form.assignee, onChange: (e) => setForm({ ...form, assignee: e.target.value }), children: [_jsx("option", { value: "", children: "(unassigned)" }), Object.keys(agents).map((name) => (_jsxs("option", { value: name, children: ["@", name] }, name)))] })] }), _jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Rank" }), _jsx("input", { className: "field-input", type: "number", min: 1, placeholder: "auto", value: form.rank, onChange: (e) => setForm({ ...form, rank: e.target.value }) })] })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Tags (comma-separated)" }), _jsx("input", { className: "field-input", value: form.tags, onChange: (e) => setForm({ ...form, tags: e.target.value }) })] }), _jsxs("div", { className: "tasks-form-actions", children: [_jsx("button", { className: "tasks-cancel-btn", onClick: () => setShowForm(false), children: "Cancel" }), _jsx("button", { className: "tasks-submit-btn", onClick: handleSubmit, disabled: !form.title.trim(), children: editingId ? "Save" : "Create" })] })] }) })), detail && (_jsx("div", { className: "tasks-form-overlay", onClick: closeDetail, children: _jsxs("div", { className: "tasks-detail", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "tasks-detail-header", children: [_jsx("h3", { children: detail.title }), _jsxs("div", { className: "tasks-detail-actions", children: [_jsx("button", { className: "tasks-edit-btn", onClick: () => openEdit(detail), children: "Edit" }), _jsx("button", { className: "tasks-delete-btn", onClick: () => handleDelete(detail.id), children: "Delete" }), _jsx("button", { className: "tasks-close-btn", onClick: closeDetail, children: "x" })] })] }), _jsxs("div", { className: "tasks-detail-meta", children: [_jsx("span", { className: `ptask-status-badge ${detail.status}`, children: detail.status === "blocked"
                                        ? blockedReasonLabel(detail.blocked_reason)
                                        : STATUS_LABELS[detail.status] ?? detail.status }), detail.assignee && (_jsxs("span", { className: "tasks-detail-author", title: "Assignee", children: ["@", detail.assignee] })), detail.author && _jsx("span", { className: "tasks-detail-author", children: detail.author }), _jsx("span", { className: "tasks-detail-time", children: relativeTime(detail.updated_at) }), _jsx("span", { className: "tasks-detail-id", children: detail.id })] }), detail.status === "blocked" && detail.blocked_reason === "question" && (_jsxs("div", { className: "tasks-form-row", style: { background: "rgba(255,170,0,0.08)", padding: 12, borderRadius: 6, marginBottom: 12 }, children: [_jsxs("div", { className: "field-group", style: { flex: 1 }, children: [_jsx("label", { className: "field-label", children: "Answer \u2014 unblocks the agent and resumes work" }), _jsx("input", { className: "field-input", placeholder: "Your answer...", value: answerText, onChange: (e) => setAnswerText(e.target.value), onKeyDown: (e) => { if (e.key === "Enter")
                                                handleResumeFromQuestion(); } })] }), _jsx("button", { className: "tasks-submit-btn", onClick: handleResumeFromQuestion, disabled: !answerText.trim(), style: { alignSelf: "flex-end" }, children: "Resume" })] })), detail.tags.length > 0 && (_jsx("div", { className: "tasks-detail-tags", children: detail.tags.map((tag) => (_jsx("span", { className: "ptask-tag", children: tag }, tag))) })), detail.description && (_jsx("div", { className: "tasks-detail-desc", children: detail.description })), _jsxs("div", { className: "tasks-detail-comments", children: [_jsxs("h4", { children: ["Comments (", detail.comments.length, ")"] }), detail.comments.map((c) => (_jsxs("div", { className: "tasks-comment", children: [_jsxs("div", { className: "tasks-comment-header", children: [c.author && _jsx("span", { className: "tasks-comment-author", children: c.author }), _jsx("span", { className: "tasks-comment-time", children: relativeTime(c.created_at) })] }), _jsx("div", { className: "tasks-comment-body", children: c.content })] }, c.id))), _jsxs("div", { className: "tasks-comment-form", children: [_jsx("input", { className: "field-input", placeholder: "Add a comment...", value: commentText, onChange: (e) => setCommentText(e.target.value), onKeyDown: (e) => {
                                                if (e.key === "Enter")
                                                    handleComment();
                                            } }), _jsx("button", { className: "tasks-submit-btn", onClick: handleComment, disabled: !commentText.trim(), children: "Send" })] })] })] }) })), loading ? (_jsx("div", { className: "board-skeleton", children: BOARD_STATUSES.map((s) => (_jsxs("div", { className: "board-lane skeleton-pulse", children: [_jsx("div", { className: "board-lane-header", children: _jsx("span", { children: STATUS_LABELS[s] }) }), _jsx("div", { className: "skeleton-card", style: { height: 60 } }), _jsx("div", { className: "skeleton-card", style: { height: 60 } })] }, s))) })) : tasks.length === 0 && !search ? (_jsxs("div", { className: "empty-state", children: ["No tasks yet.", " ", _jsx("button", { className: "tasks-new-btn", onClick: () => openCreate(), children: "+ Create one" })] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "board", children: Array.from(tasksByStatus.entries()).map(([status, laneTasks]) => (_jsxs("div", { className: `board-lane${dropTarget === status ? " board-lane-drop-active" : ""}`, onDragOver: (e) => handleDragOver(e, status), onDragLeave: (e) => handleDragLeave(e, status), onDrop: (e) => handleDrop(e, status), children: [_jsxs("div", { className: "board-lane-header", children: [_jsx("span", { className: `ptask-status-dot ${status}` }), _jsx("span", { className: "board-lane-title", children: STATUS_LABELS[status] }), _jsx("span", { className: "board-lane-count", children: laneTasks.length }), _jsx("button", { className: "board-lane-add", onClick: () => openCreate(status), title: `Add to ${STATUS_LABELS[status]}`, children: "+" })] }), _jsx("div", { className: "board-lane-body", children: laneTasks.map((task) => (_jsxs("div", { className: `board-card${dragTaskId === task.id ? " board-card-dragging" : ""}`, draggable: true, onDragStart: (e) => handleDragStart(e, task.id), onDragEnd: handleDragEnd, onClick: () => openDetail(task.id), children: [_jsx("div", { className: "board-card-title", children: task.title }), task.status === "blocked" && task.blocked_reason && (_jsx("div", { className: `board-card-blocked-reason reason-${task.blocked_reason}`, children: blockedReasonLabel(task.blocked_reason) })), _jsxs("div", { className: "board-card-meta", children: [status === "backlog" && task.rank ? (_jsxs("span", { className: "board-card-rank", title: "Rank", children: ["#", task.rank] })) : null, task.assignee && (_jsxs("span", { className: "board-card-assignee", title: "Assignee", children: ["@", task.assignee] })), task.tags.length > 0 && (_jsx("span", { className: "ptask-card-tags", children: task.tags.map((tag) => (_jsx("span", { className: "ptask-tag", children: tag }, tag))) })), task.author && !task.assignee && _jsx("span", { className: "board-card-author", children: task.author })] })] }, task.id))) })] }, status))) }), archivedCount > 0 && !showArchived && (_jsxs("button", { className: "board-show-archived", onClick: () => setShowArchived(true), children: ["Show ", archivedCount, " archived task", archivedCount !== 1 ? "s" : ""] })), showArchived && archivedCount > 0 && (_jsx("button", { className: "board-show-archived", onClick: () => setShowArchived(false), children: "Hide archived tasks" }))] }))] }));
}
