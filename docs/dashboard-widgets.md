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

## Editing the layout (drag to reorder / resize)

The Board has an **Edit Layout** mode (iOS-Widgets style): drag a card to reorder,
drag its bottom-right corner to resize — **width** snaps to 1–4 columns (`span`)
and **height** to 1–6 rows (`rowSpan`) — then **Done**. Widget content scrolls
inside its box when it's taller than the chosen height. It persists via
`POST /api/dashboard/layout` — the body is the widgets in display order with their
`span` + `rowSpan`, and the route rewrites `dashboard.widgets` (order = position;
span/rowSpan clamped). Config widgets keep their full spec; built-in/provider
widgets get a minimal `{id, type, order, span, rowSpan}` override so the resolver
merge preserves their core-owned title/options. So a hand-edited `dashboard.widgets`
and a drag-edited one are the same shape — you can keep editing either way.

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

## Authoring with a TAI agent

Widget development is designed to be an agent task. The pieces that make an
agent's loop tight:

- **A skill.** `docs/example-skills/dashboard-widget-author/` is a SKILL.md that
  teaches an agent the whole flow: pick config-vs-renderer, the built-in types
  and their options, where the files are, the guardrails, and how to verify.
  Install + enable it on a coding agent:
  ```bash
  tai resources install ./docs/example-skills/dashboard-widget-author
  # then add the skill id to the agent's `skills:` in config.yaml
  ```
- **A validator for fast feedback.** `validateDashboardWidget(widget)` (exported
  from `@tailored-ai/core`) returns issue strings — empty means valid. The agent
  can check a spec *before* a rebuild:
  ```js
  const { validateDashboardWidget } = require("@tailored-ai/core");
  validateDashboardWidget({ id: "x", type: "tasks", options: { endpoint: "/api/project-tasks" } }); // []
  ```
  `validateConfig` runs the same check over `dashboard.widgets`, so a malformed
  spec surfaces as a `dashboard.widgets: …` startup warning (missing id/type, bad
  span, non-`/api/` endpoint, unknown type, duplicate id) instead of silently
  rendering a fallback.
- **A no-rebuild path the agent can drive with one tool.** Config widgets
  hot-reload, and `dashboard.` is in the `admin` tool's write allowlist, so a
  running agent adds a widget with `admin` alone — no file editing:
  1. `admin` `get_config` section `dashboard` (read the current array),
  2. `admin` `update_config` path `dashboard.widgets` with the **full** array
     (the write replaces it, so include the existing widgets), which reloads the
     runtime; `/api/dashboard` reflects it on the next request.

  Only a brand-new renderer *type* needs a UI build. The skill steers agents to
  the config path first, and tells them **not** to probe the endpoint — a widget
  is authored from the renderer reference above, not by fetching the URL (a
  same-origin loopback `web_fetch` is blocked by egress policy, and not every
  agent has `exec`).

The canonical built-in type names live in `BUILTIN_WIDGET_TYPES` (core), shared by
the validator, the skill, and this doc — one source of truth.
