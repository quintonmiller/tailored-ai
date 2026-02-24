import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRelativeTime } from "../hooks/useRelativeTime";
export function TaskList(props) {
    useRelativeTime();
    const { tasks } = props;
    if (tasks.length === 0) {
        return _jsx("div", { className: "empty-state", children: "No background tasks." });
    }
    return (_jsx("div", { className: "task-list", children: tasks.map((t) => (_jsxs("div", { className: "task-item", children: [_jsxs("div", { className: "task-item-header", children: [_jsx("span", { className: `task-badge ${t.status}`, children: t.status }), _jsx("span", { className: "task-id", children: t.id })] }), _jsx("div", { className: "task-desc", children: t.description }), _jsx("div", { className: "task-meta", children: formatDuration(t.startedAt, t.completedAt) })] }, t.id))) }));
}
function formatDuration(start, end) {
    const ms = (end ?? Date.now()) - start;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
