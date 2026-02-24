import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRelativeTime } from "../hooks/useRelativeTime";
export function SessionList(props) {
    useRelativeTime();
    if (props.sessions.length === 0) {
        return _jsx("div", { className: "empty-state", children: "No sessions yet. Start a new chat." });
    }
    return (_jsx("div", { className: "session-list", children: props.sessions.map((s) => (_jsxs("a", { className: "session-item", href: `#/chat?key=${encodeURIComponent(s.key ?? "")}&session=${encodeURIComponent(s.id)}`, children: [_jsx("span", { className: "session-key", children: s.key ?? s.id.slice(0, 8) }), _jsxs("span", { className: "session-meta", children: [s.model, " \u00B7 ", formatTime(s.updated_at)] })] }, s.id))) }));
}
function formatTime(iso) {
    const d = new Date(`${iso}Z`);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000)
        return "just now";
    if (diff < 3600_000)
        return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000)
        return `${Math.floor(diff / 3600_000)}h ago`;
    return d.toLocaleDateString();
}
