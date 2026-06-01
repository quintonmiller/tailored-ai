import { useCallback, useEffect, useState } from "react";

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
  // Push services issue 100+ char tokens — keep the tail (most
  // distinguishing) plus an indicator of which service.
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

export function Approvals() {
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
    <div className="page">
      <div className="page-header">
        <h1>Approvals</h1>
        <p className="muted">
          Push subscriptions for the trusted-actions executor. Devices arrive in <code>pending</code>; approve them to
          start receiving approval push notifications. Rejected devices are kept for audit and never receive pushes.
        </p>
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void refresh()} disabled={pendingOp !== null}>
          Refresh
        </button>
        <span className="muted">
          <strong>{pendingCount}</strong> pending · <strong>{activeCount}</strong> active ·{" "}
          <strong>{rejectedCount}</strong> rejected
        </span>
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
          Show rejected history
        </label>
      </div>

      {err && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {err}
        </div>
      )}

      {subs === null && !err && <p className="muted">Loading…</p>}

      {subs !== null && visible.length === 0 && (
        <p className="muted">
          {subs.length === 0
            ? "No subscriptions yet. Open the PWA on a device and tap Enable approvals."
            : "No subscriptions to show. Try the 'Show rejected history' toggle."}
        </p>
      )}

      {visible.length > 0 && (
        <table className="approvals-table" style={{ width: "100%", borderCollapse: "collapse" }}>
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
              <tr key={s.endpoint} style={{ borderTop: "1px solid var(--border, #2a2f3d)" }}>
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
                        onClick={() => void decide(s.endpoint, "approve")}
                        disabled={pendingOp !== null}
                      >
                        Approve
                      </button>{" "}
                      <button
                        type="button"
                        className="ghost"
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
                      className="ghost"
                      onClick={() => void decide(s.endpoint, "reject")}
                      disabled={pendingOp !== null}
                    >
                      Revoke
                    </button>
                  )}
                  {s.status === "rejected" && (
                    <button
                      type="button"
                      className="ghost"
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
