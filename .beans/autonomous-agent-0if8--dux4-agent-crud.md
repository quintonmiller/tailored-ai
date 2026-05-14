---
# autonomous-agent-0if8
title: DUX4 — Agent CRUD
status: completed
type: task
priority: high
created_at: 2026-05-14T05:30:54Z
updated_at: 2026-05-14T05:48:52Z
parent: autonomous-agent-p0ae
---

# DUX4 — Agent CRUD

Fixes pain point #4 (Agents page is read-only).

## What's wrong today

- `packages/ui/src/pages/Agents.tsx` only reads `GET /api/agents`. No way
  to create, edit, or delete an agent from the UI.
- The capability already exists in core via `AdminTool` (it rewrites
  `config.yaml` and triggers `runtime.reload()`); it just isn't exposed
  as REST.

## Changes

### Server
- `packages/server/src/index.ts`:
  - `POST /api/agents` — `{ name, definition }`, validates name is unique
    and the definition shape; writes to `config.yaml`; triggers
    `runtime.reload()`; returns the new merged agent.
  - `PATCH /api/agents/:name` — partial update of the agent definition;
    same write + reload path.
  - `DELETE /api/agents/:name` — removes from `config.yaml`; reload.
- Implementation reuses the YAML write helpers already used by
  `AdminTool` (`packages/core/src/tools/admin.ts`). Extract a small
  module if needed so both call sites share it.

### UI
- `packages/ui/src/api.ts`: add `createAgent`, `updateAgent`, `deleteAgent`.
- `packages/ui/src/pages/Agents.tsx`:
  - `+ New Agent` button opens a modal/form with fields for description,
    instructions, model, temperature, tools allowlist, `injectMemory`,
    `summarizeOnTrim`, hooks (just `beforeRun`/`afterRun` tool refs for
    now).
  - Each agent card gains an "Edit" affordance opening the same form
    pre-filled, and a "Delete" with confirm.
  - Tools picker reads from `GET /api/tools` so the allowlist is concrete.
  - "Test" button on a card opens the chat dock (DUX2) pre-bound to that
    agent.

## Acceptance

- Creating an agent from the UI writes it to `config.yaml`, reload picks
  it up, the new agent appears in the list and is usable from the chat
  dock.
- Editing an existing agent's instructions or tools persists across
  server restart.
- Deleting an agent removes it from `config.yaml`; references from cron
  jobs trigger the existing validation warning.
- `pnpm run typecheck` + `pnpm run test` pass.
