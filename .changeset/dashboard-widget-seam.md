---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Add a dashboard widget seam so custom dashboards slot into the bundled UI
without forking it.

- Core: `DashboardWidget` contract, a widget-provider registry
  (`registerDashboardWidgetProvider`), `resolveDashboardWidgets(config)`, a
  `dashboard.widgets` / `dashboard.defaults` config block, and built-in default
  widgets (system status, needs-you, recent activity) registered like a plugin.
- Server: `GET /api/dashboard` returns the resolved widget specs.
- UI (bundled): a `Board` page (`#/board`) + a widget renderer registry with
  built-in `status`, `tasks`, `activity`, `metric`, `list`, `markdown`,
  `links`, and `iframe` renderers. Widgets are declarative specs (data, not
  React), so config or plugins can add widgets with no UI changes.
- Agent/author enablement: `validateDashboardWidget()` + `BUILTIN_WIDGET_TYPES`
  exports, `validateConfig` now warns on malformed `dashboard.widgets` (bad
  type/span, non-`/api/` endpoint, duplicate id), and a `dashboard-widget-author`
  example skill teaches an agent the whole authoring flow.

See docs/dashboard-widgets.md.
