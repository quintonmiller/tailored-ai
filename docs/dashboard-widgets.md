# Dashboard widgets

The **Board** page (`#/board` in the bundled UI) is a customizable dashboard
assembled from declarative *widget specs*. This is the seam that lets a custom
dashboard "slot into the real dashboard" without forking the UI.

## Why declarative specs (not plugin React)

The UI is a pre-built SPA. Shipping arbitrary React from a server-side plugin
into that bundle would need module federation, dynamic remotes, and a security
model for third-party code. Instead, a widget is **data**:

```ts
interface DashboardWidget {
  id: string;            // unique; config entries override by id
  type: string;          // selects a renderer: status | metric | tasks | list | markdown | links | iframe
  title?: string;
  span?: number;         // 1–4 grid columns (clamped)
  order?: number;        // lower renders first (default 100)
  enabled?: boolean;     // false hides it
  options?: Record<string, unknown>; // renderer-specific (endpoint, fields, url, …)
}
```

The bundle ships generic **renderer types**; widget **instances** come from
config or plugins. Adding a widget needs no code; adding a new *kind* of widget
means adding one renderer to the UI registry.

## The three tiers

| Tier | What it owns | How |
|------|--------------|-----|
| **Core** (native) | The seam: `DashboardWidget`, the provider registry, `resolveDashboardWidgets`, `GET /api/dashboard`, and the UI renderer registry + built-in renderers. | Always present. |
| **Plugin** (shared) | Widget instances any install could want. | `registerDashboardWidgetProvider(id, (config) => DashboardWidget[])` |
| **Personal** | Widgets specific to one deployment. | `dashboard.widgets` in `config.yaml` |

This is the answer to "native vs plugin vs personal": **the mechanism is native,
the widgets are personal (or plugin).**

## Resolution

`resolveDashboardWidgets(config)` builds the effective list: provider widgets
first, then `dashboard.widgets`. A config entry sharing an id **shallow-merges
over** the provider/built-in widget (re-title, re-span, reorder, or disable a
built-in without redefining it). Disabled widgets are dropped; the rest sort by
`order` then `title`. A throwing provider is skipped, not fatal.

Built-in defaults (`system-status`, `needs-you`, `recent-activity`) register
through the same registry as a plugin would (no privileged built-in). Drop them
all with `dashboard.defaults: false`, or override one by id.

## Built-in renderer types

| `type` | Renders | Key `options` |
|--------|---------|---------------|
| `status` | health dot + model/provider/uptime/tools | `endpoint` (default `/api/health`) |
| `tasks` | task rows with status chip + assignee | `endpoint`, `itemsPath` (default `tasks`), `emptyText` |
| `activity` | recent agent-run rows | `endpoint`, `itemsPath` (default `runs`) |
| `metric` | one big number | `endpoint`, `valuePath`, `unit`, `label` |
| `list` | generic rows | `endpoint`, `itemsPath`, `titleField`, `subtitleField` |
| `markdown` | static or fetched markdown | `markdown`, or `endpoint` + `contentField` |
| `links` | quick links | `links: [{ label, href, external? }]` |
| `iframe` | external embed | `url`, `height` |

`endpoint` must be a same-origin `/api/...` path (a widget spec can't point the
browser at an arbitrary URL — use `iframe` for external embeds).

## Example: a personal board (`config.yaml`)

```yaml
dashboard:
  defaults: true        # keep the built-in status / needs-you / activity widgets
  widgets:
    - id: in-review
      type: tasks
      title: In review
      span: 2
      order: 25
      options:
        endpoint: /api/project-tasks?status=in_review&limit=6
        emptyText: Nothing awaiting review.
    - id: my-backlog
      type: tasks
      title: My backlog
      span: 2
      order: 40
      options:
        endpoint: /api/project-tasks?status=backlog&limit=8
    - id: links
      type: links
      title: Quick links
      order: 50
      options:
        links:
          - { label: Open PRs, href: "https://github.com/quintonmiller/tailored-ai/pulls", external: true }
```

## Example: a plugin contributing a widget

```ts
import { registerDashboardWidgetProvider } from "@tailored-ai/core";

export function register(ctx) {
  registerDashboardWidgetProvider("acme", (config) => [
    { id: "acme-queue", type: "metric", title: "Queue depth",
      options: { endpoint: "/api/acme/stats", valuePath: "pending", label: "pending jobs" } },
  ]);
}
```

The widget appears on the Board with no UI changes, because `metric` is a
built-in renderer. A plugin needing a bespoke visual would add a renderer type
to the UI in a separate change; everything data-shaped works out of the box.
