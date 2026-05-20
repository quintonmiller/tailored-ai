# Sandboxes & Worktrees

How tool side-effects are isolated (host / docker / podman) and how the worktree helper runs agents on an isolated branch.

## Sandboxes

Tool side-effects (shell, file IO) can be routed through a `Sandbox` defined in `packages/core/src/sandboxes/interface.ts`. Today:

- **`host`** (default) — `packages/core/src/sandboxes/host.ts`. Runs commands directly on the host. No isolation.
- **`docker`** — `packages/core/src/sandboxes/docker.ts`. Long-running container with the host cwd bind-mounted at `/work` (configurable). `prepare()` runs `docker run -d --rm -v <cwd>:/work -w /work --entrypoint sleep <image> infinity`; `exec()` runs `docker exec`; file IO goes through the bind-mount path on the host. `cleanup()` is best-effort `docker rm -f`.
- **`podman`** — `packages/core/src/sandboxes/podman.ts`. Same surface as `DockerSandbox` (rootless/CLI-compatible); both extend a shared `ContainerSandbox` base in `container.ts`. Config goes under `sandboxes.podman.{imageName, mounts, env, network, sandboxWorkdir}`.

Lifecycle: the runtime calls `createSandbox(config, agent)` in `buildLoopOptions()` and threads the result into `AgentLoopOptions.sandbox`. `runAgentLoop` calls `sandbox.prepare({ cwd })` before the loop body and `sandbox.cleanup(handle)` in a finally block. The handle lands on `ToolContext` as `sandbox` + `sandboxHandle`.

Tools opt in by checking for both fields and routing through `context.sandbox.exec(handle, cmd, opts)` / `readFile` / `writeFile`. `exec.ts`, `read.ts`, and `write.ts` are wired today. `HostSandbox.writeFile` and `DockerSandbox.writeFile` auto-create parent directories so tools don't need to mkdir themselves.

Config:

```yaml
agent:
  sandbox: host                # default for all agents
agents:
  coder:
    sandbox: docker            # per-agent override
sandboxes:
  docker:                      # required when any agent uses docker
    imageName: node:22-bookworm
    network: host              # optional
    sandboxWorkdir: /work      # optional, default /work
    mounts:                    # optional extras beyond cwd bind
      - { hostPath: ~/.npm, sandboxPath: /home/agent/.npm, readonly: true }
    env:                       # optional defaults
      NODE_ENV: development
```

`DockerSandbox` accepts an injected `runner: DockerRunner` for testability — tests substitute a fake; production uses `execFile('docker', ...)` directly.

## Worktrees

`packages/core/src/worktree.ts` is a thin wrapper over `git worktree` for running an agent in an isolated branch and merging back. Built for the workflow runner (S5) but usable directly.

```ts
import { createWorktree } from "@agent/core";

const wt = await createWorktree({
  repoDir: ".",
  strategy: { type: "merge-to-head", branch: "agent/fix-42" },
});
// ...agent runs in wt.path...
const merged = await wt.mergeToHead?.();
if (!merged?.ok) console.log(`branch preserved: ${merged?.branchPreserved}`);
await wt.cleanup(); // removes if clean; preserves if dirty
```

Three strategies:
- `head` — no worktree; runs in `repoDir` on current branch. Cleanup is a no-op.
- `branch` — fresh worktree on a named branch. Cleanup removes if clean, preserves if dirty.
- `merge-to-head` — same as `branch` plus `mergeToHead()` that runs `git merge --no-ff <branch>` against the host repo. On conflict, aborts the merge (host left clean) and preserves the branch.

`autoStash(repoDir)` stashes only modified-tracked files (deliberately not untracked — matches the mmo sandcastle autostash pattern, so a `.worktrees/` dir doesn't get swept up). Returns `{ stashed, pop() }` for a try/finally.
