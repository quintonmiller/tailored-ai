---
# autonomous-agent-8c4q
title: 'S7.2: tai project CLI commands'
status: todo
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:21:00Z
parent: autonomous-agent-bv73
---

## Goal
`tai project` subcommand for managing the project registry.

## Commands

- `tai project init [--name <n>]` — drops `.tai.yaml` in cwd, generates `proj_*` id, registers row in `projects` table with absolute cwd. Errors if `.tai.yaml` already exists.
- `tai project list` — table of registered projects (id, name, path, status). Marks current cwd's project with `*`.
- `tai project show [<id>]` — full record; defaults to current project from cwd.
- `tai project add <path> [--name <n>]` — register an existing repo without writing `.tai.yaml` there (lazy mode — `tai` from inside still resolves via the path-match fallback).
- `tai project remove <id>` — soft-delete (set status=archived); does NOT delete `.tai.yaml` or any data.

## CLI plumbing
- New file `packages/cli/src/commands/project.ts`
- Wire as subcommand in `packages/cli/src/index.ts` arg dispatch
- Use existing `createProject`/`queryProjects`/`updateProject` from `@agent/core` (`packages/core/src/db/project-queries.ts`)

## Tests
- Each command end-to-end against a temp DB + temp dir
- Init twice in the same dir → error
- Init in a dir that's already inside a registered project → warn (nested projects discouraged)
