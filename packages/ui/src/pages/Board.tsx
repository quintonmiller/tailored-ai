/**
 * Board — the customizable widget dashboard. Fetches the resolved widget specs
 * from `/api/dashboard` and renders each through the widget renderer registry.
 *
 * An iOS-Widgets-style **edit mode** lets you drag to reorder and drag a corner
 * handle to resize (span 1–4 columns); the layout persists to `dashboard.widgets`
 * via `POST /api/dashboard/layout`. Content is still driven by config/plugins —
 * this page only arranges it.
 */

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { type DashboardWidgetSpec, fetchDashboard, saveDashboardLayout } from "../api";
import { WidgetCard } from "../components/widgets";

const clampSpan = (s: number | undefined) => Math.min(4, Math.max(1, Math.round(s ?? 1)));
const clampRow = (s: number | undefined) => Math.min(6, Math.max(1, Math.round(s ?? 2)));

export function Board() {
  const [widgets, setWidgets] = useState<DashboardWidgetSpec[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);
  const resizingRef = useRef(false);

  // Fetch + poll. Polling pauses while editing, and a refresh is skipped mid
  // drag/resize so it can't clobber an in-progress gesture.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchDashboard()
        .then((d) => {
          if (alive && !resizingRef.current && dragFrom.current === null) {
            setWidgets(d.widgets ?? []);
            setError(null);
          }
        })
        .catch((e) => {
          if (alive) setError((e as Error).message);
        });
    load();
    const id = setInterval(() => {
      if (!editing) load();
    }, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [editing]);

  const persist = (list: DashboardWidgetSpec[]) => {
    setSaving(true);
    saveDashboardLayout(
      list.map((w) => ({ id: w.id, type: w.type, span: clampSpan(w.span), rowSpan: clampRow(w.rowSpan) })),
    )
      .then((d) => setWidgets(d.widgets ?? list))
      .catch((e) => setError((e as Error).message))
      .finally(() => setSaving(false));
  };

  // --- reorder (HTML5 drag) ---
  const onDragStart = (i: number) => {
    if (resizingRef.current) return;
    dragFrom.current = i;
  };
  const onDragEnter = (i: number) => {
    const from = dragFrom.current;
    if (from === null || from === i) return;
    setWidgets((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(i, 0, moved);
      return next;
    });
    dragFrom.current = i;
  };
  const onDragEnd = () => {
    dragFrom.current = null;
    setWidgets((prev) => {
      if (prev) persist(prev);
      return prev;
    });
  };

  // --- resize (pointer drag on a corner handle) ---
  const startResize = (i: number, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    if (!grid) return;
    resizingRef.current = true;
    const gs = getComputedStyle(grid);
    const cols = Math.max(1, gs.gridTemplateColumns.split(" ").filter(Boolean).length);
    const colUnit = grid.clientWidth / cols; // approx column+gap width
    const rowUnit = (Number.parseFloat(gs.gridAutoRows) || 110) + (Number.parseFloat(gs.rowGap) || 16);
    const startX = e.clientX;
    const startY = e.clientY;
    let startSpan = 1;
    let startRow = 2;
    setWidgets((prev) => {
      if (prev) {
        startSpan = clampSpan(prev[i]?.span);
        startRow = clampRow(prev[i]?.rowSpan);
      }
      return prev;
    });
    const move = (ev: PointerEvent) => {
      const span = Math.min(cols, Math.max(1, startSpan + Math.round((ev.clientX - startX) / colUnit)));
      const rowSpan = Math.min(6, Math.max(1, startRow + Math.round((ev.clientY - startY) / rowUnit)));
      setWidgets((prev) => prev?.map((w, j) => (j === i ? { ...w, span, rowSpan } : w)) ?? prev);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      resizingRef.current = false;
      setWidgets((prev) => {
        if (prev) persist(prev);
        return prev;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="board-page">
      <header className="board-header board-header-row">
        <div>
          <h1>Board</h1>
          <p className="board-sub">
            {editing ? (
              "Drag a card to reorder · drag its bottom-right corner to resize · Done to save."
            ) : (
              <>
                Your widgets. Configure them under <code>dashboard.widgets</code>, or edit the layout here.
              </>
            )}
          </p>
        </div>
        {widgets && widgets.length > 0 && (
          <button
            type="button"
            className={`board-edit-btn ${editing ? "is-active" : ""}`}
            onClick={() => setEditing((v) => !v)}
            disabled={saving && editing}
          >
            {editing ? (saving ? "Saving…" : "Done") : "Edit Layout"}
          </button>
        )}
      </header>

      {error && <p className="widget-empty widget-error">Couldn't load the board — {error}</p>}
      {!error && widgets === null && <p className="widget-empty">Loading board…</p>}
      {widgets !== null && widgets.length === 0 && (
        <p className="widget-empty">
          No widgets configured. Add entries under <code>dashboard.widgets</code> in config.yaml.
        </p>
      )}

      {widgets && widgets.length > 0 && (
        <div ref={gridRef} className={`board-grid ${editing ? "is-editing" : ""}`}>
          {widgets.map((w, i) => (
            <div
              key={w.id}
              className="board-cell"
              style={{ gridColumn: `span ${clampSpan(w.span)}`, gridRow: `span ${clampRow(w.rowSpan)}` }}
              draggable={editing}
              onDragStart={() => onDragStart(i)}
              onDragEnter={() => onDragEnter(i)}
              onDragOver={(e) => editing && e.preventDefault()}
              onDragEnd={onDragEnd}
            >
              <WidgetCard widget={w} />
              {editing && (
                <button
                  type="button"
                  className="board-resize"
                  aria-label={`Resize ${w.title ?? w.id}`}
                  title="Drag to resize"
                  draggable={false}
                  onPointerDown={(e) => startResize(i, e)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
