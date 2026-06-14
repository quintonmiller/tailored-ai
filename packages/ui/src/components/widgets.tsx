/**
 * Dashboard widget renderer registry + built-in renderers.
 *
 * The server sends declarative widget specs (`{ id, type, title, options }`);
 * this maps each `type` to a React component. Adding a new widget kind = add a
 * renderer here and key it in `widgetRenderers`. Widget specs themselves come
 * from config / plugins (see core's dashboard seam), so most customization
 * needs no code — only the renderer *types* live in the bundle.
 */

import { marked } from "marked";
import { type ReactNode, useEffect, useState } from "react";
import { type DashboardWidgetSpec, fetchWidgetData } from "../api";

export interface WidgetProps {
  widget: DashboardWidgetSpec;
}
export type WidgetRenderer = (props: WidgetProps) => ReactNode;

// --- helpers ---------------------------------------------------------------

/** Read a dotted path (`usage.input`) out of an arbitrary object. */
function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function opt<T>(w: DashboardWidgetSpec, key: string, fallback: T): T {
  const v = w.options?.[key];
  return (v as T) ?? fallback;
}

/** Fetch + poll a widget's endpoint. Returns data, loading, and error state. */
function useWidgetData<T = unknown>(endpoint?: string, pollMs = 30000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!endpoint);

  useEffect(() => {
    if (!endpoint) return;
    let alive = true;
    const load = () => {
      fetchWidgetData<T>(endpoint)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError((e as Error).message))
        .finally(() => alive && setLoading(false));
    };
    load();
    const id = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [endpoint, pollMs]);

  return { data, error, loading };
}

/** Coerce common list shapes ({items}, {tasks}, {runs}, {hits}, or a raw array). */
function asArray(data: unknown, path?: string): unknown[] {
  const picked = path ? getPath(data, path) : data;
  if (Array.isArray(picked)) return picked;
  if (picked && typeof picked === "object") {
    for (const k of ["items", "tasks", "runs", "hits", "data", "notes"]) {
      const v = (picked as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function WidgetState({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <p className="widget-empty widget-error">Couldn't load — {error}</p>;
  if (loading) return <p className="widget-empty">Loading…</p>;
  return null;
}

// --- renderers -------------------------------------------------------------

/** System health: status dot + model/provider/uptime/tools. */
function StatusWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<Record<string, unknown>>(opt(widget, "endpoint", "/api/health"));
  const ok = !error && (data?.status === "ok" || data?.status === "healthy");
  const uptimeMin = typeof data?.uptime === "number" ? Math.round((data.uptime as number) / 60) : null;
  return (
    <div className="widget-status">
      <div className="widget-status-head">
        <span className={`widget-dot ${error ? "is-down" : ok ? "is-ok" : "is-warn"}`} />
        <strong>{error ? "Unreachable" : ok ? "Online" : "Starting…"}</strong>
      </div>
      {!error && data && (
        <dl className="widget-kv">
          {data.model != null && (
            <>
              <dt>Model</dt>
              <dd>{String(data.model)}</dd>
            </>
          )}
          {data.provider != null && (
            <>
              <dt>Provider</dt>
              <dd>{String(data.provider)}</dd>
            </>
          )}
          {uptimeMin != null && (
            <>
              <dt>Uptime</dt>
              <dd>{uptimeMin}m</dd>
            </>
          )}
          {data.tools != null && (
            <>
              <dt>Tools</dt>
              <dd>{String(data.tools)}</dd>
            </>
          )}
        </dl>
      )}
      {(loading || error) && <WidgetState loading={loading} error={error} />}
    </div>
  );
}

interface TaskRow {
  id?: string;
  title?: string;
  status?: string;
  assignee?: string | null;
}

/** Task list from a /api/project-tasks query. */
function TasksWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData(opt(widget, "endpoint", "/api/project-tasks?limit=6"));
  const rows = asArray(data, opt(widget, "itemsPath", "tasks")) as TaskRow[];
  if (loading || error) return <WidgetState loading={loading} error={error} />;
  if (rows.length === 0) return <p className="widget-empty">{opt(widget, "emptyText", "Nothing to show.")}</p>;
  return (
    <ul className="widget-list">
      {rows.map((t, i) => (
        <li key={t.id ?? i} className="widget-task">
          <a href={t.id ? `#/tasks/${t.id}` : "#/tasks"} className="widget-task-title">
            {t.title ?? t.id ?? "Untitled"}
          </a>
          <span className="widget-task-meta">
            {t.status && <span className={`widget-chip status-${t.status}`}>{t.status.replace(/_/g, " ")}</span>}
            {t.assignee && <span className="widget-assignee">@{t.assignee}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

interface RunRow {
  startedAt?: string;
  started_at?: string;
  created_at?: string;
  agent?: string;
  agentName?: string;
  outcome?: string;
  status?: string;
}

/** Recent agent runs (exploratory/autopilot). */
function ActivityWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData(opt(widget, "endpoint", "/api/exploratory/runs?limit=6"));
  const rows = asArray(data, opt(widget, "itemsPath", "runs")) as RunRow[];
  if (loading || error) return <WidgetState loading={loading} error={error} />;
  if (rows.length === 0) return <p className="widget-empty">No recent activity.</p>;
  return (
    <ul className="widget-list">
      {rows.map((r, i) => {
        const when = r.startedAt ?? r.started_at ?? r.created_at ?? "";
        const outcome = r.outcome ?? r.status ?? "";
        return (
          <li key={i} className="widget-run">
            <span className="widget-run-when">
              {when ? new Date(when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
            </span>
            <span className="widget-run-agent">{r.agent ?? r.agentName ?? "agent"}</span>
            {outcome && <span className={`widget-chip run-${outcome}`}>{outcome}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** A single big number pulled from an endpoint via `valuePath`. */
function MetricWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData(opt(widget, "endpoint", ""));
  if (loading || error) return <WidgetState loading={loading} error={error} />;
  const value = getPath(data, opt(widget, "valuePath", "")) ?? opt(widget, "value", "—");
  return (
    <div className="widget-metric">
      <span className="widget-metric-value">{String(value)}</span>
      {widget.options?.unit != null && <span className="widget-metric-unit">{String(widget.options.unit)}</span>}
      {widget.options?.label != null && <span className="widget-metric-label">{String(widget.options.label)}</span>}
    </div>
  );
}

/** Generic list from an endpoint, rendering `titleField`/`subtitleField`. */
function ListWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData(opt(widget, "endpoint", ""));
  const rows = asArray(data, opt(widget, "itemsPath", "")) as Record<string, unknown>[];
  if (loading || error) return <WidgetState loading={loading} error={error} />;
  if (rows.length === 0) return <p className="widget-empty">{opt(widget, "emptyText", "Empty.")}</p>;
  const titleField = opt(widget, "titleField", "title");
  const subField = opt(widget, "subtitleField", "");
  return (
    <ul className="widget-list">
      {rows.map((row, i) => (
        <li key={i} className="widget-list-row">
          <span className="widget-list-title">{String(getPath(row, titleField) ?? "—")}</span>
          {subField && <span className="widget-list-sub">{String(getPath(row, subField) ?? "")}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Static or endpoint-fed markdown. */
function MarkdownWidget({ widget }: WidgetProps) {
  const endpoint = opt(widget, "endpoint", "");
  const { data, error, loading } = useWidgetData<Record<string, unknown>>(endpoint || undefined);
  const raw = endpoint
    ? String(getPath(data, opt(widget, "contentField", "content")) ?? "")
    : opt(widget, "markdown", "");
  if (endpoint && (loading || error)) return <WidgetState loading={loading} error={error} />;
  return (
    <div
      className="widget-markdown"
      // marked output of trusted, config/endpoint-sourced content
      dangerouslySetInnerHTML={{ __html: marked.parse(raw) as string }}
    />
  );
}

interface LinkSpec {
  label: string;
  href: string;
  external?: boolean;
}

/** A list of quick links. */
function LinksWidget({ widget }: WidgetProps) {
  const links = opt<LinkSpec[]>(widget, "links", []);
  if (links.length === 0) return <p className="widget-empty">No links configured.</p>;
  return (
    <ul className="widget-links">
      {links.map((l, i) => (
        <li key={i}>
          <a href={l.href} target={l.external ? "_blank" : undefined} rel={l.external ? "noreferrer" : undefined}>
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Live clock: current time (updating every second) + today's date. No endpoint needed. */
function ClockWidget() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="widget-clock">
      <div className="widget-clock-time">{timeStr}</div>
      <div className="widget-clock-date">{dateStr}</div>
    </div>
  );
}

/** Escape hatch: embed an external URL. */
function IframeWidget({ widget }: WidgetProps) {
  const url = opt(widget, "url", "");
  if (!url) return <p className="widget-empty">No url configured.</p>;
  return (
    <iframe
      className="widget-iframe"
      src={url}
      title={widget.title ?? widget.id}
      style={{ height: opt(widget, "height", 240) }}
    />
  );
}

/** Interactive session explorer with client-side search and refresh. */
function SessionExplorerWidget({ widget }: WidgetProps) {
  const [nonce, setNonce] = useState(0);
  const [q, setQ] = useState("");

  const base = opt(widget, "endpoint", "/api/sessions?limit=25");
  const refreshSuffix = (base.includes("?") ? "&" : "?") + `_=${nonce}`;
  const { data, error, loading } = useWidgetData(base + refreshSuffix);
  const rows = asArray(data, opt(widget, "itemsPath", "")) as Record<string, unknown>[];

  const filtered = q
    ? rows.filter((r) => {
        const s = String(r.key ?? r.title ?? r.model ?? r.id ?? "").toLowerCase();
        return s.includes(q.toLowerCase());
      })
    : rows;

  if (loading || error) return <WidgetState loading={loading} error={error} />;

  return (
    <div>
      <div className="widget-sessions-bar">
        <input
          type="search"
          className="widget-sessions-search"
          placeholder="Filter sessions…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="widget-sessions-refresh" onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="widget-empty">{q ? "No sessions match." : "No sessions."}</p>
      ) : (
        <>
          <ul className="widget-list">
            {filtered.map((r, i) => {
              const id = r.id ?? i;
              const label = r.key ?? r.title ?? String(id);
              const model = r.model ?? "";
              const updated = r.updated_at ?? "";
              return (
                <li key={i} className="widget-list-row">
                  <a href={`#/sessions/${id}`} className="widget-list-title">
                    {String(label)}
                  </a>
                  <span className="widget-list-sub">
                    {model ? String(model) : ""}
                    {model && updated ? " · " : ""}
                    {updated ? new Date(String(updated)).toLocaleDateString() : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="widget-sessions-count">
            Showing {filtered.length} of {rows.length}
          </p>
        </>
      )}
    </div>
  );
}

export const widgetRenderers: Record<string, WidgetRenderer> = {
  status: StatusWidget,
  tasks: TasksWidget,
  activity: ActivityWidget,
  metric: MetricWidget,
  list: ListWidget,
  clock: ClockWidget,
  markdown: MarkdownWidget,
  links: LinksWidget,
  iframe: IframeWidget,
  "session-explorer": SessionExplorerWidget,
};

/** A widget card: chrome + the resolved renderer (or a graceful unknown-type fallback). */
export function WidgetCard({ widget }: WidgetProps) {
  const Renderer = widgetRenderers[widget.type];
  const span = Math.min(4, Math.max(1, widget.span ?? 1));
  return (
    <section className="widget-card" style={{ gridColumn: `span ${span}` }} data-widget-type={widget.type}>
      {widget.title && <h3 className="widget-title">{widget.title}</h3>}
      <div className="widget-body">
        {Renderer ? (
          <Renderer widget={widget} />
        ) : (
          <p className="widget-empty widget-error">Unknown widget type "{widget.type}".</p>
        )}
      </div>
    </section>
  );
}
