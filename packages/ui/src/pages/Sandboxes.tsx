import { useEffect, useState } from "react";
import { type ActiveSandbox, fetchSandboxes, killSandbox } from "../api";

export function Sandboxes() {
  const [sandboxes, setSandboxes] = useState<ActiveSandbox[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [_reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchSandboxes()
        .then((res) => {
          if (!cancelled) {
            setSandboxes(res.sandboxes);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message);
        });
    }
    load();
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function handleKill(id: string) {
    if (
      !confirm(`Kill sandbox ${id}? This will force-cleanup and may leave the running agent loop without a sandbox.`)
    ) {
      return;
    }
    await killSandbox(id);
    setReloadTick((n) => n + 1);
  }

  return (
    <div className="tools-page">
      <div className="tools-header">
        <h2>Active sandboxes ({sandboxes.length})</h2>
      </div>
      {error && <div className="config-error">{error}</div>}
      {sandboxes.length === 0 && !error && (
        <div className="empty-state">No active sandboxes. They appear while an agent loop is running.</div>
      )}
      <div className="sandbox-grid">
        {sandboxes.map((s) => (
          <div key={s.id} className="sandbox-card">
            <div className="sandbox-card-header">
              <span className={`sandbox-kind sandbox-kind-${s.kind}`}>{s.kind}</span>
              <span className="sandbox-id">{s.id}</span>
              {s.kind !== "host" && (
                <button type="button" className="btn-danger" onClick={() => handleKill(s.id)}>
                  Kill
                </button>
              )}
            </div>
            <dl className="sandbox-meta">
              <dt>Agent</dt>
              <dd>{s.agentName ?? "(default)"}</dd>
              <dt>Session</dt>
              <dd>{s.sessionId ?? "—"}</dd>
              <dt>cwd</dt>
              <dd>{s.cwd}</dd>
              <dt>Started</dt>
              <dd>{new Date(s.startedAt).toLocaleString()}</dd>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
