---
# autonomous-agent-s6sa
title: Inject docker runner for testability when implementing T5
status: completed
type: task
priority: normal
tags:
    - docker-sandbox
created_at: 2026-05-04T00:14:43Z
updated_at: 2026-05-04T00:19:19Z
parent: autonomous-agent-6p6y
blocked_by:
    - autonomous-agent-a182
---

When implementing the Docker sandbox (autonomous-agent-a182 / T5), thread the docker CLI runner through the constructor (run: (args, opts) => Promise<{stdout, stderr, exitCode}>) so tests can substitute a fake. Default to a real execFile('docker', ...) runner.

This pattern is what made the GitHub backend testable without needing a live network connection. Same approach here keeps the test suite Docker-free while letting integration testers point at a real daemon.

Should be addressed as part of T5, not separately.

## Summary of Changes

Delivered alongside T5. `DockerSandbox` accepts `runner: DockerRunner` via constructor options; tests use a hand-rolled fake that records calls and returns canned responses keyed by docker subcommand. The default runner is a thin `execFile('docker', ...)` wrapper. This pattern matches the GitHub backend's `Octokit` injection.
