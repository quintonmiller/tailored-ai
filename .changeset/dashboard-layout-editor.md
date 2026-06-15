---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Board layout editing. `DashboardWidget` gains a `rowSpan` (height, 1–6 grid rows;
`span` stays width 1–4), both validated by `validateDashboardWidget`. New
`POST /api/dashboard/layout` persists a drag-reordered / resized layout: the body
is the widgets in display order with their `span` + `rowSpan`, and the route
rewrites `dashboard.widgets` (order = position, span/rowSpan clamped) and reloads.
Config widgets keep their full spec; built-in/provider widgets get a minimal
`{id, type, order, span, rowSpan}` override so the resolver merge preserves their
core-owned title/options.
