import { useCallback, useEffect, useState } from "react";

/**
 * Pending trusted-actions view.
 *
 * Reads from the executor's public /actions endpoint (NOT through TAI's
 * /api/*). The executor is reachable on a separate path via the hosted-
 * proxy (or localhost on LAN). Tapping Approve / Reject hits the
 * executor's /approve/:token / /reject/:token endpoints — but in the
 * standard flow the user taps the buttons inside the push notification
 * itself; this view is the fallback inbox for missed notifications +
 * a history of recent decisions.
 */

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

type Tab = "pending_approval" | "recent" | "all";

const TAB_LABELS: Record<Tab, string> = {
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

export function Actions() {
  const [tab, setTab] = useState<Tab>("pending_approval");
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

  // Auto-refresh pending tab every 10s — covers the "I missed the push" case
  useEffect(() => {
    if (tab !== "pending_approval") return;
    const id = setInterval(reload, 10_000);
    return () => clearInterval(id);
  }, [tab, reload]);

  return (
    <div className="actions-page">
      <div className="actions-header">
        <h2>Trusted actions</h2>
        <p className="actions-blurb">
          High-stakes operations (purchases, etc.) requiring your approval. The executor runs in a separate process; TAI
          cannot approve on your behalf.
        </p>
      </div>

      <div className="tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button key={t} type="button" className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
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
                // The executor exposes a public /actions/:id/cancel that
                // marks the action rejected without consuming a token. If
                // not implemented yet, this fails gracefully.
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
