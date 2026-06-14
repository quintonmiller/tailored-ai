/**
 * Built-in default dashboard widgets. Registered through the same registry a
 * plugin would use (no privileged built-in) and fully overridable: set
 * `dashboard.defaults: false` to drop them, or add a `dashboard.widgets` entry
 * with the same id to re-title / reorder / disable an individual one.
 *
 * These are deliberately generic — useful to any install — and read only from
 * endpoints that already exist. Personal, deployment-specific widgets belong in
 * `dashboard.widgets` (config), not here.
 */

import type { AgentConfig } from "../config.js";
import { type DashboardWidget, registerDashboardWidgetProvider } from "./index.js";

export function builtinDashboardWidgets(config: AgentConfig): DashboardWidget[] {
  if (config.dashboard?.defaults === false) return [];
  return [
    {
      id: "system-status",
      type: "status",
      title: "System status",
      span: 1,
      order: 10,
      options: { endpoint: "/api/health" },
    },
    {
      id: "needs-you",
      type: "tasks",
      title: "Needs you",
      span: 2,
      order: 20,
      options: {
        endpoint: "/api/project-tasks?status=blocked,in_review&limit=6",
        emptyText: "Nothing needs you right now.",
      },
    },
    {
      id: "recent-activity",
      type: "activity",
      title: "Recent agent activity",
      span: 1,
      order: 30,
      options: { endpoint: "/api/exploratory/runs?limit=6" },
    },
  ];
}

// Self-register on import (mirrors the embedding/provider factory built-ins).
registerDashboardWidgetProvider("builtin", builtinDashboardWidgets);
