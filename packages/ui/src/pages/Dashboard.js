import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { fetchContext, fetchCron, fetchHealth, fetchAgents, fetchProjects, fetchSessions, fetchBackgroundTasks, fetchActivity, } from "../api";
import { AgentCard } from "../components/AgentCard";
import { ContextFiles } from "../components/ContextFiles";
import { CronJobList } from "../components/CronJobList";
import { SessionList } from "../components/SessionList";
import { TaskList } from "../components/TaskList";
const PROJECT_STATUS_LABELS = {
    active: "Active",
    completed: "Completed",
    archived: "Archived",
};
export function Dashboard() {
    const [health, setHealth] = useState(null);
    const [sessions, setSessions] = useState(null);
    const [agents, setAgents] = useState(null);
    const [cron, setCron] = useState(null);
    const [tasks, setTasks] = useState(null);
    const [projects, setProjects] = useState(null);
    const [context, setContext] = useState(null);
    const [activity, setActivity] = useState([]);
    const [error, setError] = useState(null);
    const pollRef = useRef(undefined);
    const activityPollRef = useRef(undefined);
    useEffect(() => {
        const onError = (e) => setError(e.message);
        fetchHealth().then(setHealth).catch(onError);
        fetchSessions().then(setSessions).catch(onError);
        fetchAgents().then(setAgents).catch(onError);
        fetchCron().then(setCron).catch(onError);
        fetchBackgroundTasks().then(setTasks).catch(onError);
        fetchProjects({ limit: 10 }).then(setProjects).catch(onError);
        fetchContext().then(setContext).catch(onError);
        fetchActivity().then(setActivity).catch(() => { });
    }, []);
    // Poll activity every 3s
    useEffect(() => {
        activityPollRef.current = setInterval(() => {
            fetchActivity().then(setActivity).catch(() => { });
        }, 3000);
        return () => {
            if (activityPollRef.current)
                clearInterval(activityPollRef.current);
        };
    }, []);
    // Auto-poll tasks when any are running
    useEffect(() => {
        if (!tasks)
            return;
        const hasRunning = tasks.some((t) => t.status === "running");
        if (hasRunning && !pollRef.current) {
            pollRef.current = setInterval(() => {
                fetchBackgroundTasks()
                    .then(setTasks)
                    .catch(() => { });
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
    const agentEntries = agents ? Object.entries(agents) : [];
    const activityByName = new Map(activity.map((a) => [a.agentName, a]));
    return (_jsxs("div", { className: "dashboard", children: [_jsxs("div", { className: "dashboard-section-header", children: [_jsx("h2", { children: "Status" }), _jsx("a", { href: "#/config", className: "dashboard-section-link", children: "Configure providers" })] }), health ? (_jsxs("div", { className: "health-grid", children: [_jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Status" }), _jsx("div", { className: `value ${health.status === "ok" ? "ok" : ""}`, children: health.status })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Provider" }), _jsx("div", { className: "value", children: health.provider })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Model" }), _jsx("div", { className: "value", children: health.model })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Tools" }), _jsx("div", { className: "value", children: _jsx("a", { href: "#/tools", className: "health-link", children: health.tools }) })] }), _jsxs("div", { className: "health-card", children: [_jsx("div", { className: "label", children: "Uptime" }), _jsx("div", { className: "value", children: formatUptime(health.uptime) })] })] })) : (_jsx("div", { className: "health-grid", children: [...Array(5)].map((_, i) => (_jsxs("div", { className: "health-card skeleton-pulse", children: [_jsx("div", { className: "label", children: "\u00A0" }), _jsx("div", { className: "value", children: "\u00A0" })] }, i))) })), _jsxs("div", { className: "dashboard-section-header", children: [_jsx("h2", { children: "Agents" }), _jsx("a", { href: "#/config/agents", className: "dashboard-section-link", children: "+ Add agent" })] }), agents === null ? (_jsxs("div", { className: "skeleton-list", children: [_jsx("div", { className: "skeleton-card" }), _jsx("div", { className: "skeleton-card" })] })) : agentEntries.length === 0 ? (_jsxs("div", { className: "empty-state", children: ["No agents configured. ", _jsx("a", { href: "#/config/agents", className: "dashboard-section-link", children: "Add one" })] })) : (_jsx("div", { className: "agent-grid", children: agentEntries.map(([name, agentDef]) => (_jsx(AgentCard, { name: name, agent: agentDef, activity: activityByName.get(name) }, name))) })), _jsxs("div", { className: "dashboard-section-header", children: [_jsx("h2", { children: "Cron Jobs" }), _jsx("a", { href: "#/config/cron", className: "dashboard-section-link", children: "+ Add job" })] }), cron ? (_jsx(CronJobList, { data: cron, onJobTriggered: () => fetchCron().then(setCron) })) : (_jsx("div", { className: "skeleton-list", children: _jsx("div", { className: "skeleton-card" }) })), _jsxs("div", { className: "dashboard-section-header", children: [_jsx("h2", { children: "Projects" }), _jsx("a", { href: "#/projects", className: "dashboard-section-link", children: "View all" })] }), projects ? (projects.total === 0 ? (_jsxs("div", { className: "empty-state", children: ["No projects yet. ", _jsx("a", { href: "#/projects", className: "dashboard-section-link", children: "Create one" })] })) : (_jsxs("div", { className: "project-card-grid", children: [projects.projects.slice(0, 5).map((p) => (_jsxs("a", { href: `#/projects/${p.id}`, className: "project-card", children: [_jsxs("div", { className: "project-card-header", children: [_jsx("span", { className: `project-status-dot ${p.status}` }), _jsx("span", { className: "project-card-title", children: p.title }), _jsx("span", { className: "project-card-status", children: PROJECT_STATUS_LABELS[p.status] ?? p.status })] }), p.description && (_jsx("div", { className: "project-card-desc", children: p.description })), _jsxs("div", { className: "project-card-counts", children: [_jsxs("span", { children: [p.task_count, " tasks"] }), _jsxs("span", { children: [p.document_count, " docs"] })] })] }, p.id))), projects.total > 5 && (_jsxs("a", { href: "#/projects", className: "ptask-recent-more", children: ["+", projects.total - 5, " more"] }))] }))) : (_jsx("div", { className: "skeleton-list", children: _jsx("div", { className: "skeleton-card" }) })), _jsx("h2", { children: "Background Tasks" }), tasks ? (_jsx(TaskList, { tasks: tasks })) : (_jsx("div", { className: "skeleton-list", children: _jsx("div", { className: "skeleton-card" }) })), _jsx("div", { className: "dashboard-section-header", children: _jsx("h2", { children: "Context Files" }) }), context ? (_jsx(ContextFiles, { data: context })) : (_jsx("div", { className: "skeleton-list", children: _jsx("div", { className: "skeleton-card" }) })), _jsx("h2", { children: "Sessions" }), sessions ? (_jsx(SessionList, { sessions: sessions })) : (_jsxs("div", { className: "skeleton-list", children: [_jsx("div", { className: "skeleton-card" }), _jsx("div", { className: "skeleton-card" })] }))] }));
}
function formatUptime(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
