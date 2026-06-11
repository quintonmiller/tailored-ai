import { useCallback, useEffect, useState } from "react";

/**
 * Approvals — the single place to review things waiting on a human decision.
 *
 * Two tabs:
 *  - "Trusted actions": the fallback inbox for high-stakes operations
 *    (purchases, etc.) that the trusted-actions executor pushed for approval.
 *  - "Push subscriptions": devices that asked to receive approval push
 *    notifications; approve a device before it can be pushed to.
 *
 * Both `#/approvals` and the legacy `#/actions` route resolve here.
 */

type Tab = "actions" | "subscriptions";

export function Approvals({ initialTab }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "actions");

  return (
    <div className="page approvals-page">
      <div className="page-header">
        <h1>Approvals</h1>
        <p className="muted">Operations and devices waiting on your decision.</p>
      </div>

      <div className="tabs" role="tablist" aria-label="Approvals sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "actions"}
          className={`tab${tab === "actions" ? " active" : ""}`}
          onClick={() => setTab("actions")}
        >
          Trusted actions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "subscriptions"}
          className={`tab${tab === "subscriptions" ? " active" : ""}`}
          onClick={() => setTab("subscriptions")}
        >
          Push subscriptions
        </button>
      </div>

      {tab === "actions" ? <TrustedActionsPanel /> : <SubscriptionsPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trusted actions inbox (was the standalone Actions page).
//
// Reads from the executor's public /actions endpoint (NOT through TAI's
// /api/*). The executor is reachable on a separate path via the hosted-proxy
// (or localhost on LAN). In the standard flow the user taps Approve / Reject
// inside the push notification itself; this view is the fallback inbox for
// missed notifications plus a history of recent decisions.
// ---------------------------------------------------------------------------

interface TrustedActionRow {
  id: string;
  type: string;
  input: Record<string, unknown> | null;
  status: "pending_approval" | "approved" | "rejected" | "running" | "completed" | "failed" | "expired";
  requested_by: string;
  requested_at: string;
  decided_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

type ActionTab = "pending_approval" | "recent" | "all";

const ACTION_TAB_LABELS: Record<ActionTab, string> = {
  pending_approval: "Pending",
  recent: "Recent",
  all: "All",
};

function executorBase(): string {
  // Allow override via Vite env so dev can point at a remote executor.
  // Default: same origin → expects reverse proxy at /ta/ → executor.
  const fromEnv = (import.meta as { env?: Record<string, string> }).env?.VITE_TRUSTED_ACTIONS_URL;
  return fromEnv ?? "/ta";
}

async function fetchActions(status: string): Promise<TrustedActionRow[]> {
  const url =
    status === "recent"
      ? `${executorBase()}/actions?status=all&limit=50`
      : `${executorBase()}/actions?status=${encodeURIComponent(status)}&limit=50`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Executor returned ${res.status}`);
  const body = (await res.json()) as { actions: TrustedActionRow[] };
  return body.actions;
}

function TrustedActionsPanel() {
  const [tab, setTab] = useState<ActionTab>("pending_approval");
  const [rows, setRows] = useState<TrustedActionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [_reloadTick, setReloadTick] = useState(0);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchActions(tab === "recent" ? "recent" : tab)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [tab]);

  // Auto-refresh pending tab every 10s — covers the "I missed the push" case.
  useEffect(() => {
    if (tab !== "pending_approval") return;
    const id = setInterval(reload, 10_000);
    return () => clearInterval(id);
  }, [tab, reload]);

  return (
    <div className="actions-page">
      <p className="actions-blurb">
        High-stakes operations (purchases, etc.) requiring your approval. The executor runs in a separate process; TAI
        cannot approve on your behalf.
      </p>

      <div className="tabs">
        {(Object.keys(ACTION_TAB_LABELS) as ActionTab[]).map((t) => (
          <button key={t} type="button" className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {ACTION_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {error && <div className="actions-error">Error: {error}</div>}
      {!error && rows === null && <div className="actions-loading">Loading…</div>}
      {!error && rows !== null && rows.length === 0 && (
        <div className="actions-empty">
          {tab === "pending_approval"
            ? "Nothing pending. The agent will push here when it needs approval."
            : "No actions yet."}
        </div>
      )}
      {!error && rows !== null && rows.length > 0 && (
        <ul className="actions-list">
          {rows.map((row) => (
            <ActionCard key={row.id} row={row} onChange={reload} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ActionCard({ row, onChange }: { row: TrustedActionRow; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const isPending = row.status === "pending_approval";
  const input = (row.input ?? {}) as Record<string, unknown>;
  const url = typeof input.url === "string" ? input.url : undefined;
  const query = typeof input.query === "string" ? input.query : undefined;
  const maxPrice = typeof input.max_price === "number" ? input.max_price : undefined;
  const qty = typeof input.qty === "number" ? input.qty : 1;
  const why = typeof input.why === "string" ? input.why : undefined;

  return (
    <li className={`action-card status-${row.status}`}>
      <div className="action-card-head">
        <span className={`action-status-badge ${row.status}`}>{row.status}</span>
        <span className="action-type">{row.type}</span>
        <span className="action-id">{row.id}</span>
      </div>

      <div className="action-card-body">
        {url && (
          <div>
            <strong>URL:</strong>{" "}
            <a href={url} target="_blank" rel="noopener noreferrer">
              {url}
            </a>
          </div>
        )}
        {query && (
          <div>
            <strong>Query:</strong> {query}
          </div>
        )}
        {maxPrice !== undefined && (
          <div>
            <strong>Max price:</strong> ${maxPrice.toFixed(2)} × {qty}
          </div>
        )}
        {why && (
          <div>
            <strong>Why:</strong> {why}
          </div>
        )}
        <div className="action-meta">
          <span>by {row.requested_by}</span>
          <span>· {new Date(row.requested_at).toLocaleString()}</span>
        </div>
        {row.error && (
          <div className="action-error">
            <strong>Error:</strong> {row.error}
          </div>
        )}
        {row.result && (
          <details className="action-result">
            <summary>Result</summary>
            <pre>{JSON.stringify(row.result, null, 2)}</pre>
          </details>
        )}
        {localError && <div className="action-error">⚠ {localError}</div>}
      </div>

      {isPending && (
        <div className="action-card-actions">
          <p className="action-card-actions-hint">
            Use the push notification's Approve/Reject buttons for the canonical flow. These buttons are a fallback that
            requires the executor to have a token still active — they won't always work if the push has been opened
            already.
          </p>
          <p className="action-card-actions-hint">
            To approve from here, open the push notification on your phone and tap Approve. The push payload carries the
            one-time token; this UI doesn't see it.
          </p>
          <button
            type="button"
            className="action-cancel"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Cancel ${row.id}? This marks it rejected.`)) return;
              setBusy(true);
              setLocalError(null);
              try {
                // The executor exposes a public /actions/:id/cancel that marks
                // the action rejected without consuming a token. If not
                // implemented yet, this fails gracefully.
                const res = await fetch(`${executorBase()}/actions/${encodeURIComponent(row.id)}/cancel`, {
                  method: "POST",
                });
                if (!res.ok) throw new Error(`Cancel failed (${res.status})`);
                onChange();
              } catch (e) {
                setLocalError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Push subscriptions (was the standalone Approvals page).
// ---------------------------------------------------------------------------

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  status: "pending" | "active" | "rejected";
  userAgent: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface ListResponse {
  subscriptions: Subscription[];
}

const STATUS_ORDER: Record<Subscription["status"], number> = {
  pending: 0,
  active: 1,
  rejected: 2,
};

function shortUA(ua: string | null): string {
  if (!ua) return "(unknown device)";
  // Cheap heuristics — good enough to recognize a phone in a list.
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isChrome = /Chrome\/|CriOS/.test(ua);
  const isSafari = /Safari/.test(ua) && !isChrome;
  const isFirefox = /Firefox\/|FxiOS/.test(ua);
  const platform = isIOS ? "iOS" : isAndroid ? "Android" : "Desktop";
  const browser = isFirefox ? "Firefox" : isChrome ? "Chrome" : isSafari ? "Safari" : "Browser";
  return `${platform} · ${browser}`;
}

function shortEndpoint(endpoint: string): string {
  // Push services issue 100+ char tokens — keep the tail (most distinguishing)
  // plus an indicator of which service.
  let host = "";
  try {
    host = new URL(endpoint).host;
  } catch {
    /* ignore */
  }
  const provider = host.includes("apple")
    ? "Apple"
    : host.includes("googleapis")
      ? "FCM"
      : host.includes("mozilla")
        ? "Mozilla"
        : host || "?";
  return `${provider} …${endpoint.slice(-12)}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function SubscriptionsPanel() {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [pendingOp, setPendingOp] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/trusted-actions/subscriptions");
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
      }
      const j = (await r.json()) as ListResponse;
      const sorted = [...j.subscriptions].sort((a, b) => {
        const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (so !== 0) return so;
        return b.createdAt.localeCompare(a.createdAt);
      });
      setSubs(sorted);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function decide(endpoint: string, op: "approve" | "reject" | "delete") {
    setPendingOp(`${endpoint}/${op}`);
    try {
      const r = await fetch(`/api/trusted-actions/subscriptions/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      if (!r.ok) {
        const body = await r.text();
        setErr(`Failed: HTTP ${r.status}: ${body.slice(0, 200)}`);
      } else {
        await refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingOp(null);
    }
  }

  const visible = (subs ?? []).filter((s) => showRejected || s.status !== "rejected");
  const pendingCount = (subs ?? []).filter((s) => s.status === "pending").length;
  const activeCount = (subs ?? []).filter((s) => s.status === "active").length;
  const rejectedCount = (subs ?? []).filter((s) => s.status === "rejected").length;

  return (
    <div className="subscriptions-panel">
      <p className="muted">
        Push subscriptions for the trusted-actions executor. Devices arrive in <code>pending</code>; approve them to
        start receiving approval push notifications. Rejected devices are kept for audit and never receive pushes.
      </p>

      <div className="subscriptions-toolbar">
        <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={pendingOp !== null}>
          Refresh
        </button>
        <span className="muted">
          <strong>{pendingCount}</strong> pending · <strong>{activeCount}</strong> active ·{" "}
          <strong>{rejectedCount}</strong> rejected
        </span>
        <label className="subscriptions-toggle">
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
          Show rejected history
        </label>
      </div>

      {err && <div className="error-banner">{err}</div>}

      {subs === null && !err && <p className="muted">Loading…</p>}

      {subs !== null && visible.length === 0 && (
        <p className="muted">
          {subs.length === 0
            ? "No subscriptions yet. Open the PWA on a device and tap Enable approvals."
            : "No subscriptions to show. Try the 'Show rejected history' toggle."}
        </p>
      )}

      {visible.length > 0 && (
        <table className="approvals-table">
          <thead>
            <tr>
              <th align="left">Device</th>
              <th align="left">Endpoint</th>
              <th align="left">Subscribed</th>
              <th align="left">Decided</th>
              <th align="left">Status</th>
              <th align="left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.endpoint}>
                <td>{shortUA(s.userAgent)}</td>
                <td>
                  <code>{shortEndpoint(s.endpoint)}</code>
                </td>
                <td>{formatTime(s.createdAt)}</td>
                <td>{formatTime(s.decidedAt)}</td>
                <td>
                  <span className={`badge badge-${s.status}`}>{s.status}</span>
                </td>
                <td>
                  {s.status === "pending" && (
                    <>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void decide(s.endpoint, "approve")}
                        disabled={pendingOp !== null}
                      >
                        Approve
                      </button>{" "}
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => void decide(s.endpoint, "reject")}
                        disabled={pendingOp !== null}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {s.status === "active" && (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void decide(s.endpoint, "reject")}
                      disabled={pendingOp !== null}
                    >
                      Revoke
                    </button>
                  )}
                  {s.status === "rejected" && (
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        if (confirm("Permanently delete this rejected subscription?")) {
                          void decide(s.endpoint, "delete");
                        }
                      }}
                      disabled={pendingOp !== null}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
