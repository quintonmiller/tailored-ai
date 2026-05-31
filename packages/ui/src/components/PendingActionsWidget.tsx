import { useCallback, useEffect, useState } from "react";
import { getRenderer } from "../actions/registry";

/**
 * Compact dashboard widget showing pending trusted actions.
 *
 * Fetches `GET /actions` from the trusted-actions executor and renders
 * pending items using the pluggable renderer registry.
 */

interface PendingAction {
  id: string;
  type: string;
  input: Record<string, unknown> | null;
  status: string;
  requested_by: string;
  requested_at: string;
}

function executorBase(): string {
  const fromEnv = (import.meta as { env?: Record<string, string> }).env?.VITE_TRUSTED_ACTIONS_URL;
  return fromEnv ?? "/ta";
}

async function fetchPendingActions(): Promise<PendingAction[]> {
  const res = await fetch(`${executorBase()}/actions?status=pending_approval&limit=10`);
  if (!res.ok) throw new Error(`Executor returned ${res.status}`);
  const body = (await res.json()) as { actions: PendingAction[] };
  return body.actions;
}

export function PendingActionsWidget() {
  const [actions, setActions] = useState<PendingAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [_reloadTick, setReloadTick] = useState(0);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetchPendingActions()
      .then((r) => {
        if (cancelled) return;
        setActions(r);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(reload, 30_000);
    return () => clearInterval(id);
  }, [reload]);

  if (error) {
    return (
      <div className="pending-actions-widget">
        <h3 className="widget-title">Pending Actions</h3>
        <p className="widget-error">{error}</p>
      </div>
    );
  }

  if (actions === null) {
    return (
      <div className="pending-actions-widget">
        <h3 className="widget-title">Pending Actions</h3>
        <p className="widget-loading">Loading…</p>
      </div>
    );
  }

  if (actions.length === 0) {
    return (
      <div className="pending-actions-widget">
        <h3 className="widget-title">Pending Actions</h3>
        <p className="widget-empty">No pending actions.</p>
      </div>
    );
  }

  return (
    <div className="pending-actions-widget">
      <h3 className="widget-title">Pending Actions ({actions.length})</h3>
      <ul className="widget-list">
        {actions.map((action) => {
          const Renderer = getRenderer(action.type);
          return (
            <li key={action.id} className="widget-item">
              {Renderer && action.input ? (
                <Renderer input={action.input} />
              ) : (
                <div className="widget-item-fallback">
                  <span className="widget-item-type">{action.type}</span>
                  <span className="widget-item-id">{action.id}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
