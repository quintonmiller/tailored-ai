---
# autonomous-agent-klz6
title: 'Slice 1: Prompt expansion'
status: completed
type: epic
priority: high
created_at: 2026-05-03T22:42:53Z
updated_at: 2026-05-03T22:49:25Z
parent: autonomous-agent-6p6y
---

Generalize template substitution into expandPrompt(text, vars, ctx) supporting {{var}}, !`shell cmd` inline shell, and @./file.md / {{include:path}} file inclusion. Used by cron, hooks, agent instructions, and (future) workflow steps. Shell expansion gated behind config flag prompts.allowShellExpansion.

## Tasks

- [x] Create `packages/core/src/prompts/expand.ts` exporting `expandPrompt(text, vars, ctx)` (async)
- [x] Implement `{{var}}` substitution (port logic from `hooks.ts:applyTemplates`)
- [x] Implement `{{include:path}}` file inclusion with depth limit (5) and base-dir resolution (deferred `@./path` shorthand — risk of false positives in user prose)
- [x] Implement `!\`cmd\`` inline shell expansion using `execFile` with timeout; on error inject `[!shell error: ...]` so the agent sees the failure
- [x] Add `prompts.allowShellExpansion` config flag (default false) in `config.ts` `DEFAULT_CONFIG`; gate shell expansion on it (also added `shellTimeoutMs`, `maxIncludeDepth`, `includeBaseDir`)
- [x] Replace `applyTemplates` call sites in `hooks.ts` to use `expandPrompt` (`applyTemplates` kept as sync alias for back-compat; hook args now expand fully)
- [x] Wire into cron prompt rendering in `cron/scheduler.ts` (also wired `task-watcher.ts`)
- [-] Wire into agent instructions resolution in `agent/agents.ts` — DEFERRED. `resolveAgent` is sync and called from many places; making it async ripples through the codebase. Static instructions rarely change run-to-run, so the benefit is small. Revisit if needed.
- [x] Unit tests in `packages/core/src/__tests__/expand.test.ts` (13 tests, all passing)
- [x] Export `expandPrompt` from `packages/core/src/index.ts` (also exports `applyVars`, `ExpandOptions`)
- [x] Update CLAUDE.md (new "Prompt Expansion" section before "Adding a Cron Job")

## Summary of Changes

- New `packages/core/src/prompts/expand.ts` exporting `expandPrompt` (async; full pipeline) and `applyVars` (sync; var-only legacy).
- Three expansion forms: `{{include:path}}` → recursive file inclusion with depth limit; `{{var}}` → variable substitution; `!\`shell cmd\`` → inline shell, gated behind `prompts.allowShellExpansion`. Pipeline order: includes → vars → shell.
- New `prompts` config block in `AgentConfig` with defaults (`allowShellExpansion: false`, `shellTimeoutMs: 5000`, `maxIncludeDepth: 5`, optional `includeBaseDir`).
- `applyTemplates` is now a sync alias for `applyVars` — call sites unchanged. `executeHooks` accepts an optional `promptsConfig` and uses `expandPrompt` for string-valued hook args, so hooks can pull in shell output and includes when allowed.
- Wired full expansion into `cron/scheduler.ts` (`job.prompt` rendered through `expandPrompt`) and `task-watcher.ts` (`config.prompt`).
- 13 unit tests in `packages/core/src/__tests__/expand.test.ts`; all 153 core tests pass; full monorepo typechecks clean.
- CLAUDE.md gained a "Prompt Expansion" section.

## Deferred

- Wiring expansion into `agent/agents.ts` instruction resolution — `resolveAgent` is sync and broadly used; making it async ripples through delegate, runtime, loop options, etc. Static instructions rarely benefit from per-run shell expansion. Revisit if a concrete user need surfaces.
