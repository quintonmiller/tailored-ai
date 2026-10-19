import { type MouseEvent, useEffect, useRef } from "react";
import type { DashboardWidgetSpec } from "../api";
import { WorldPanel } from "./WorldPanel";
import { WidgetCard } from "./widgets";

/** A link to a task, or to the task list, as the Board's widgets write them. */
export function taskLink(href: string): { task: string } | { tasks: true } | undefined {
  if (href === "#/tasks") return { tasks: true };
  const m = /^#\/tasks\/([^/?#]+)$/.exec(href);
  return m ? { task: decodeURIComponent(m[1]) } : undefined;
}

/**
 * The dashboard, opened from the big screen in the lobby: every widget the
 * Board page has, one under another, drawn by the Board's own renderers. A
 * task in one opens its card here rather than the Tasks page, so nothing
 * leaves the world; the page the screen was on is scrolled to.
 */
export function WorldDashboard({
  widgets,
  focus,
  onTask,
  onTasks,
  onClose,
}: {
  widgets: DashboardWidgetSpec[];
  /** The widget the screen was showing when it was clicked. */
  focus?: string;
  onTask: (id: string) => void;
  onTasks: () => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const shown = widgets.length > 0;
  useEffect(() => {
    if (!focus || !shown) return;
    const scroll = () =>
      [...(body.current?.querySelectorAll<HTMLElement>("[data-widget-id]") ?? [])]
        .find((el) => el.dataset.widgetId === focus)
        ?.scrollIntoView?.({ block: "start" });
    scroll();
    // Again once the widgets above it have their data: until then they are short, and there may be nothing to scroll.
    const again = setTimeout(scroll, 700);
    return () => clearTimeout(again);
  }, [focus, shown]);
  // Links to tasks stay in the world: a task's card, or the task list, instead of the Tasks page.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest?.("a");
    const to = a ? taskLink(a.getAttribute("href") ?? "") : undefined;
    if (!to) return;
    e.preventDefault();
    if ("task" in to) onTask(to.task);
    else onTasks();
  };
  return (
    <WorldPanel
      kicker="Dashboard"
      title="On the big screen"
      className="world-dashboard-panel"
      onClose={onClose}
      footer={
        <a className="world-panel-link" href="#/board">
          Open the Board page
        </a>
      }
    >
      {shown ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: it only catches clicks on the links inside, which take keys themselves.
        <div className="world-dashboard" ref={body} onClick={onClick}>
          {widgets.map((w) => (
            <div key={w.id} data-widget-id={w.id}>
              <WidgetCard widget={w} />
            </div>
          ))}
        </div>
      ) : (
        <p className="world-panel-quiet">Looking…</p>
      )}
    </WorldPanel>
  );
}
