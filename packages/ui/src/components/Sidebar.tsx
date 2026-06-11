import { useEffect, useState } from "react";
import {
  type AgentInfo,
  fetchActivity,
  fetchAgents,
  fetchProjects,
  fetchTools,
  type ProjectWithCounts,
  type SessionActivity,
} from "../api";
import { BRAND } from "../brand";

/**
 * Persistent app-wide left navigation. Replaces the old top nav as primary
 * navigation: brand → primary pages → expandable inventory folders (Agents,
 * Projects, Tools) → flat links for the remaining surfaces. Every route the old
 * top nav reached (including the Build/System dropdown items) is reachable here.
 *
 * Folder expand/collapse state persists in localStorage. Live agent status is
 * derived from a single fetchActivity() poll shared with the rest of the shell.
 */

type PageKey =
  | "dashboard"
  | "agents"
  | "projects"
  | "tasks"
  | "chat"
  | "config"
  | "tools"
  | "workflows"
  | "workflow-runs"
  | "workflow-analytics"
  | "sandboxes"
  | "resources"
  | "memory"
  | "actions"
  | "approvals"
  | "help"
  | "login";

const FOLDER_KEY = "tai.sidebar.folders";
const AGENTS_PREVIEW = 5;
const PROJECTS_PREVIEW = 5;
const ACTIVITY_POLL_MS = 10000;

type FolderState = { agents: boolean; projects: boolean; tools: boolean };
const DEFAULT_FOLDERS: FolderState = { agents: true, projects: false, tools: false };

function loadFolders(): FolderState {
  try {
    const raw = localStorage.getItem(FOLDER_KEY);
    if (!raw) return DEFAULT_FOLDERS;
    return { ...DEFAULT_FOLDERS, ...(JSON.parse(raw) as Partial<FolderState>) };
  } catch {
    return DEFAULT_FOLDERS;
  }
}

function saveFolders(state: FolderState) {
  try {
    localStorage.setItem(FOLDER_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — ignore.
  }
}

export function Sidebar({ page, onNavigate }: { page: PageKey; onNavigate?: () => void }) {
  const [agents, setAgents] = useState<Array<[string, AgentInfo]>>([]);
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [folders, setFolders] = useState<FolderState>(loadFolders);

  // Inventory: fetched once. Cheap and rarely changes during a session.
  useEffect(() => {
    fetchAgents()
      .then((all) => setAgents(Object.entries(all)))
      .catch(() => {});
    fetchProjects({ status: "active", limit: 50 })
      .then((r) => setProjects(r.projects))
      .catch(() => {});
    fetchTools()
      .then((t) => setToolCount(t.length))
      .catch(() => {});
  }, []);

  // Live agent status — single poll, torn down on unmount.
  useEffect(() => {
    const tick = () => {
      fetchActivity()
        .then(setActivity)
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, ACTIVITY_POLL_MS);
    return () => clearInterval(id);
  }, []);

  const toggle = (key: keyof FolderState) =>
    setFolders((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveFolders(next);
      return next;
    });

  // An agent is "running" if any in-flight session reports it as active.
  const runningAgents = new Set(
    activity.filter((a) => a.agentName && a.status === "running").map((a) => a.agentName as string),
  );

  const agentPreview = agents.slice(0, AGENTS_PREVIEW);
  const projectPreview = projects.slice(0, PROJECTS_PREVIEW);

  return (
    <nav className="sidebar" aria-label="Primary">
      {/* Route changes close the off-canvas drawer (handled in App), so the
          brand link needs no onClick — keeping it a plain navigation anchor. */}
      <a href="#/" className="sidebar-brand">
        {BRAND.name}
      </a>

      <div className="sidebar-section">
        <SideLink href="#/" label="Home" active={page === "dashboard"} onNavigate={onNavigate} />
        <SideLink href="#/chat" label="Chat" active={page === "chat"} onNavigate={onNavigate} />
        <SideLink
          href="#/projects"
          label="Tasks"
          active={page === "projects" || page === "tasks"}
          onNavigate={onNavigate}
        />
      </div>

      <div className="sidebar-section">
        {/* Agents folder — expanded by default, live status dots. */}
        <Folder
          label="Agents"
          open={folders.agents}
          onToggle={() => toggle("agents")}
          count={agents.length}
          allHref="#/agents"
          allLabel={`all ${agents.length} →`}
          onNavigate={onNavigate}
        >
          {agentPreview.map(([name]) => {
            const running = runningAgents.has(name);
            return (
              <a
                key={name}
                href={`#/agents/${encodeURIComponent(name)}`}
                className="sidebar-item sidebar-item-nested"
                onClick={onNavigate}
              >
                <span
                  className={`sidebar-dot${running ? " sidebar-dot-on" : ""}`}
                  aria-hidden="true"
                  title={running ? "running" : "idle"}
                >
                  {running ? "●" : "○"}
                </span>
                <span className="sidebar-item-text">{name}</span>
              </a>
            );
          })}
        </Folder>

        {/* Projects folder — collapsed by default, open-task counts when cheap. */}
        <Folder
          label="Projects"
          open={folders.projects}
          onToggle={() => toggle("projects")}
          count={projects.length}
          allHref="#/projects"
          allLabel={`all ${projects.length} →`}
          onNavigate={onNavigate}
        >
          {projectPreview.map((p) => (
            <a
              key={p.id}
              href={`#/projects/${encodeURIComponent(p.id)}`}
              className="sidebar-item sidebar-item-nested"
              onClick={onNavigate}
            >
              <span className="sidebar-item-text">{p.title}</span>
              {p.task_count > 0 && <span className="sidebar-item-badge">{p.task_count}</span>}
            </a>
          ))}
        </Folder>

        {/* Tools folder — collapsed; just the count link, never the full list. */}
        <Folder
          label="Tools"
          open={folders.tools}
          onToggle={() => toggle("tools")}
          count={toolCount ?? undefined}
          allHref="#/tools"
          allLabel={`${toolCount ?? 0} tools →`}
          onNavigate={onNavigate}
        />
      </div>

      <div className="sidebar-section">
        <SideLink
          href="#/workflows"
          label="Workflows"
          active={page === "workflows" || page === "workflow-runs" || page === "workflow-analytics"}
          onNavigate={onNavigate}
        />
        <SideLink href="#/memory" label="Memory" active={page === "memory"} onNavigate={onNavigate} />
        <SideLink href="#/resources" label="Resources" active={page === "resources"} onNavigate={onNavigate} />
        <SideLink href="#/sandboxes" label="Sandboxes" active={page === "sandboxes"} onNavigate={onNavigate} />
        <SideLink
          href="#/approvals"
          label="Approvals"
          active={page === "approvals" || page === "actions"}
          onNavigate={onNavigate}
        />
      </div>

      <div className="sidebar-section sidebar-section-foot">
        <SideLink href="#/config" label="Config" active={page === "config"} onNavigate={onNavigate} />
        <SideLink href="#/help" label="Help" active={page === "help"} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

function SideLink({
  href,
  label,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <a href={href} className={`sidebar-item${active ? " active" : ""}`} onClick={onNavigate}>
      <span className="sidebar-item-text">{label}</span>
    </a>
  );
}

function Folder({
  label,
  open,
  onToggle,
  count,
  allHref,
  allLabel,
  children,
  onNavigate,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  allHref: string;
  allLabel: string;
  children?: React.ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <div className={`sidebar-folder${open ? " is-open" : ""}`}>
      <button type="button" className="sidebar-folder-head" aria-expanded={open} onClick={onToggle}>
        <span className="sidebar-folder-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="sidebar-folder-label">{label}</span>
        {count !== undefined && <span className="sidebar-folder-count">{count}</span>}
      </button>
      {open && (
        <div className="sidebar-folder-body">
          {children}
          <a href={allHref} className="sidebar-item sidebar-item-nested sidebar-item-all" onClick={onNavigate}>
            {allLabel}
          </a>
        </div>
      )}
    </div>
  );
}
