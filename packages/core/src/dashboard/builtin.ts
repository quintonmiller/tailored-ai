/**
 * Built-in default dashboard widgets.
 */

import type { AgentConfig } from "../config.js";
import { type DashboardWidget, registerDashboardWidgetProvider } from "./index.js";

export function builtinDashboardWidgets(config: AgentConfig): DashboardWidget[] {
  if (config.dashboard?.defaults === false) return [];
  return [
    { id: "system-status", type: "status", title: "System status", span: 1, order: 10, options: { endpoint: "/api/health" } },
    { id: "live-clock", type: "clock", title: "Clock", span: 1, order: 5 },
    { id: "needs-you", type: "tasks", title: "Needs you", span: 2, order: 20, options: { endpoint: "/api/project-tasks?status=blocked,in_review&limit=6", emptyText: "Nothing needs you right now." } },
    { id: "recent-activity", type: "activity", title: "Recent agent activity", span: 1, order: 30, options: { endpoint: "/api/exploratory/runs?limit=6" } },
  ];
}

registerDashboardWidgetProvider("builtin", builtinDashboardWidgets);

