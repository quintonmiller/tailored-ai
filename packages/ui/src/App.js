import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchAutopilotActivity, fetchHealth } from "./api";
import { BRAND } from "./brand";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { Chat } from "./pages/Chat";
import { Config } from "./pages/Config";
import { Dashboard } from "./pages/Dashboard";
import { Help } from "./pages/Help";
import { Projects } from "./pages/Projects";
import { Sandboxes } from "./pages/Sandboxes";
import { Tasks } from "./pages/Tasks";
import { Tools } from "./pages/Tools";
import { Workflows } from "./pages/Workflows";
import { WorkflowRuns } from "./pages/WorkflowRuns";
import "./styles.css";
function parseHash() {
    const hash = window.location.hash.slice(1);
    if (hash.startsWith("/projects")) {
        const parts = hash.split("?")[0].split("/");
        // #/projects -> page=projects
        // #/projects/:id -> page=projects, projectId=id
        // #/projects/:id/tasks -> page=projects, projectId=id, tab=tasks
        // #/projects/:id/tasks/:tid -> page=projects, projectId=id, tab=tasks, taskId=tid
        // #/projects/:id/documents -> page=projects, projectId=id, tab=documents
        // #/projects/:id/documents/:did -> page=projects, projectId=id, tab=documents, docId=did
        const projectId = parts[2] || undefined;
        const tabStr = parts[3];
        const tab = tabStr === "tasks" || tabStr === "documents" ? tabStr : undefined;
        const subId = parts[4] || undefined;
        return {
            page: "projects",
            projectId,
            tab,
            taskId: tab === "tasks" ? subId : undefined,
            docId: tab === "documents" ? subId : undefined,
        };
    }
    if (hash.startsWith("/tasks")) {
        // Redirect #/tasks to #/projects for backward compat
        const params = new URLSearchParams(hash.split("?")[1] ?? "");
        const parts = hash.split("?")[0].split("/");
        return {
            page: "tasks",
            taskId: parts[2] || undefined,
            status: params.get("status") ?? undefined,
        };
    }
    if (hash.startsWith("/chat")) {
        const params = new URLSearchParams(hash.split("?")[1] ?? "");
        return {
            page: "chat",
            sessionKey: params.get("key") ?? undefined,
            sessionId: params.get("session") ?? undefined,
        };
    }
    if (hash.startsWith("/config")) {
        const parts = hash.split("/");
        const section = parts[2] || undefined;
        return { page: "config", section };
    }
    if (hash.startsWith("/tools")) {
        return { page: "tools" };
    }
    if (hash.startsWith("/workflow-runs")) {
        const parts = hash.split("?")[0].split("/");
        return { page: "workflow-runs", runId: parts[2] || undefined };
    }
    if (hash.startsWith("/workflows")) {
        return { page: "workflows" };
    }
    if (hash.startsWith("/sandboxes")) {
        return { page: "sandboxes" };
    }
    if (hash.startsWith("/autopilot")) {
        // Moved under Config — redirect for back-compat.
        window.location.hash = "/config/autopilot";
        return { page: "config", section: "autopilot" };
    }
    if (hash.startsWith("/help")) {
        return { page: "help" };
    }
    return { page: "dashboard" };
}
export function App() {
    const [route, setRoute] = useState(parseHash);
    const [connected, setConnected] = useState(null);
    const [activity, setActivity] = useState(null);
    useEffect(() => {
        const onHash = () => setRoute(parseHash());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);
    // Poll health every 30s
    useEffect(() => {
        const check = () => {
            fetchHealth()
                .then(() => setConnected(true))
                .catch(() => setConnected(false));
        };
        check();
        const id = setInterval(check, 30_000);
        return () => clearInterval(id);
    }, []);
    // Poll autopilot activity every 5s
    useEffect(() => {
        const check = () => {
            fetchAutopilotActivity()
                .then((a) => setActivity(a.current))
                .catch(() => setActivity(null));
        };
        check();
        const id = setInterval(check, 5_000);
        return () => clearInterval(id);
    }, []);
    return (_jsxs("div", { className: "app", children: [_jsxs("header", { className: "app-header", children: [_jsx("a", { href: "#/", className: "app-title", children: BRAND.name }), _jsxs("nav", { children: [_jsx("a", { href: "#/", className: route.page === "dashboard" ? "active" : "", children: "Dashboard" }), _jsx("a", { href: "#/projects", className: route.page === "projects" || route.page === "tasks" ? "active" : "", children: "Projects" }), _jsx("a", { href: "#/tools", className: route.page === "tools" ? "active" : "", children: "Tools" }), _jsx("a", { href: "#/workflows", className: route.page === "workflows" || route.page === "workflow-runs" ? "active" : "", children: "Workflows" }), _jsx("a", { href: "#/sandboxes", className: route.page === "sandboxes" ? "active" : "", children: "Sandboxes" }), _jsx("a", { href: "#/chat", className: route.page === "chat" ? "active" : "", children: "Chat" }), _jsx("a", { href: "#/config", className: route.page === "config" ? "active" : "", children: "Config" }), _jsx("a", { href: "#/help", className: route.page === "help" ? "active" : "", children: "Help" }), _jsx(ProjectSwitcher, {}), connected !== null && (_jsx("span", { className: "header-status", title: connected ? "Connected" : "Disconnected", children: _jsx("span", { className: `status-dot${connected ? "" : " error"}` }) }))] })] }), _jsxs("main", { className: "app-main", children: [route.page === "dashboard" && _jsx(Dashboard, {}), route.page === "projects" && (_jsx(Projects, { projectId: route.projectId, tab: route.tab, taskId: route.taskId, docId: route.docId })), route.page === "tasks" && _jsx(Tasks, { taskId: route.taskId, initialStatus: route.status }), route.page === "chat" && _jsx(Chat, { sessionKey: route.sessionKey, sessionId: route.sessionId }), route.page === "tools" && _jsx(Tools, {}), route.page === "workflows" && _jsx(Workflows, {}), route.page === "workflow-runs" && _jsx(WorkflowRuns, { runId: route.runId }), route.page === "sandboxes" && _jsx(Sandboxes, {}), route.page === "config" && _jsx(Config, { section: route.section }), route.page === "help" && _jsx(Help, {})] }), activity && (_jsxs("div", { className: "autopilot-activity-strip", role: "status", children: [_jsx("span", { className: "autopilot-activity-dot" }), _jsx("span", { className: "autopilot-activity-label", children: "Agent working on:" }), _jsx("a", { href: `#/tasks/${activity.taskId}`, className: "autopilot-activity-link", children: activity.title })] })), _jsxs("footer", { className: "app-footer", children: [_jsx("span", { className: "app-footer-brand", children: BRAND.name }), _jsx("span", { className: "app-footer-sep" }), _jsx("a", { href: BRAND.docs, target: "_blank", rel: "noopener noreferrer", children: "Docs" }), _jsx("a", { href: BRAND.github, target: "_blank", rel: "noopener noreferrer", children: "GitHub" }), _jsx("a", { href: BRAND.website, target: "_blank", rel: "noopener noreferrer", children: "Website" })] })] }));
}
