---
# autonomous-agent-8c4q
title: 'S7.2: tai project CLI commands'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:40:47Z
parent: autonomous-agent-bv73
---

Implemented:
- New file `packages/cli/src/commands/project.ts` exposing `runProjectCommand(args)`
- Subcommands: `init`, `list`, `show`, `add`, `remove`, `help`
- `init` writes `.tai.yaml` and registers in DB (with `path` + `config_overlay_path`)
- `add` registers an existing path without writing `.tai.yaml` (lazy mode)
- `list` marks the current cwd's project with `*`; archived projects tagged `[archived]`
- `show [<id>]` defaults to the current cwd's project (uses S7.1 ancestor resolution)
- `remove <id>` soft-deletes (status=archived); `--hard` does a real DELETE
- Errors: init when `.tai.yaml` exists, init when path already registered, add when path registered, unknown subcommand, missing positional, etc.
- `index.ts` peels off `argv[0] === "project"` before `parseArgs` and routes to the subcommand handler

Verified end-to-end in a temp home dir: help, init, add (lazy), list with active marker, show from cwd, ancestor lookup from deep nested dir, double-init error, double-register error, soft-delete + [archived] display, unknown subcommand.

No CLI-level vitest infra exists in this package; the underlying primitives (`createProject`, `getProjectByPath`, `buildProjectFile`, `resolveProjectFromCwd`) are covered by the S7.1 test file. Integration test for the full CLI flow is bundled into S7.8.

Next: S7.3 (per-project config overlay).
