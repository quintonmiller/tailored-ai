---
# autonomous-agent-vo5b
title: validateConfig coverage for tasks/sandbox/prompts blocks
status: completed
type: task
priority: normal
created_at: 2026-05-04T00:14:18Z
updated_at: 2026-05-04T00:43:32Z
parent: autonomous-agent-6p6y
---

validateConfig() in config.ts currently checks agent tool refs, hook tool refs, cron agent refs, and default provider. The new config blocks added this session are not validated:

- `tasks.backend` must be one of: native, github, beans, beads
- `tasks.github.{repo, token}` required when backend = github
- `agent.sandbox` and `agents.<name>.sandbox` must be one of: host, docker, podman; warn that docker/podman are not yet implemented
- `prompts.maxIncludeDepth` must be a positive integer; `prompts.shellTimeoutMs` must be > 0

Surface these as warnings at startup so users get fast feedback on misconfigured values.
