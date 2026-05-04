---
# autonomous-agent-47tt
title: 'S5.3: Workflow engine core (sequential exec + variable threading)'
status: todo
type: task
priority: high
created_at: 2026-05-04T01:08:16Z
updated_at: 2026-05-04T02:43:02Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-6vw5
---

runWorkflow(name, input) executes steps sequentially. Threads input/steps/prev/env through expandPrompt. Records each step transition in workflow_steps before invoking. Honors per-step deadlineMs and onError policies (fail/continue/retry). No step types yet — pluggable executor registry.



## Concurrency caps (resolved 2026-05-04)

The engine holds two semaphores:
- workflow-level **run gate** sized by config.workflows.maxConcurrent (default 4) — acquired when a run leaves 'pending', released when the run terminates.
- per-agent **agent gate** sized by config.workflows.maxConcurrentByAgent[<name>] (with a _default fallback) — acquired on entry to each agent_run step, released in the step's finally block.

Steps blocked on the agent gate stay in 'pending' with a 'blocked_on: agent:<name>' annotation so the UI can surface the queue.

## Cancellation (resolved 2026-05-04)

Cancel sets a flag the engine checks between steps and (for agent_run) between tool rounds. shell steps get a 30s grace window after SIGTERM before SIGKILL. agent_run is a no-op cancel until the loop's next iteration boundary; do not interrupt in-flight provider calls.
