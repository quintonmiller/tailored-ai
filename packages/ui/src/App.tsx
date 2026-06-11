import { useEffect, useId, useRef, useState } from "react";
import { type AutopilotActivity, fetchAutopilotActivity, fetchHealth } from "./api";
import { BRAND } from "./brand";
import { ChatProvider } from "./components/ChatContext";
import { ChatDock } from "./components/ChatDock";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { ToastProvider } from "./components/Toast";
import { Agents } from "./pages/Agents";
import { Approvals } from "./pages/Approvals";
import { Chat } from "./pages/Chat";
import { Config } from "./pages/Config";
import { Dashboard } from "./pages/Dashboard";
import { Help } from "./pages/Help";
import Login from "./pages/Login";
import { Memory } from "./pages/Memory";
import { Projects } from "./pages/Projects";
import { Resources } from "./pages/Resources";
import { Sandboxes } from "./pages/Sandboxes";
import { Tasks } from "./pages/Tasks";
import { Tools } from "./pages/Tools";
import { WorkflowAnalytics } from "./pages/WorkflowAnalytics";
import { WorkflowRuns } from "./pages/WorkflowRuns";
import { Workflows } from "./pages/Workflows";
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
  | { page: "actions" }
  | { page: "approvals" }
  | { page: "help" }
  | { page: "login" };

// Pages reachable through each nav group — drives the "active" highlight on the
// group trigger so a deep link into e.g. Workflows still lights up "Build".
const BUILD_PAGES = new Set<Route["page"]>([
  "agents",
  "workflows",
  "workflow-runs",
  "workflow-analytics",
  "memory",
  "tools",
  "projects",
]);
const SYSTEM_PAGES = new Set<Route["page"]>(["config", "resources", "sandboxes", "approvals", "actions", "help"]);

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
    const params = new URLSearchParams(hash.split("?")[1] ?? "");
    const parts = hash.split("?")[0].split("/");
    const taskId = parts[2] || undefined;
    // `#/tasks/:id` is a live deep-link target (task detail) used across the
    // app, so it keeps rendering the task view. The bare `#/tasks` board is a
    // duplicate of Projects → Tasks, so redirect it to the canonical page.
    if (!taskId) {
      window.location.hash = "/projects";
      return { page: "projects" };
    }
    return {
      page: "tasks",
      taskId,
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
  if (hash.startsWith("/actions")) {
    return { page: "actions" };
  }
  if (hash.startsWith("/approvals")) {
    return { page: "approvals" };
  }
  if (hash.startsWith("/help")) {
    return { page: "help" };
  }
  if (hash.startsWith("/login")) {
    return { page: "login" };
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

  // Intercept 401 responses from any /api/* fetch → redirect to login
  useEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await originalFetch.apply(this, args);
      if (res.status === 401 && typeof args[0] === "string" && args[0].startsWith("/api/")) {
        window.location.hash = "/login";
        // Return a rejected promise so callers know the request failed
        return Promise.reject(new Error("Unauthorized"));
      }
      return res;
    };
    return () => {
      window.fetch = originalFetch;
    };
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
  // Login page renders without the app shell chrome
  if (route.page === "login") {
    return <Login />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <a href="#/" className="app-title">
          {BRAND.name}
        </a>
        <nav className="app-nav" aria-label="Primary">
          <a href="#/" className={`nav-link${route.page === "dashboard" ? " active" : ""}`}>
            Home
          </a>
          <a href="#/chat" className={`nav-link${route.page === "chat" ? " active" : ""}`}>
            Chat
          </a>
          <a
            href="#/projects"
            className={`nav-link${route.page === "projects" || route.page === "tasks" ? " active" : ""}`}
          >
            Tasks
          </a>
          <NavGroup label="Build" active={BUILD_PAGES.has(route.page)}>
            <a href="#/agents" className={`nav-menu-item${route.page === "agents" ? " active" : ""}`}>
              Agents
            </a>
            <a
              href="#/workflows"
              className={`nav-menu-item${route.page === "workflows" || route.page === "workflow-runs" || route.page === "workflow-analytics" ? " active" : ""}`}
            >
              Workflows
            </a>
            <a href="#/memory" className={`nav-menu-item${route.page === "memory" ? " active" : ""}`}>
              Memory
            </a>
            <a href="#/tools" className={`nav-menu-item${route.page === "tools" ? " active" : ""}`}>
              Tools
            </a>
            <a href="#/projects" className={`nav-menu-item${route.page === "projects" ? " active" : ""}`}>
              Projects
            </a>
          </NavGroup>
          <NavGroup label="System" active={SYSTEM_PAGES.has(route.page)}>
            <a href="#/config" className={`nav-menu-item${route.page === "config" ? " active" : ""}`}>
              Config
            </a>
            <a href="#/resources" className={`nav-menu-item${route.page === "resources" ? " active" : ""}`}>
              Resources
            </a>
            <a href="#/sandboxes" className={`nav-menu-item${route.page === "sandboxes" ? " active" : ""}`}>
              Sandboxes
            </a>
            <a
              href="#/approvals"
              className={`nav-menu-item${route.page === "approvals" || route.page === "actions" ? " active" : ""}`}
            >
              Approvals
            </a>
            <a href="#/help" className={`nav-menu-item${route.page === "help" ? " active" : ""}`}>
              Help
            </a>
          </NavGroup>
          <ProjectSwitcher />
          {connected !== null && (
            <span className="header-status" title={connected ? "Connected" : "Disconnected"}>
              <span className={`status-dot${connected ? "" : " error"}`} />
            </span>
          )}
          <button
            type="button"
            className="nav-logout"
            title="Log out"
            onClick={() => {
              fetch("/api/auth/logout", { method: "POST" }).then(() => {
                window.location.hash = "/login";
              });
            }}
          >
            Logout
          </button>
        </nav>
      </header>
      <main className="app-main">
        {route.page === "dashboard" && <Dashboard />}
        {route.page === "projects" && (
          <Projects projectId={route.projectId} tab={route.tab} taskId={route.taskId} docId={route.docId} />
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
        {route.page === "actions" && <Approvals initialTab="actions" />}
        {route.page === "approvals" && <Approvals initialTab="subscriptions" />}
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
        <a href={BRAND.docs} target="_blank" rel="noopener noreferrer">
          Docs
        </a>
        <a href={BRAND.github} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        <a href={BRAND.website} target="_blank" rel="noopener noreferrer">
          Website
        </a>
      </footer>
    </div>
  );
}

/**
 * Accessible nav disclosure. The trigger toggles a menu of links on click and
 * exposes `aria-expanded`; the menu also opens on hover for pointer users. The
 * menu closes on outside click, on Escape, and when focus leaves the group, so
 * it stays keyboard-reachable without trapping focus.
 */
function NavGroup({ label, active, children }: { label: string; active: boolean; children: React.ReactNode }) {
  // `open` drives the click/keyboard-controlled state (and aria-expanded).
  // Pointer users also get hover-to-open purely from CSS (`.nav-group:hover`),
  // so the wrapper carries no JS event handlers — that keeps it free of the
  // static-element-interaction a11y warning while staying keyboard-reachable.
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onFocusOut = () => {
      // Defer so document.activeElement reflects the new focus target.
      requestAnimationFrame(() => {
        if (ref.current && !ref.current.contains(document.activeElement)) setOpen(false);
      });
    };
    document.addEventListener("mousedown", onDocPointer);
    ref.current?.addEventListener("focusout", onFocusOut);
    const node = ref.current;
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      node?.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  return (
    <div className={`nav-group${open ? " is-open" : ""}`} ref={ref}>
      <button
        type="button"
        className={`nav-link nav-group-trigger${active ? " active" : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
        <span className="nav-group-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <div
        id={menuId}
        className="nav-menu"
        role="menu"
        onClick={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
