/**
 * Board — the customizable widget dashboard. Fetches the resolved widget specs
 * from `/api/dashboard` and renders each through the widget renderer registry.
 * Layout and content are driven entirely by config / plugins, so this page
 * itself never changes when widgets are added.
 */

import { useEffect, useState } from "react";
import { type DashboardWidgetSpec, fetchDashboard } from "../api";
import { WidgetCard } from "../components/widgets";

export function Board() {
  const [widgets, setWidgets] = useState<DashboardWidgetSpec[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchDashboard()
        .then((d) => alive && (setWidgets(d.widgets ?? []), setError(null)))
        .catch((e) => alive && setError((e as Error).message));
    load();
    const id = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="board-page">
      <header className="board-header">
        <h1>Board</h1>
        <p className="board-sub">
          Your widgets. Configure them under <code>dashboard.widgets</code> in config, or have a plugin contribute them.
        </p>
      </header>
      {error && <p className="widget-empty widget-error">Couldn't load the board — {error}</p>}
      {!error && widgets === null && <p className="widget-empty">Loading board…</p>}
      {widgets !== null && widgets.length === 0 && (
        <p className="widget-empty">
          No widgets configured. Add entries under <code>dashboard.widgets</code> in config.yaml.
        </p>
      )}
      {widgets && widgets.length > 0 && (
        <div className="board-grid">
          {widgets.map((w) => (
            <WidgetCard key={w.id} widget={w} />
          ))}
        </div>
      )}
    </div>
  );
}
