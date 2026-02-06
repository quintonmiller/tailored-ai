import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { fetchHealth, fetchSessions } from '../api';
import { SessionList } from '../components/SessionList';
import { StatusBar } from '../components/StatusBar';
export function Dashboard() {
    const [health, setHealth] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [error, setError] = useState(null);
    useEffect(() => {
        fetchHealth()
            .then(setHealth)
            .catch((e) => setError(e.message));
        fetchSessions()
            .then(setSessions)
            .catch((e) => setError(e.message));
    }, []);
    return (_jsxs("div", { className: "dashboard", children: [_jsx("h2", { children: "Status" }), _jsxs("div", { className: "health-grid", children: [_jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Status" }), _jsx("div", { className: `value ${health?.status === 'ok' ? 'ok' : ''}`, children: health?.status ?? '...' })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Provider" }), _jsx("div", { className: "value", children: health?.provider ?? '...' })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Model" }), _jsx("div", { className: "value", children: health?.model ?? '...' })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Tools" }), _jsx("div", { className: "value", children: health?.tools ?? '...' })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Uptime" }), _jsx("div", { className: "value", children: health ? formatUptime(health.uptime) : '...' })] })] }), _jsx("h2", { children: "Sessions" }), _jsx(SessionList, { sessions: sessions }), _jsx(StatusBar, { connected: !error, error: error })] }));
}
function formatUptime(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
