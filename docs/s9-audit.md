# S9 Phase 1 — Package-split audit

Status: **draft, awaiting sign-off before Phase 2 extraction.**
Scope: every file under `packages/core/src/` (109 source files, excluding tests).

The goal of S9 is to make `@tailored-ai/core` a sub-5MB framework that gives you a working `tai chat` plus the resource registry. Everything else — Discord, Playwright, Google APIs, md-to-pdf, workflows, cron, autopilot, the optional task backends, the container sandboxes — moves into opt-in peripheral packages.

This audit classifies every file. Three buckets:

- **CORE** — stays in `@tailored-ai/core`. Framework infra, not a feature.
- **PERIPHERAL → `<package>`** — moves to a named peripheral package.
- **SPLIT** — file contains a mix; the audit notes how to slice it.

The "Where does this live?" decision tree used here:

1. Pure interface or registry definition with no heavy deps → CORE
2. Used by every entry point (CLI, HTTP, all channels) and not optional → CORE
3. Brings in a single heavy npm dep (playwright, discord.js, googleapis, md-to-pdf, …) → its own package
4. Cohesive feature area (workflows, cron, autopilot, …) → one package per area
5. Provider/channel/sandbox/task-backend implementation → its themed package, registered through the resource registry on import

---

## CORE — `@tailored-ai/core` (the lightweight base)

### Runtime + composition
- `runtime.ts` — AgentRuntime, registry orchestration. CORE.
- `factories.ts` — `createTools`, `createProvider`, `createMetaTools`. Trimmed to only built-in tools/providers; peripheral packages register themselves on import.
- `index.ts` — public exports. CORE; peripheral packages re-export their own surfaces.
- `config.ts` — `AgentConfig` schema, `validateConfig`, project overlay merging. CORE.
- `context.ts` — load `data/context/**/*.md`. CORE.
- `commands.ts` — slash-command parser used by REPL. CORE.
- `approval.ts` — permission rule engine. CORE.
- `shell.ts` — `bash -c` helper. CORE.

### Agent loop
- `agent/loop.ts` — the loop, history trimming, validation. CORE.
- `agent/agents.ts` — `resolveAgent`. CORE.
- `agent/profiles.ts` — 2-line deprecation alias. CORE (stays one cycle, then delete).
- `agent/session.ts`, `agent/prompt.ts`, `agent/hooks.ts`, `agent/compact.ts`, `agent/tasks.ts` — CORE.

### Resource registry (S8 output)
- `resources/**` — all of it, including:
  - `interface.ts`, `registry.ts`, `loader.ts`, `manifest.ts`
  - `trust.ts`, `approval-gate.ts`, `lockfile.ts`, `builtins.ts`, `index.ts`
  - All kind-specific facade registries: `tool-registry.ts`, `provider-registry.ts`, `skill.ts`, `kb-registry.ts`, `prompt-registry.ts`, `step-executor-registry.ts`, `trigger-registry.ts`
  - All sources: `sources/file.ts`, `sources/http.ts`, `sources/git.ts`, `sources/npm.ts`, `sources/agent.ts`, `sources/registry-index.ts`
- CORE. This is the whole point of the lightweight base — every peripheral package consumes it.

### DB
- `db/schema.ts`, `db/queries.ts` — CORE. Schema is unified; tables for peripheral packages live in the same SQLite file but their queries ship with the package.
- `db/task-queries.ts` — CORE (project tasks are core).
- `db/fact-queries.ts` — CORE.
- `db/project-queries.ts` — CORE (project resolution is core).
- `db/autopilot-queries.ts` — **PERIPHERAL → `@tailored-ai/autopilot`**.
- `db/workflow-queries.ts` — **PERIPHERAL → `@tailored-ai/workflows`**.
- `db/form-queries.ts` — **PERIPHERAL → `@tailored-ai/workflows`**.
- `db/document-queries.ts` — **PERIPHERAL → `@tailored-ai/documents`** (or fold into `tool-documents`).
- `db/schema.ts` — **SPLIT**: keep core tables; peripheral migrations registered via a `Migration[]` array exported by each package and applied in dependency order by core. See "Schema federation" below.

### Built-in tools
- `tools/interface.ts`, `tools/retry.ts` — CORE.
- `tools/memory.ts`, `tools/read.ts`, `tools/write.ts`, `tools/exec.ts` — CORE.
- `tools/tasks.ts`, `tools/facts.ts`, `tools/projects.ts` — CORE.
- `tools/admin.ts`, `tools/resource-admin.ts` — CORE.
- `tools/delegate.ts`, `tools/task-status.ts` — CORE (meta tools).
- `tools/ask-user.ts` — CORE.
- `tools/custom.ts` — CORE (`custom_tools` YAML config).

### Built-in provider + sandbox + task backend
- `providers/interface.ts`, `providers/openai.ts` — CORE. `openai_compatible` is the baseline.
- `channels/interface.ts` — CORE.
- `sandboxes/interface.ts`, `sandboxes/factory.ts`, `sandboxes/host.ts`, `sandboxes/registry.ts` — CORE.
- `tasks/interface.ts`, `tasks/factory.ts`, `tasks/native.ts` — CORE.
- `projects/resolve.ts` — CORE.

### Prompt expansion
- `prompts/expand.ts` — CORE.

---

## PERIPHERAL packages

### `@tailored-ai/providers-anthropic`
- `providers/anthropic.ts`
- Registers itself with the provider registry on import.

### `@tailored-ai/channel-discord`
- `channels/discord.ts`
- `channels/discord-approval.ts`
- Adds the `discord` channel and an approval handler. Heavy dep: `discord.js`.

### `@tailored-ai/integrations-google`
- `tools/gmail.ts`
- `tools/google-calendar.ts`
- `tools/google-drive.ts`
- `triggers/email-poll.ts`
- `triggers/calendar-poll.ts`
- Heavy dep: `googleapis`. One package keeps OAuth boilerplate in one place.

### `@tailored-ai/tool-browser`
- `tools/browser.ts`
- Heavy dep: `playwright`. Largest single dep in the tree — high-priority extraction.

### `@tailored-ai/tool-md-to-pdf`
- `tools/md-to-pdf.ts`
- Heavy dep: `md-to-pdf` (pulls puppeteer).

### `@tailored-ai/tool-claude-code`
- `tools/claude-code.ts`

### `@tailored-ai/tool-web`
- `tools/web-fetch.ts`
- `tools/web-search.ts`
- Light deps, but optional: not every install needs web access.

### `@tailored-ai/workflows`
- `workflows/**` (all 17 files)
- `tools/run-workflow.ts`
- `db/workflow-queries.ts`
- `db/form-queries.ts`
- Workflows register their step executors via the step-executor registry. The package exports its DB migrations for core to apply.
- **Caveat**: `workflows/executors/discord-message.ts` cross-cuts Discord. Two options: (a) move just that executor into `@tailored-ai/channel-discord` and have it self-register; (b) keep it here behind an optional peer-dep on the discord package. Recommend (a) — keeps each package's deps honest.

### `@tailored-ai/cron`
- `cron/scheduler.ts`
- `cron/schedule-dsl.ts`

### `@tailored-ai/autopilot`
- `autopilot/worker.ts`
- `autopilot/digest.ts`
- `db/autopilot-queries.ts`
- `task-watcher.ts` — pulls in Discord type; refactor to inject `Channel` rather than depend on Discord directly, then this lives in autopilot.

### `@tailored-ai/triggers-feed`
- `triggers/rss-poll.ts`
- `triggers/file-drop.ts`
- Cheap to keep separate from the Google trigger bundle; users who only want RSS shouldn't pull in googleapis.

### `@tailored-ai/task-backends`
- `tasks/github.ts`
- `tasks/beans.ts`
- `tasks/beads.ts`
- Each backend registers with the task backend registry on import. Users can install just the one they use.

### `@tailored-ai/sandboxes-container`
- `sandboxes/container.ts`
- `sandboxes/docker.ts`
- `sandboxes/podman.ts`
- Registers `docker` and `podman` sandbox kinds.

### `@tailored-ai/worktree`
- `worktree.ts`
- Used by workflows' worktree executor and (occasionally) by autopilot. Could live in `@tailored-ai/workflows` instead; recommend its own package since it's a thin standalone helper.

### `@tailored-ai/documents` (provisional)
- `tools/documents.ts`
- `db/document-queries.ts`
- Pairs with the PDF/OCR work (ptask_2a5f439e). Defer creation until that bean lands; meanwhile keep these in core under a `documents/` subfolder pre-staged for the eventual move.

---

## Cross-cutting concerns

### Schema federation
Today `db/schema.ts` defines every table. After the split, each peripheral package owns its tables and exports a `Migration[]`. Core exposes:

```ts
runtime.registerMigrations(packageName: string, migrations: Migration[]): void
```

Migrations run on `runtime.init()` in dependency order. This is the same pattern Rails uses for engines and keeps the SQLite file unified without forcing a multi-file split.

### Built-in registration pattern
Each peripheral package's entry exports a `register(runtime)` function and a default side-effect-on-import that calls it once. Pattern:

```ts
// @tailored-ai/providers-anthropic/src/index.ts
import { AnthropicProvider } from "./anthropic.js";
export function register(runtime: AgentRuntime) {
  runtime.getProviderRegistry().registerBuiltin("anthropic", () => new AnthropicProvider(...));
}
if (process.env.TAI_AUTO_REGISTER !== "false") {
  // Lazy: only registers if user actually imports the package
}
```

The CLI's startup imports peripheral packages declared under `peripherals:` in `config.yaml`; missing modules become a warning, not a hard error. This is what makes the framework feel "modular without ceremony".

### Build matrix
14 packages × typecheck + test = ~14 build steps. Mitigation: pnpm filters + turbo-style task graph (already used). Acceptance test: `pnpm install && pnpm build` from a clean clone should stay under 90s on a developer laptop.

### Version skew
In-repo deps use `workspace:*`; published deps lock to the matching minor. We commit to publishing all peripherals in lockstep with core during the deprecation window.

### Back-compat — `@agent/core` meta-package
For one minor version after S9 lands, `@agent/core` continues to publish, but as a meta-package that depends on every peripheral and re-exports their public surface. A deprecation warning fires once on import. Existing users keep working until they `pnpm add @tailored-ai/core` + opt-ins.

### CI matrix
Three smoke-test rigs:
- Base only — `pnpm add @tailored-ai/core`, run `tai chat` with `openai_compatible`, verify <5MB install.
- Base + workflows + cron + autopilot — typical autonomous-agent install.
- Full — every peripheral, verify nothing collides.

---

## Acceptance criteria

- `pnpm add @tailored-ai/core` produces an install < 5MB on disk.
- `tai chat` works against an `openai_compatible` endpoint with only the base installed.
- Each peripheral is one `pnpm add @tailored-ai/<name>` away from being usable.
- Existing `@agent/core` users see one deprecation warning and otherwise keep working through the deprecation window.
- Resource registry continues to be the single integration surface.

---

## Phase 2 plan (preview, not part of this audit)

1. Set up the peripheral package skeleton under `packages/peripherals/<name>/` (or a `peripherals/` dir at the repo root — TBD).
2. Move files per the table above, one package per PR, smallest first (`@tailored-ai/providers-anthropic` is a one-file move and a good warm-up).
3. Add `register()` exports and the schema-federation hook on core.
4. Rename `@agent/core` → `@tailored-ai/core`; publish meta-`@agent/core` as a back-compat shim.
5. Land the CLAUDE.md decision-tree rule so new features land in the right package by default.

---

## Going-forward rule (lands in CLAUDE.md when Phase 2 starts)

When adding a new feature, ask:

1. Does it bring in a heavy npm dep (>2MB)? → its own package.
2. Does it fit a thematic peripheral package (workflows, autopilot, integrations-google, …)? → that package.
3. Is it a new built-in tool/provider/channel/sandbox/task-backend? → its themed peripheral package.
4. Is it framework infra (loop, runtime, registry, config, db schema-federation)? → `@tailored-ai/core`.
5. Default if unsure: peripheral package. Core only grows for genuine framework changes.
