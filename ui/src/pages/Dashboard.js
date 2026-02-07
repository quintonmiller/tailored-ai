import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { fetchHealth, fetchSessions, fetchProfiles, fetchCron, fetchTasks, fetchContext, } from '../api';
import { SessionList } from '../components/SessionList';
import { StatusBar } from '../components/StatusBar';
import { ProfileCard } from '../components/ProfileCard';
import { CronJobList } from '../components/CronJobList';
import { TaskList } from '../components/TaskList';
import { ContextFiles } from '../components/ContextFiles';
export function Dashboard() {
    const [health, setHealth] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [profiles, setProfiles] = useState({});
    const [cron, setCron] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [context, setContext] = useState(null);
    const [error, setError] = useState(null);
    const pollRef = useRef(undefined);
    useEffect(() => {
        const onError = (e) => setError(e.message);
        fetchHealth().then(setHealth).catch(onError);
        fetchSessions().then(setSessions).catch(onError);
        fetchProfiles().then(setProfiles).catch(onError);
        fetchCron().then(setCron).catch(onError);
        fetchTasks().then(setTasks).catch(onError);
        fetchContext().then(setContext).catch(onError);
    }, []);
    // Auto-poll tasks when any are running
    useEffect(() => {
        const hasRunning = tasks.some((t) => t.status === 'running');
        if (hasRunning && !pollRef.current) {
            pollRef.current = setInterval(() => {
                fetchTasks().then(setTasks).catch(() => { });
            }, 5000);
        }
        else if (!hasRunning && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = undefined;
        }
        return () => {
            if (pollRef.current)
                clearInterval(pollRef.current);
        };
    }, [tasks]);
    const profileEntries = Object.entries(profiles);
    return (_jsxs("div", { className: "dashboard", children: [_jsx("h2", { children: "Status" }), _jsxs("div", { className: "health-grid", children: [_jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Status" }), _jsx("div", { className: `value ${health?.status === 'ok' ? 'ok' : ''}`, children: health?.status ?? '...' })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Provider" }), _jsx("div", { className: "value", children: health?.provider ?? '...' })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Model" }), _jsx("div", { className: "value", children: health?.model ?? '...' })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Tools" }), _jsx("div", { className: "value", children: _jsx("a", { href: "#/tools", className: "health-link", children: health?.tools ?? '...' }) })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Uptime" }), _jsx("div", { className: "value", children: health ? formatUptime(health.uptime) : '...' })] })] }), _jsx("h2", { children: "Profiles" }), profileEntries.length === 0 ? (_jsx("div", { className: "empty-state", children: "No profiles configured." })) : (_jsx("div", { className: "profile-grid", children: profileEntries.map(([name, profile]) => (_jsx(ProfileCard, { name: name, profile: profile }, name))) })), _jsx("h2", { children: "Cron Jobs" }), cron ? _jsx(CronJobList, { data: cron, onJobTriggered: () => fetchCron().then(setCron) }) : _jsx("div", { className: "empty-state", children: "Loading..." }), _jsx("h2", { children: "Background Tasks" }), _jsx(TaskList, { tasks: tasks }), _jsx("h2", { children: "Context Files" }), context ? _jsx(ContextFiles, { data: context }) : _jsx("div", { className: "empty-state", children: "Loading..." }), _jsx("h2", { children: "Sessions" }), _jsx(SessionList, { sessions: sessions }), _jsx(StatusBar, { connected: !error, error: error })] }));
}
function formatUptime(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
