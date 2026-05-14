import { useEffect, useState } from "react";
import { type AutopilotActivity, fetchAutopilotActivity, fetchHealth } from "./api";
import { BRAND } from "./brand";
import { ChatProvider } from "./components/ChatContext";
import { ChatDock } from "./components/ChatDock";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ToastProvider } from "./components/Toast";
import { Agents } from "./pages/Agents";
import { Chat } from "./pages/Chat";
import { Config } from "./pages/Config";
import { Dashboard } from "./pages/Dashboard";
import { Help } from "./pages/Help";
import { Memory } from "./pages/Memory";
import { Projects } from "./pages/Projects";
import { Resources } from "./pages/Resources";
import { Sandboxes } from "./pages/Sandboxes";
import { Tasks } from "./pages/Tasks";
import { Tools } from "./pages/Tools";
import { Workflows } from "./pages/Workflows";
import { WorkflowAnalytics } from "./pages/WorkflowAnalytics";
import { WorkflowRuns } from "./pages/WorkflowRuns";
import "./styles.css";

type Route =
  | { page: "dashboard" }
  | { page: "agents"; agentName?: string }
  | { page: "projects"; projectId?: string; tab?: "tasks" | "documents"; taskId?: string; docId?: string }
  | { page: "tasks"; taskId?: string; status?: string }
  | { page: "chat"; sessionKey?: string; sessionId?: string }
  | { page: "config"; section?: string }
  | { page: "tools" }
  | { page: "workflows" }
  | { page: "workflow-runs"; runId?: string }
  | { page: "workflow-analytics" }
  | { page: "sandboxes" }
  | { page: "resources" }
  | { page: "memory" }
  | { page: "help" };

function parseHash(): Route {
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
    const tabStr = parts[3] as "tasks" | "documents" | undefined;
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
  if (hash.startsWith("/agents")) {
    const parts = hash.split("?")[0].split("/");
    return { page: "agents", agentName: parts[2] || undefined };
  }
  if (hash.startsWith("/tools")) {
    return { page: "tools" };
  }
  if (hash.startsWith("/workflow-analytics")) {
    return { page: "workflow-analytics" };
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
  if (hash.startsWith("/resources")) {
    return { page: "resources" };
  }
  if (hash.startsWith("/memory")) {
    return { page: "memory" };
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
  const [route, setRoute] = useState<Route>(parseHash);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [activity, setActivity] = useState<AutopilotActivity["current"] | null>(null);

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

  return (
    <ToastProvider>
      <ChatProvider>
        <AppShell route={route} connected={connected} activity={activity} />
        <ChatDock />
      </ChatProvider>
    </ToastProvider>
  );
}

function AppShell({
  route,
  connected,
  activity,
}: {
  route: Route;
  connected: boolean | null;
  activity: AutopilotActivity["current"] | null;
}) {
  return (
    <div className="app">
      <header className="app-header">
        <a href="#/" className="app-title">
          {BRAND.name}
        </a>
        <nav>
          <a href="#/" className={route.page === "dashboard" ? "active" : ""}>
            Dashboard
          </a>
          <a href="#/projects" className={route.page === "projects" || route.page === "tasks" ? "active" : ""}>
            Projects
          </a>
          <a href="#/agents" className={route.page === "agents" ? "active" : ""}>
            Agents
          </a>
          <a href="#/tools" className={route.page === "tools" ? "active" : ""}>
            Tools
          </a>
          <a
            href="#/workflows"
            className={route.page === "workflows" || route.page === "workflow-runs" ? "active" : ""}
          >
            Workflows
          </a>
          <a href="#/sandboxes" className={route.page === "sandboxes" ? "active" : ""}>
            Sandboxes
          </a>
          <a href="#/resources" className={route.page === "resources" ? "active" : ""}>
            Resources
          </a>
          <a href="#/memory" className={route.page === "memory" ? "active" : ""}>
            Memory
          </a>
          <a href="#/chat" className={route.page === "chat" ? "active" : ""}>
            Chat
          </a>
          <a href="#/config" className={route.page === "config" ? "active" : ""}>
            Config
          </a>
          <a href="#/help" className={route.page === "help" ? "active" : ""}>
            Help
          </a>
          <ProjectSwitcher />
          {connected !== null && (
            <span className="header-status" title={connected ? "Connected" : "Disconnected"}>
              <span className={`status-dot${connected ? "" : " error"}`} />
            </span>
          )}
        </nav>
      </header>
      <main className="app-main">
        {route.page === "dashboard" && <Dashboard />}
        {route.page === "projects" && (
          <Projects
            projectId={route.projectId}
            tab={route.tab}
            taskId={route.taskId}
            docId={route.docId}
          />
        )}
        {route.page === "agents" && <Agents agentName={route.agentName} />}
        {route.page === "tasks" && <Tasks taskId={route.taskId} initialStatus={route.status} />}
        {route.page === "chat" && <Chat sessionKey={route.sessionKey} sessionId={route.sessionId} />}
        {route.page === "tools" && <Tools />}
        {route.page === "workflows" && <Workflows />}
        {route.page === "workflow-runs" && <WorkflowRuns runId={route.runId} />}
        {route.page === "workflow-analytics" && <WorkflowAnalytics />}
        {route.page === "sandboxes" && <Sandboxes />}
        {route.page === "resources" && <Resources />}
        {route.page === "memory" && <Memory />}
        {route.page === "config" && <Config section={route.section} />}
        {route.page === "help" && <Help />}
      </main>
      {activity && (
        <div className="autopilot-activity-strip" role="status">
          <span className="autopilot-activity-dot" />
          <span className="autopilot-activity-label">Agent working on:</span>
          <a href={`#/tasks/${activity.taskId}`} className="autopilot-activity-link">
            {activity.title}
          </a>
        </div>
      )}
      <footer className="app-footer">
        <span className="app-footer-brand">{BRAND.name}</span>
        <span className="app-footer-sep" />
        <a href={BRAND.docs} target="_blank" rel="noopener noreferrer">Docs</a>
        <a href={BRAND.github} target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href={BRAND.website} target="_blank" rel="noopener noreferrer">Website</a>
      </footer>
    </div>
  );
}
