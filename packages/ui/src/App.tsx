import { useEffect, useState } from "react";
import { fetchHealth } from "./api";
import { BRAND } from "./brand";
import { Chat } from "./pages/Chat";
import { Config } from "./pages/Config";
import { Dashboard } from "./pages/Dashboard";
import { Help } from "./pages/Help";
import { Projects } from "./pages/Projects";
import { Tasks } from "./pages/Tasks";
import { Tools } from "./pages/Tools";
import "./styles.css";

type Route =
  | { page: "dashboard" }
  | { page: "projects"; projectId?: string; tab?: "tasks" | "documents"; taskId?: string; docId?: string }
  | { page: "tasks"; taskId?: string; status?: string }
  | { page: "chat"; sessionKey?: string; sessionId?: string }
  | { page: "config"; section?: string }
  | { page: "tools" }
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
  if (hash.startsWith("/tools")) {
    return { page: "tools" };
  }
  if (hash.startsWith("/help")) {
    return { page: "help" };
  }
  return { page: "dashboard" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [connected, setConnected] = useState<boolean | null>(null);

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
          <a href="#/tools" className={route.page === "tools" ? "active" : ""}>
            Tools
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
        {route.page === "tasks" && <Tasks taskId={route.taskId} initialStatus={route.status} />}
        {route.page === "chat" && <Chat sessionKey={route.sessionKey} sessionId={route.sessionId} />}
        {route.page === "tools" && <Tools />}
        {route.page === "config" && <Config section={route.section} />}
        {route.page === "help" && <Help />}
      </main>
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
