---
name: dashboard-widget-author
description: Build a Board (dashboard) widget for the TAI web UI. Use when asked to add a widget, panel, card, or page to the dashboard, or to surface some data on the Board. Knows the declarative widget seam, the built-in renderer types, and how to verify a widget without guessing.
version: 0.1.0
allowed-tools:
  - admin
  - facts
  - collections
  - read
  - write
  - edit
  - exec
---

# Authoring a Board widget

The Board (`#/board`) renders **declarative widget specs** the server returns from
`GET /api/dashboard`. A widget is data — `{ id, type, title, span, order, options }` —
not React. Full reference: `docs/dashboard-widgets.md`.

## Step 1 — answer two questions before you build anything

Most widget requests fail one of two ways: the agent invents a new API endpoint and
renderer it can't actually build, or it leaves a placeholder ("stub") widget on the
live dashboard. Both come from skipping these questions. Answer them first.

### Q1 — where does the data come from?

| The data… | Then… | Code? |
|---|---|---|
| is **already** at a `/api/…` endpoint (tasks, sessions, briefing, health, facts, collections, …) | config widget pointing at it | none |
| is **user records you maintain** (a reading list, a watchlist, a collection, a habit log) | **persist it in an existing agent-writable store, then point a widget at that store's read API** | none |
| needs **computation/integration no endpoint provides** (calls an external service, joins data) | a **new `/api/…` endpoint** — this is **core-repo (`autonomous-agent`) work**, not a config change | server |

The middle row is the one people get wrong. You do **not** invent `/api/reading` or a
"reading-tracker" renderer for a reading list. TAI already ships agent-writable stores
with read APIs and renderers — use them:

- **`facts`** (tool → `GET /api/facts`) — quick records as `category / entity / key = value`.
  A reading list: `facts set category=reading entity="<book title>" key=status value="p.142 / 320"`.
  Render with a `list` widget: `endpoint: /api/facts?category=reading`, `itemsPath: facts`,
  `titleField: entity`, `subtitleField: value`. **Config-only, no rebuild.**
- **`collections`** (tool → `GET /api/collections`) — richer typed records with
  `name / notes / rating / location / url`, shown by the interactive `collections`
  renderer (tabs, search, add-form, star ratings). For "track my restaurants / steelbooks /
  games / books." `collections add type=book name="Dune" rating=5`, then a
  `{ type: collections }` widget (or a `list` over `/api/collections?type=book`).

So: **seed the store with the `facts`/`collections` tool, then add a config widget over
its read API.** That is the whole job — no new endpoint, no new renderer, no stub.

### Q2 — can a built-in renderer display it?

- **Yes** (`status`/`metric`/`tasks`/`activity`/`list`/`markdown`/`links`/`iframe`) →
  config widget. **~90% of requests are this.** Done.
- **No** — it needs a custom layout or interactivity no built-in type can express →
  a **new renderer type**, which is a React component in the **UI bundle = core-repo
  (`autonomous-agent`) work** (see "Repo boundary" below).

If unsure, start with a config widget using `list`/`tasks`/`metric`/`markdown`.

## Repo boundary — config is personal, code is core

> **A widget *spec* is personal config; a widget's *renderer* and its *endpoint* are
> core code.** Renderers live in `packages/ui/…` and endpoints in `packages/server/…`,
> which exist **only in the TAI core repo** — not in a personal-config repo or
> worktree. If you are working in a personal-config repo/worktree and the request
> needs a new renderer type or a new `/api/…` endpoint, you **cannot** build it there.
> Do **not** fake it with a markdown "stub" widget. Either (a) re-scope to a config
> widget over an existing store (Q1 — almost always possible), or (b) hand it back /
> file it as an `autonomous-agent` core task. Never leave a placeholder widget on the
> live dashboard.

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

> Field names: TAI's `/api/…` JSON uses **snake_case** keys (`created_at`,
> `updated_at`, `project_id`), and list rows usually carry `id` / `key` / `title` /
> `status`. So for a `list`/`metric` over a TAI endpoint, prefer `key` or `title`
> for `titleField` and `updated_at` for a subtitle — not camelCase guesses like
> `createdAt`.

## Step 2a — config widget

A widget spec looks like this (YAML or JSON — same shape):

```yaml
id: my-widget            # unique; reused id overrides a built-in/plugin widget
type: tasks
title: My widget
span: 2                   # 1–4 columns
order: 30                # lower = earlier
options:
  endpoint: /api/project-tasks?status=in_review&limit=6
  emptyText: Nothing here.
```

**You author the whole thing with the `admin` tool — nothing else is required.**
You do **not** need to fetch the endpoint first. Pick the renderer `type` and its
`options` from the reference above; the `endpoint` only has to already return data.
Do **not** loop trying to `curl`/`web_fetch` a `/api/…` URL to "check the shape" —
same-origin loopback is blocked for `web_fetch`, and not every agent has `exec`. If
the renderer reference doesn't tell you a field name, pick the obvious one and move
on; the Board render is the real check. (Optional: if you happen to have `exec`,
`curl -s localhost:3000<endpoint>` works — but never block on it.)

Steps:

1. `admin` `get_config` section `dashboard` — read the current `dashboard.widgets`
   array (it may not exist yet — that's fine).
2. `admin` `update_config` path `dashboard.widgets`, value = the **full** array
   including any existing widgets plus your new one. The write **replaces** the
   array, so never drop the ones already there. (Only `dashboard.*` is writable
   here — that's intentional.) The runtime reloads automatically; no rebuild.

> Editing `config.yaml` by hand also works, but the file is large and a full
> rewrite is risky — prefer `admin.update_config` for a surgical, validated change.

Verify (config hot-reloads — no rebuild) with **`admin` `get_config` section
`dashboard`** — your new widget appears in the array. If a spec is malformed,
`update_config` still writes it but the reload logs a `dashboard.widgets:` warning
and the resolver drops it from `/api/dashboard`, so re-read after writing. Then note
that it renders at `#/board`. (No need to curl — `get_config` is your check.)

## Step 2b — new renderer type

This is the path for a **fully custom / interactive** widget (local state, buttons,
forms) — anything the generic renderers can't express. Use the **`edit`** tool for
these changes (surgical exact-match replacement); do **not** rewrite a whole file
with `write` — `widgets.tsx` is hundreds of lines and a full overwrite is how you
drop an existing renderer.

> **Paths:** use **repo-root-relative paths** (e.g. `packages/ui/src/components/widgets.tsx`)
> for every tool — `read`/`write`/`edit` *and* `exec`. Don't prefix `/work` or a
> home path: the file tools and a sandboxed `exec` resolve absolute paths
> differently, but a relative path works for both. The three files you touch:
> `packages/ui/src/components/widgets.tsx` (renderer + `widgetRenderers` map),
> `packages/core/src/dashboard/index.ts` (`BUILTIN_WIDGET_TYPES`),
> `packages/ui/src/styles.css` (styles). Then add the config widget with `admin`.
> No need to explore — these are the only files.

Edit **`packages/ui/src/components/widgets.tsx`**:

1. Add a component `({ widget }: WidgetProps) => ReactNode`. `useState`/`useEffect`
   are already imported, so interactivity (search inputs, refresh buttons, tabs) is
   fine. For endpoint-backed data use the existing `useWidgetData(endpoint)` hook and
   the `opt(widget, key, fallback)` / `asArray` / `getPath` helpers — copy the closest
   existing renderer (`ListWidget`, `TasksWidget`). Insert it with one `edit` whose
   `old_string` is the `export const widgetRenderers` line and `new_string` is your
   component followed by that same line.
2. Register it: `edit` the `widgetRenderers` map to add `myType: MyWidget`.
3. Style it in `packages/ui/src/styles.css` (append with `edit` after an existing
   `.widget-*` rule), reusing the design tokens (`var(--text-dim)`, `var(--border)`,
   `var(--radius)`, …) and the `.widget-*` classes already there.

Then add the canonical name to `BUILTIN_WIDGET_TYPES` in
`packages/core/src/dashboard/index.ts` so config validation recognizes it.

Verify: `pnpm --filter @tailored-ai/ui run build` (must pass) → add a config widget
of your new `type` → check the Board.

## Guardrails

- **Never ship a stub.** If you can't build the real widget, do not leave a markdown
  placeholder ("This is a stub — the full version needs…") on the live dashboard. A
  stub is a silent failure: it looks done but isn't. Re-scope to a config widget over
  an existing store (Q1), or escalate it as core-repo work. Nothing on the Board should
  be fake.
- **Reuse a store before inventing an endpoint.** For user records, `facts` or
  `collections` (Q1) almost always removes the need for any new `/api/…` route or
  renderer. Reach for a new endpoint only when real computation/integration is involved.
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
