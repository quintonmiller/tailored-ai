---
name: dashboard-widget-author
description: Build a Board (dashboard) widget for the TAI web UI. Use when asked to add a widget, panel, card, or page to the dashboard, or to surface some data on the Board. Knows the declarative widget seam, the built-in renderer types, and how to verify a widget without guessing.
version: 0.1.0
allowed-tools:
  - read
  - write
  - exec
---

# Authoring a Board widget

The Board (`#/board`) renders **declarative widget specs** the server returns from
`GET /api/dashboard`. A widget is data — `{ id, type, title, span, order, options }` —
not React. Full reference: `docs/dashboard-widgets.md`.

## Step 1 — pick the path (this is the most important decision)

- **Config widget (NO code, prefer this).** If the data is already at a `/api/…`
  endpoint and one of the built-in renderer types fits, you only add a spec to
  `dashboard.widgets` in `config.yaml`. No rebuild, no UI change. **~90% of
  requests are this.**
- **New renderer type (code).** Only when no built-in type can display the data.
  You add one React component to the UI bundle and register it.

If unsure, start with a config widget using `list`/`tasks`/`metric`/`markdown`.

## Built-in renderer types

`status` · `metric` · `tasks` · `activity` · `list` · `markdown` · `links` · `iframe`
(canonical list: `BUILTIN_WIDGET_TYPES` in `@tailored-ai/core`). Common `options`:

- `tasks` / `activity` / `list`: `endpoint` (a `/api/…` path), `itemsPath`, `emptyText`,
  and for `list` also `titleField` / `subtitleField`.
- `metric`: `endpoint`, `valuePath`, `unit`, `label`.
- `markdown`: `markdown` (static) **or** `endpoint` + `contentField`.
- `links`: `links: [{ label, href, external? }]`.
- `iframe`: `url`, `height`. (The only way to show an external URL — `endpoint`
  must be same-origin `/api/…`.)

## Step 2a — config widget

Add an entry under `dashboard.widgets` in `config.yaml`:

```yaml
dashboard:
  widgets:
    - id: my-widget          # unique; reused id overrides a built-in/plugin widget
      type: tasks
      title: My widget
      span: 2                 # 1–4 columns
      order: 30              # lower = earlier
      options:
        endpoint: /api/project-tasks?status=in_review&limit=6
        emptyText: Nothing here.
```

Verify (no rebuild — config hot-reloads):
1. `node -e "const {validateDashboardWidget}=require('@tailored-ai/core'); console.log(validateDashboardWidget(SPEC))"` — must print `[]`. (Or just check startup: a bad spec logs a `dashboard.widgets:` warning.)
2. `curl -s localhost:3000/api/dashboard` — your widget id appears in `widgets`.
3. Open `#/board` (or note that it now renders).

## Step 2b — new renderer type

Edit **`packages/ui/src/components/widgets.tsx`**:

1. Add a component `({ widget }: WidgetProps) => ReactNode`. For endpoint-backed
   data use the existing `useWidgetData(endpoint)` hook and the `opt(widget, key, fallback)`
   helper — copy the closest existing renderer (`TasksWidget`, `MetricWidget`).
2. Register it: add `myType: MyWidget` to the `widgetRenderers` map.
3. Style it in `packages/ui/src/styles.css` under the `/* Board … */` block, reusing
   the design tokens (`var(--text-dim)`, `var(--border)`, `var(--radius)`, …) and the
   `.widget-*` classes already there.

Then add the canonical name to `BUILTIN_WIDGET_TYPES` in
`packages/core/src/dashboard/index.ts` so config validation recognizes it.

Verify: `pnpm --filter @tailored-ai/ui run build` (must pass) → add a config widget
of your new `type` → check the Board.

## Guardrails

- Keep widgets **declarative and data-driven**. No business logic in a renderer —
  if it needs server work, add/extend a `/api/…` endpoint and point `endpoint` at it.
- `options.endpoint` must be a same-origin `/api/…` path. External content → `iframe`.
- `span` is 1–4; the grid clamps. Give every widget a stable unique `id`.
- A config widget never needs a rebuild; a new renderer type does. Don't rebuild the
  UI for a config-only change.
- After any code change, run the relevant build and fix errors before finishing.
  Don't leave the UI bundle broken.

## When you're done

State which path you took, the widget `id`(s), and the one verification command you
ran that proves it works (validator `[]`, the `curl` line, or the UI build passing).
