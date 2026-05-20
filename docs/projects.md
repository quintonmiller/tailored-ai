# Projects (per-project mode)

By default tai is global: one home dir (`~/.tailored-ai/` or `TAI_HOME`), one config, one DB, one Discord bot, one cron scheduler. Per-project mode lets a single tai brain manage N registered repos by threading a `project_id` through sessions, tasks, cron, autopilot, and Discord — without forking the install or going multi-process.

## Registering a project

```bash
cd ~/repos/my-app
tai project init --name "My app"      # writes .tai.yaml, registers in DB
tai project list                       # see all registered projects (current dir marked *)
tai project show                       # inspect the current dir's project
tai project add ~/repos/other          # register a path lazily (no .tai.yaml written)
tai project remove proj_abc12345       # archive (status=archived); --hard for real DELETE
```

`.tai.yaml` shape:

```yaml
project:
  id: proj_abc12345         # set by `init`, immutable
  name: "My app"            # human label; defaults to dirname
config:                     # optional overlay merged over global config.yaml
  agent:
    temperature: 0.5
  agents:
    coder:                  # deep-merged with the global agents.coder
      tools: ["read", "write", "exec"]
  tasks:
    backend: github         # this project uses GitHub Issues; others stay native
```

## How resolution works

When you run any `tai ...` command from inside a registered repo, the CLI walks up from cwd looking for `.tai.yaml`. If found, it reads `project.id`, looks up the DB row, and calls `runtime.setActiveProject(...)` — the overlay merges into the live config and any new sessions created in that run get the project_id stamped on them.

If there's no `.tai.yaml` on disk but the cwd is inside a registered project's `path` (the lazy-mode case), the resolver still finds it via ancestor lookup.

CLI overrides:
- `--project <id>` — scope to a specific project regardless of cwd
- `--global` — force global mode even inside a registered repo
- `--list-sessions --project <id>` — filter the session list

## Config overlay semantics (`mergeProjectOverlay` in config.ts)

- Maps deep-merge (project keys override global; new keys added)
- Arrays replace wholesale (no concat)
- `agents.<name>` deep-merges so a project can override one field without redefining the whole agent
- Validation warnings introduced by the overlay are tagged `[project:<id>] Warning:` so the source is visible

## What's project-scoped

- **Sessions** carry `project_id`; CLI flags `--project <id>` and `--global` filter `--list-sessions`.
- **Agent loop cwd**: tools and sandboxes operate against the active project's `path` rather than `process.cwd()`.
- **Cron jobs**: `CronJobConfig.project: <id>` binds a job to a project. Session keys auto-namespace to `cron:<projectId>:<name>`. Jobs declared in a project's `.tai.yaml` overlay only fire when that project is the runtime's active one (single-tenant constraint of S7).
- **Autopilot**: tasks with `project_id` run with that project's path as cwd; the worker still uses one task backend per tick (multi-backend iteration is a future bean).
- **Discord**: `channels.discord.projectMappings` binds guild channels or DMs to a project. Matched messages get `discord:<projectId>:<userId>` session keys. Unmapped messages stay global.
- **HTTP**: `GET /api/sessions?project=<id>` filters by project (or `?project=global` for un-scoped).
- **UI**: header `<select>` (ProjectSwitcher) persists selection to `localStorage["tai.activeProjectId"]`. Pages that opt in via the `useActiveProject()` hook re-fetch on change.

## Going to "all projects in parallel" later

The project_id threading done here is a prerequisite for ever upgrading to a workspace daemon model where multiple projects' loops run concurrently. S7 stays single-tenant on purpose — runs serialize, one Discord bot, one cron scheduler — but isolation along the project_id axis is preserved so a future Slice 8 (or external supervisor) can fan that out.
