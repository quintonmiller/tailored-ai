---
# autonomous-agent-a182
title: 'S2 follow-up: Docker sandbox backend'
status: completed
type: task
priority: high
created_at: 2026-05-03T22:59:31Z
updated_at: 2026-05-04T00:19:19Z
parent: autonomous-agent-objy
---

Implement packages/core/src/sandboxes/docker.ts. Use docker CLI shell-out (avoid extra runtime deps). prepare(): `docker run -d --rm --network=host -v cwd:/work -w /work --entrypoint sleep <image> infinity` to keep a long-running container; mount any extra mounts from opts. exec(): `docker exec -w /work <id> bash -c <cmd>`. cleanup(): `docker rm -f <id>`. readFile/writeFile via `docker cp` or via the bind-mount path. Image name configurable via tasks.docker.image.

## Summary of Changes

- New `packages/core/src/sandboxes/docker.ts`: `DockerSandbox` implementing the full `Sandbox` interface via the docker CLI.
  - `prepare()` runs `docker run -d --rm -v <cwd>:/work -w /work --entrypoint sleep <image> infinity`. Provider-level mounts/env merge with prepare-level ones; readonly mounts and host-network supported.
  - `exec()` runs `docker exec -w <cwd> [-e KEY=VAL...] <id> bash -c <cmd>`.
  - `readFile/writeFile` read/write through the host bind-mount path (no `docker cp`).
  - `cleanup()` runs `docker rm -f <id>`; failures are logged, not thrown.
- Constructor accepts an injected `runner: DockerRunner` (covered by T12). Default runner uses `execFile('docker', ...)`.
- New `sandboxes.docker.{imageName, mounts, env, network, sandboxWorkdir}` config block. `createSandbox` factory dispatches on `sandbox: docker` and instantiates from config.
- 13 tests in `__tests__/docker-sandbox.test.ts` using a fake runner: prepare args, mount/env merging, error paths, exec args, file IO, cleanup error swallowing. No live Docker required.
- All 210 tests pass; full monorepo typechecks. CLAUDE.md "Sandboxes" section updated with the docker config example.

## Out of scope (deferred)

- Live Docker integration test (would need a daemon; environment-specific).
- `docker cp` fallback for files outside the bind mount.
