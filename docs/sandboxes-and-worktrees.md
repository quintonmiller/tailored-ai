# Sandboxes & Worktrees

How tool side-effects are isolated (host / docker / podman) and how the worktree helper runs agents on an isolated branch.

## Sandboxes

Tool side-effects (shell, file IO) can be routed through a `Sandbox` defined in `packages/core/src/sandboxes/interface.ts`. Three built-in backends ship in core; plugins may add more through the sandbox factory registry.

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

## Sandbox factory registry

The sandbox backend is registry-backed: `sandboxFactoryRegistry` in `packages/core/src/sandboxes/factory.ts` holds `string → SandboxFactory` entries. `createSandbox` looks up the kind there, throwing a clear "Known: …" error on an unknown id — the same pattern used by task backends and repo backends.

Built-ins (host / docker / podman) register themselves on module load at the bottom of `packages/core/src/sandboxes/factory.ts` — colocated with the registry (the `providers/factories.ts` pattern) so any importer of `createSandbox` sees them. They are not privileged; they go through the same `registerSandboxFactory` call a third-party plugin uses.

The `sandbox` config field is an open `string` — new kinds registered by a plugin work without any change to the config type or `validateConfig`. The only static checks that remain in `validateConfig` are the "docker/podman imageName not set" guards, which are config-time detectable for the built-ins.

### Registering a custom sandbox kind

From a TAI plugin:

```ts
import type { Plugin } from "@tailored-ai/core";

export default ((ctx) => {
  ctx.sandboxBackends.register("firecracker", (config) => {
    const opts = config.sandboxes?.firecracker as { kernelImage?: string } | undefined;
    return new FirecrackerSandbox({ kernelImage: opts?.kernelImage ?? "vmlinux" });
  });
}) satisfies Plugin;
```

Then in `config.yaml`:

```yaml
agent:
  sandbox: firecracker
sandboxes:
  firecracker:
    kernelImage: /path/to/vmlinux
```

`FirecrackerSandbox` must implement the `Sandbox` interface from `@tailored-ai/core`.

You can also register directly without a plugin context:

```ts
import { registerSandboxFactory } from "@tailored-ai/core";

registerSandboxFactory("my-sandbox", (config) => new MySandbox(config));
```

## Worktrees

`packages/core/src/worktree.ts` is a thin wrapper over `git worktree` for running an agent in an isolated branch and merging back. Built for the workflow runner (S5) but usable directly.

```ts
import { createWorktree } from "@tailored-ai/core";

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
