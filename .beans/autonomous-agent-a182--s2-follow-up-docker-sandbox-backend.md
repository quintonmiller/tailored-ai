---
# autonomous-agent-a182
title: 'S2 follow-up: Docker sandbox backend'
status: todo
type: task
priority: high
created_at: 2026-05-03T22:59:31Z
updated_at: 2026-05-03T22:59:31Z
parent: autonomous-agent-objy
---

Implement packages/core/src/sandboxes/docker.ts. Use docker CLI shell-out (avoid extra runtime deps). prepare(): `docker run -d --rm --network=host -v cwd:/work -w /work --entrypoint sleep <image> infinity` to keep a long-running container; mount any extra mounts from opts. exec(): `docker exec -w /work <id> bash -c <cmd>`. cleanup(): `docker rm -f <id>`. readFile/writeFile via `docker cp` or via the bind-mount path. Image name configurable via tasks.docker.image.
