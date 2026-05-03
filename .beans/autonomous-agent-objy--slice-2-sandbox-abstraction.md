---
# autonomous-agent-objy
title: 'Slice 2: Sandbox abstraction'
status: completed
type: epic
priority: high
created_at: 2026-05-03T22:42:53Z
updated_at: 2026-05-03T22:59:32Z
parent: autonomous-agent-6p6y
---

New module category packages/core/src/sandboxes/ with Sandbox interface and built-ins: host (default, no-op), docker (bind-mount), podman. Make exec/read/write tools sandbox-aware via ToolContext. Wire AgentDefinition.sandbox: 'host'|'docker'|'podman'.

## Tasks

- [x] Create `packages/core/src/sandboxes/interface.ts` with `Sandbox` + `SandboxHandle` types and `Mount`, `SandboxExecOptions`, `SandboxExecResult`, `SandboxPrepareOptions`
- [x] Create `packages/core/src/sandboxes/host.ts` (default, behavioral identity — runs on host)
- [ ] Create `packages/core/src/sandboxes/docker.ts` (bind-mount worktree, optional mounts, optional network, env)
- [ ] Create `packages/core/src/sandboxes/podman.ts` (rootless variant of docker.ts)
- [x] Add `sandbox?` to `AgentDefinition` in `config.ts` (also added `agent.sandbox` as the default for all agents)
- [x] Extend `ToolContext` with optional `sandbox?: Sandbox` and `sandboxHandle?: SandboxHandle`
- [ ] Make `exec.ts`, `read.ts`, `write.ts` route through `context.sandbox` when set; fall back to host
- [x] Factory wiring done in `runtime.buildLoopOptions`: calls `createSandbox(config, agent)`, threads through `AgentLoopOptions.sandbox`. `runAgentLoop` then prepares once, populates ToolContext, and cleans up in a finally block.
- [x] Sandbox lifecycle: prepare/cleanup wrapped in try/finally inside `_runAgentLoopInner` (cleanup errors logged, never thrown)
- [x] 9 unit tests for HostSandbox in `__tests__/host-sandbox.test.ts`. Docker integration tests deferred until the docker backend lands.
- [x] Export sandboxes from `packages/core/src/index.ts` (`Sandbox`, `SandboxKind`, `SandboxHandle`, `Mount`, prepare/exec opts, `HostSandbox`, `createSandbox`)
- [x] Document sandboxing in CLAUDE.md (new "Sandboxes" section)

## Wired tools

- `exec.ts` — routes through sandbox when `context.sandbox` and `context.sandboxHandle` are both set; otherwise falls back to host execFile.
- `read.ts` / `write.ts` — still go to host filesystem directly. Wiring them is part of follow-up T6 below (so the docker sandbox is meaningful for filesystem ops, not just shell).

## Follow-ups created

- autonomous-agent-a182 — Docker sandbox backend (high — most useful follow-up)
- autonomous-agent-m4ms — route read.ts and write.ts through sandbox
- autonomous-agent-wbq7 — Podman sandbox backend (blocked by autonomous-agent-a182)

## Summary of Changes

- New `packages/core/src/sandboxes/` module: `interface.ts` (`Sandbox`, `SandboxHandle`, `Mount`, exec/prepare opt types, `SandboxKind`), `host.ts` (`HostSandbox` — behavioral identity wrapper around `execFile` + `fs`), `factory.ts` (`createSandbox(config, agent)`).
- New `agents.<name>.sandbox` and `agent.sandbox` config fields with values `host | docker | podman`. Default `host`.
- `ToolContext` gains optional `sandbox` and `sandboxHandle` fields. `exec.ts` honors them when both are set; otherwise falls back to host `execFile`.
- `AgentLoopOptions` gains optional `sandbox`. `runAgentLoop` prepares once at top, threads handle into ToolContext, cleans up in a finally block (errors logged, not thrown). The inner loop body was extracted into `_runAgentLoopBody` so the try/finally encloses all return paths cleanly.
- `runtime.buildLoopOptions` calls `createSandbox` per agent and threads it into `AgentLoopOptions`. End-to-end host wiring is live; behavior is identical (the host sandbox is a no-op wrapper).
- 9 unit tests in `__tests__/host-sandbox.test.ts`. All 173 core tests pass; full monorepo typechecks clean.
- CLAUDE.md gained a "Sandboxes" section.
- Three follow-up beans cover Docker, read/write tool wiring, and Podman.
