/**
 * Dashboard widget renderer registry + built-in renderers.
 *
 * The server sends declarative widget specs (`{ id, type, title, options }`);
 * this maps each `type` to a React component. Adding a new widget kind = add a
 * renderer here and key it in `widgetRenderers`. Widget specs themselves come
 * from config / plugins (see core's dashboard seam), so most customization
 * needs no code — only the renderer *types* live in the bundle.
 */

import { type ReactNode, useEffect, useState } from "react";
import { type DashboardWidgetSpec, fetchWidgetData } from "../api";
import { renderMarkdown } from "../lib/markdown.js";

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
      dangerouslySetInnerHTML={{ __html: renderMarkdown(raw) }}
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

// --- collections widget ----------------------------------------------------

interface CollectionItem {
  id: string;
  type: string;
  name: string;
  notes: string | null;
  rating: number | null;
  location: string | null;
  url: string | null;
  added_by: string;
  source: string | null;
}

interface CollectionStats {
  byType: Record<string, number>;
  total: number;
}

interface CollectionTab {
  key: string;
  label: string;
}

// Fallback only — used when neither `options.tabs` nor live stats supply types.
const DEFAULT_COLLECTION_TABS: CollectionTab[] = [
  { key: "restaurant", label: "Restaurants" },
  { key: "bar", label: "Bars" },
];

function humanizeType(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function CollectionsWidget({ widget }: WidgetProps) {
  const endpoint = opt(widget, "endpoint", "/api/collections");
  const statsEndpoint = opt(widget, "statsEndpoint", "/api/collections/stats");
  const defaultTab = opt(widget, "defaultTab", "");

  const [activeTab, setActiveTab] = useState(defaultTab);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [nonce, setNonce] = useState(0);

  // form state
  const [formName, setFormName] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formRating, setFormRating] = useState(0);
  const [formLocation, setFormLocation] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: statsData } = useWidgetData<CollectionStats>(statsEndpoint);
  const stats = statsData ?? { byType: {}, total: 0 };

  // Tabs come from config (`options.tabs`), else from the live type buckets,
  // else a small default — so the widget works for any collection type.
  const configuredTabs = opt(widget, "tabs", null) as CollectionTab[] | null;
  const derivedTabs: CollectionTab[] = Object.keys(stats.byType).map((k) => ({ key: k, label: humanizeType(k) }));
  const tabs = configuredTabs?.length ? configuredTabs : derivedTabs.length ? derivedTabs : DEFAULT_COLLECTION_TABS;
  const effectiveTab = activeTab || tabs[0]?.key || "restaurant";

  const searchParam = search ? `&search=${encodeURIComponent(search)}` : "";
  const { data, error, loading } = useWidgetData<{ items: CollectionItem[]; total: number }>(
    `${endpoint}?type=${effectiveTab}&limit=20${searchParam}&_=${nonce}`,
  );

  const items = data?.items ?? [];
  const statMap = stats.byType;

  const handleSubmit = async () => {
    if (!formName.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: effectiveTab,
          name: formName.trim(),
          notes: formNotes.trim() || undefined,
          rating: formRating > 0 ? formRating : undefined,
          location: formLocation.trim() || undefined,
          url: formUrl.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Failed to add");
      }
      setFormName("");
      setFormNotes("");
      setFormRating(0);
      setFormLocation("");
      setFormUrl("");
      setShowForm(false);
      setNonce((n) => n + 1);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderStars = (rating: number) => "⭐".repeat(rating) + (rating < 5 ? "☆".repeat(5 - rating) : "");

  return (
    <div className="widget-collections">
      <div className="widget-collections-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`widget-collections-tab ${tab.key === effectiveTab ? "is-active" : ""}`}
            onClick={() => {
              setActiveTab(tab.key);
              setSearch("");
              setShowForm(false);
            }}
          >
            {tab.label}
            {(statMap[tab.key] ?? 0) > 0 && <span className="widget-collections-badge">{statMap[tab.key]}</span>}
          </button>
        ))}
      </div>

      <div className="widget-collections-bar">
        <input
          type="search"
          className="widget-collections-search"
          placeholder={`Search ${tabs.find((t) => t.key === effectiveTab)?.label ?? effectiveTab}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="widget-collections-add-btn" onClick={() => setShowForm(!showForm)}>
          {showForm ? "✕" : "+"}
        </button>
      </div>

      {showForm && (
        <div className="widget-collections-form">
          <input
            type="text"
            placeholder="Name *"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="widget-collections-input"
          />
          <input
            type="text"
            placeholder="Notes"
            value={formNotes}
            onChange={(e) => setFormNotes(e.target.value)}
            className="widget-collections-input"
          />
          <select
            value={formRating}
            onChange={(e) => setFormRating(Number(e.target.value))}
            className="widget-collections-select"
          >
            <option value={0}>Rating (optional)</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {"⭐".repeat(n)}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Location"
            value={formLocation}
            onChange={(e) => setFormLocation(e.target.value)}
            className="widget-collections-input"
          />
          <input
            type="url"
            placeholder="URL"
            value={formUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            className="widget-collections-input"
          />
          {submitError && <p className="widget-collections-error">{submitError}</p>}
          <button
            type="button"
            className="widget-collections-submit"
            disabled={submitting || !formName.trim()}
            onClick={handleSubmit}
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      {loading ? (
        <WidgetState loading={true} error={null} />
      ) : error ? (
        <WidgetState loading={false} error={error} />
      ) : items.length === 0 ? (
        <p className="widget-empty">
          {search
            ? `No ${effectiveTab.replace(/_/g, " ")} matching "${search}".`
            : `No ${effectiveTab.replace(/_/g, " ")} yet. Ask TAI to add one or use the + button.`}
        </p>
      ) : (
        <ul className="widget-list">
          {items.map((item) => (
            <li key={item.id} className="widget-collections-row">
              <div className="widget-collections-row-head">
                {item.added_by === "tai" && (
                  <span
                    className="widget-collections-tai-badge"
                    title={item.source ? `Added from ${item.source}` : "Added by TAI"}
                  >
                    🤖
                  </span>
                )}
                <span className="widget-collections-name">{item.name}</span>
                {item.rating != null && <span className="widget-collections-stars">{renderStars(item.rating)}</span>}
              </div>
              <div className="widget-collections-row-meta">
                {item.location && <span className="widget-collections-location">📍 {item.location}</span>}
                {item.url && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="widget-collections-link"
                    title={item.url}
                  >
                    🔗
                  </a>
                )}
                {item.notes && <span className="widget-collections-notes">{item.notes}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
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
        <button type="button" className="widget-sessions-refresh" onClick={() => setNonce((n) => n + 1)}>
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

/** Agent-generated recommendations with source attribution.
 *
 * The `value` field carries a source prefix + optional JSON action payload:
 *
 *   source: email subject | {"actions":[{"type":"create_task","label":"Create task","payload":{...}}]}
 *
 * Supported action types:
 *   create_task     → POST /api/project-tasks
 *   add_collection  → POST /api/collections
 *   log             → writes a recommendation_response fact (no API needed)
 *
 * Every card with no explicit actions gets a default "Mark done" (log) button.
 * All actions + dismiss write a `recommendation_response` fact so the agent
 * can see what happened.
 */
interface RecAction {
  type: "create_task" | "add_collection" | "log";
  label: string;
  payload: Record<string, unknown>;
}

interface RecResult {
  source: string;
  actions: RecAction[];
}

const DEFAULT_DONE: RecAction = { type: "log", label: "Mark done", payload: { status: "done" } };

function parseRecActions(raw: string): RecResult {
  const m = raw.match(/\|\s*(\{"actions"\s*:\s*\[.+\]\})\s*$/);
  if (!m) return { source: raw, actions: [] };
  try {
    const wrapper = JSON.parse(m[1]) as { actions: RecAction[] };
    const source = raw.slice(0, m.index!).trim();
    return { source: source.length ? source : raw, actions: wrapper.actions ?? [] };
  } catch {
    return { source: raw, actions: [] };
  }
}

async function logRecResponse(factId: string, status: string, label?: string): Promise<boolean> {
  try {
    const res = await fetch("/api/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "recommendation_response",
        entity: factId,
        key: `${status}${label ? ` (${label})` : ""}`,
        value: new Date().toISOString(),
        project_id: "global",
      }),
    });
    return res.ok;
  } catch {
    // non-fatal — recommendation is still removed from view
    return true;
  }
}

async function dispatchRecAction(action: RecAction): Promise<boolean> {
  const { type, payload } = action;
  let url: string;
  let body: Record<string, unknown>;

  switch (type) {
    case "log":
      return true; // handled via logRecResponse only
    case "create_task":
      url = "/api/project-tasks";
      body = {
        title: payload.title,
        description: payload.description,
        tags: payload.tags,
        assignee: payload.assignee,
        rank: payload.rank,
      };
      break;
    case "add_collection":
      url = "/api/collections";
      body = {
        type: payload.type,
        name: payload.name,
        notes: payload.notes,
        rating: payload.rating,
        location: payload.location,
        url: payload.url,
      };
      break;
    default:
      return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function RecommendationsWidget({ widget }: WidgetProps) {
  const endpoint = opt(widget, "endpoint", "/api/facts?category=recommendation&limit=20");
  const { data, error, loading } = useWidgetData<{
    facts: Array<{ id: string; key: string; value: string; created_at: string | null }>;
  }>(endpoint, 60000);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<Record<string, string>>({});
  const [actionResults, setActionResults] = useState<Record<string, string>>({});

  const facts = (data?.facts ?? []).filter((f) => !dismissed.has(f.id));

  const removeCard = async (id: string) => {
    setDismissing(id);
    try {
      await fetch(`/api/facts/${encodeURIComponent(id)}`, { method: "DELETE" });
      setDismissed((prev) => new Set(prev).add(id));
    } catch {
      /* keep visible */
    } finally {
      setDismissing(null);
    }
  };

  const handleDismiss = async (factId: string) => {
    await logRecResponse(factId, "dismissed");
    await removeCard(factId);
  };

  const handleAction = async (factId: string, action: RecAction) => {
    setActing((prev) => ({ ...prev, [factId]: action.label }));
    const ok = await dispatchRecAction(action);
    if (ok) {
      await logRecResponse(factId, "acted", action.label);
      setActionResults((prev) => ({ ...prev, [factId]: `✓ ${action.label} — done` }));
      setTimeout(() => removeCard(factId), 1200);
    } else {
      setActionResults((prev) => ({ ...prev, [factId]: `✗ Failed` }));
      setActing((prev) => {
        const n = { ...prev };
        delete n[factId];
        return n;
      });
    }
  };

  if (error) return <WidgetState loading={false} error={error} />;
  if (loading) return <WidgetState loading={true} error={null} />;

  if (facts.length === 0) {
    return <p className="widget-empty">{opt(widget, "emptyText", "All clear — no recommendations right now.")}</p>;
  }

  return (
    <div className="widget-recommendations">
      {facts.map((f) => {
        const { source, actions } = parseRecActions(f.value ?? "");
        const result = actionResults[f.id];
        const activeLabel = acting[f.id];
        // if no explicit actions, default to "Mark done"
        const buttons: RecAction[] = actions.length > 0 ? actions : [DEFAULT_DONE];
        return (
          <div key={f.id} className={`widget-rec-card${result ? " widget-rec-done" : ""}`}>
            <p className="widget-rec-text">{f.key}</p>
            {source && !result && <p className="widget-rec-source">{source}</p>}
            {result && <p className="widget-rec-result">{result}</p>}
            <div className="widget-rec-meta">
              {f.created_at && !result && (
                <time className="widget-rec-time" dateTime={f.created_at}>
                  {new Date(f.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </time>
              )}
              {!result && (
                <div className="widget-rec-actions">
                  {buttons.map((btn, i) => (
                    <button
                      key={i}
                      type="button"
                      className="widget-rec-action-btn"
                      disabled={!!activeLabel}
                      onClick={() => handleAction(f.id, btn)}
                    >
                      {activeLabel === btn.label ? "…" : btn.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="widget-rec-dismiss"
                    disabled={dismissing === f.id}
                    onClick={() => handleDismiss(f.id)}
                    title="Dismiss"
                  >
                    {dismissing === f.id ? "…" : "✕"}
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* --- decisions widget ---------------------------------------------------- */
/** Agent-blocking questions surfaced as cards. User picks an option → decision_response fact.
 *
 *   value: source: ptask stuck | {"options":[{"label":"Archive","payload":{"decision":"archive"}},{"label":"Retry","payload":{"decision":"retry"}}]}
 */
interface DecisionOption {
  label: string;
  payload: Record<string, unknown>;
}

function parseDecisionValue(raw: string): { source: string; options: DecisionOption[] } {
  const m = raw.match(/\|\s*(\{"options"\s*:\s*\[.+\]\})\s*$/);
  if (!m) return { source: raw, options: [] };
  try {
    const wrapper = JSON.parse(m[1]) as { options: DecisionOption[] };
    const source = raw.slice(0, m.index!).trim();
    return { source: source.length ? source : raw, options: wrapper.options ?? [] };
  } catch {
    return { source: raw, options: [] };
  }
}

async function logDecisionResponse(factId: string, label: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "decision_response",
        entity: factId,
        key: label,
        value: JSON.stringify(payload),
        project_id: "global",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function DecisionsWidget({ widget }: WidgetProps) {
  const endpoint = opt(widget, "endpoint", "/api/facts?category=decision_needed&limit=20");
  const { data, error, loading } = useWidgetData<{
    facts: Array<{ id: string; key: string; value: string; created_at: string | null }>;
  }>(endpoint, 60000);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const facts = (data?.facts ?? []).filter((f) => !dismissed.has(f.id));

  const handleOption = async (factId: string, option: DecisionOption) => {
    setActing((prev) => ({ ...prev, [factId]: option.label }));
    const ok = await logDecisionResponse(factId, option.label, option.payload);
    if (ok) {
      setAnswers((prev) => ({ ...prev, [factId]: option.label }));
    }
    setActing((prev) => {
      const n = { ...prev };
      delete n[factId];
      return n;
    });
  };

  const dismiss = async (id: string) => {
    try {
      await fetch(`/api/facts/${encodeURIComponent(id)}`, { method: "DELETE" });
      setDismissed((prev) => new Set(prev).add(id));
    } catch {
      /* keep visible */
    }
  };

  if (error) return <WidgetState loading={false} error={error} />;
  if (loading) return <WidgetState loading={true} error={null} />;

  if (facts.length === 0) {
    return <p className="widget-empty">{opt(widget, "emptyText", "No decisions pending.")}</p>;
  }

  return (
    <div className="widget-decisions">
      {facts.map((f) => {
        const { source, options } = parseDecisionValue(f.value ?? "");
        const answer = answers[f.id];
        const activeLabel = acting[f.id];
        return (
          <div key={f.id} className={`widget-dec-card${answer ? " widget-dec-answered" : ""}`}>
            <p className="widget-dec-text">
              <span className="widget-dec-icon">?</span> {f.key}
            </p>
            {source && !answer && <p className="widget-dec-source">{source}</p>}
            {answer && <p className="widget-dec-answer">✓ {answer}</p>}
            {!answer && (
              <div className="widget-dec-options">
                {options.map((opt, i) => (
                  <button
                    key={i}
                    type="button"
                    className="widget-dec-btn"
                    disabled={!!activeLabel}
                    onClick={() => handleOption(f.id, opt)}
                  >
                    {activeLabel === opt.label ? "…" : opt.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="widget-dec-dismiss"
              disabled={false}
              onClick={() => dismiss(f.id)}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        );
      })}
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
  collections: CollectionsWidget,
  recommendations: RecommendationsWidget,
  decisions: DecisionsWidget,
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
