import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgents, fetchCron, fetchSessions, fetchTools, fetchWorkflows } from "../api";

/**
 * Client-side global command palette. Opened with Cmd-K / Ctrl-K anywhere
 * (except while typing in a field that isn't the palette's own input) or via
 * the top-bar search button. Sources are fetched lazily on first open with a
 * single Promise.all and cached for the session; results are a flat
 * case-insensitive substring match grouped by kind. Enter / click navigates by
 * setting location.hash. Esc or a backdrop click closes.
 */

type Kind = "page" | "agent" | "tool" | "session" | "workflow" | "cron" | "config";

interface Item {
  kind: Kind;
  title: string;
  sub?: string;
  href: string;
}

const KIND_LABEL: Record<Kind, string> = {
  page: "page",
  agent: "agent",
  tool: "tool",
  session: "session",
  workflow: "workflow",
  cron: "cron",
  config: "config",
};

// Static lists — these never change at runtime.
const NAV_PAGES: Item[] = [
  { kind: "page", title: "Home", href: "#/" },
  { kind: "page", title: "Chat", href: "#/chat" },
  { kind: "page", title: "Tasks", href: "#/projects" },
  { kind: "page", title: "Agents", href: "#/agents" },
  { kind: "page", title: "Projects", href: "#/projects" },
  { kind: "page", title: "Tools", href: "#/tools" },
  { kind: "page", title: "Workflows", href: "#/workflows" },
  { kind: "page", title: "Workflow runs", href: "#/workflow-runs" },
  { kind: "page", title: "Workflow analytics", href: "#/workflow-analytics" },
  { kind: "page", title: "Memory", href: "#/memory" },
  { kind: "page", title: "Resources", href: "#/resources" },
  { kind: "page", title: "Sandboxes", href: "#/sandboxes" },
  { kind: "page", title: "Approvals", href: "#/approvals" },
  { kind: "page", title: "Help", href: "#/help" },
];

const CONFIG_SECTIONS: Item[] = [
  { kind: "config", title: "Providers", sub: "config", href: "#/config/providers" },
  { kind: "config", title: "Discord", sub: "config", href: "#/config/discord" },
  { kind: "config", title: "Agents", sub: "config", href: "#/config/agents" },
  { kind: "config", title: "Autopilot", sub: "config", href: "#/config/autopilot" },
  { kind: "config", title: "Tools", sub: "config", href: "#/config/tools" },
  { kind: "config", title: "Cron", sub: "config", href: "#/config/cron" },
  { kind: "config", title: "Task Watcher", sub: "config", href: "#/config/task_watcher" },
  { kind: "config", title: "Custom Tools", sub: "config", href: "#/config/custom_tools" },
  { kind: "config", title: "Task Backend", sub: "config", href: "#/config/tasks" },
  { kind: "config", title: "Webhooks", sub: "config", href: "#/config/webhooks" },
  { kind: "config", title: "Commands", sub: "config", href: "#/config/commands" },
  { kind: "config", title: "Raw YAML", sub: "config", href: "#/config/yaml" },
];

const KIND_ORDER: Kind[] = ["page", "agent", "tool", "session", "workflow", "cron", "config"];
const MAX_VISIBLE = 12;

/** Lazily-fetched dynamic sources, cached for the session after the first open. */
async function loadDynamic(): Promise<Item[]> {
  const [agents, tools, sessions, workflows, cron] = await Promise.all([
    fetchAgents().catch(() => ({}) as Record<string, { description?: string }>),
    fetchTools().catch(() => []),
    fetchSessions().catch(() => []),
    fetchWorkflows().catch(() => ({ workflows: [], errors: [] })),
    fetchCron().catch(() => ({ enabled: false, jobs: [] })),
  ]);

  const items: Item[] = [];
  for (const [name, info] of Object.entries(agents)) {
    items.push({ kind: "agent", title: name, sub: info.description, href: `#/agents/${encodeURIComponent(name)}` });
  }
  for (const t of tools) {
    items.push({ kind: "tool", title: t.name, sub: t.description, href: "#/tools" });
  }
  for (const s of sessions.slice(0, 30)) {
    const title = s.title?.trim() || s.key || s.id.slice(0, 8);
    items.push({ kind: "session", title, sub: s.id.slice(0, 8), href: `#/chat?session=${encodeURIComponent(s.id)}` });
  }
  for (const w of workflows.workflows) {
    items.push({ kind: "workflow", title: w.name, sub: w.description, href: "#/workflows" });
  }
  for (const j of cron.jobs) {
    items.push({ kind: "cron", title: j.name, sub: j.schedule, href: "#/config/cron" });
  }
  return items;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [dynamic, setDynamic] = useState<Item[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cacheRef = useRef<Item[] | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  // Lazy-load dynamic sources the first time the palette opens.
  useEffect(() => {
    if (!open || cacheRef.current) return;
    loadDynamic().then((items) => {
      cacheRef.current = items;
      setDynamic(items);
    });
  }, [open]);

  // Global Cmd/Ctrl-K opens (and toggles) the palette. The listener ignores the
  // chord while the user is typing in another input/textarea/select or a
  // contenteditable — except the palette's own input, which is fine because the
  // palette is already open then.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const el = e.target as HTMLElement | null;
        const typingElsewhere =
          !open &&
          el &&
          (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) &&
          !el.closest(".command-palette");
        if (typingElsewhere) return;
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Let the top-bar search button (or anything) request the palette.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("tai:open-command-palette", onOpen);
    return () => window.removeEventListener("tai:open-command-palette", onOpen);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const all = useMemo<Item[]>(() => [...NAV_PAGES, ...(dynamic ?? []), ...CONFIG_SECTIONS], [dynamic]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? all.filter((it) => it.title.toLowerCase().includes(q) || (it.sub?.toLowerCase().includes(q) ?? false))
      : all;
    // Group by kind in a fixed order, capping the visible total.
    const byKind = new Map<Kind, Item[]>();
    for (const it of matched) {
      const arr = byKind.get(it.kind) ?? [];
      arr.push(it);
      byKind.set(it.kind, arr);
    }
    const ordered: Item[] = [];
    for (const kind of KIND_ORDER) {
      for (const it of byKind.get(kind) ?? []) {
        if (ordered.length >= MAX_VISIBLE) break;
        ordered.push(it);
      }
      if (ordered.length >= MAX_VISIBLE) break;
    }
    return ordered;
  }, [all, query]);

  // Keep the active index in range as the result set changes.
  useEffect(() => {
    setActive((i) => (i >= results.length ? 0 : i));
  }, [results.length]);

  const go = useCallback(
    (item: Item | undefined) => {
      if (!item) return;
      close();
      window.location.hash = item.href.replace(/^#/, "");
    },
    [close],
  );

  if (!open) return null;

  return (
    <div
      className="command-palette-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="command-palette-input"
          type="text"
          value={query}
          placeholder="type to search agents, tools, sessions…"
          aria-label="Search"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(results[active]);
            }
          }}
        />
        <ul className="command-palette-list">
          {results.length === 0 ? (
            <li className="command-palette-empty">No matches.</li>
          ) : (
            results.map((it, i) => {
              const prev = results[i - 1];
              const showHeader = !prev || prev.kind !== it.kind;
              return (
                <li key={`${it.kind}-${it.href}-${it.title}-${i}`}>
                  {showHeader && <div className="command-palette-group">{KIND_LABEL[it.kind]}</div>}
                  <button
                    type="button"
                    className={`command-palette-row${i === active ? " active" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(it)}
                  >
                    <span className="command-palette-kind">{KIND_LABEL[it.kind]}</span>
                    <span className="command-palette-title">{it.title}</span>
                    {it.sub && <span className="command-palette-sub">{it.sub}</span>}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
