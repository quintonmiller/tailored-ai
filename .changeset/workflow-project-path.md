---
"@tailored-ai/core": patch
---

**Fix:** Workflow steps now anchor to the active project root instead of the server's `process.cwd()`. The `WorkflowEngine` snapshots `runtime.getActiveProject()?.path` at the start of every run and threads it onto each step's `StepContext.projectPath`. The `shell`, `tool_call`, and `worktree` executors and the run-level sandbox `prepare` all prefer this over their constructor-default cwd, so a workflow launched from any directory (CLI, channel, cron, HTTP) runs against the intended project files. Explicit `step.cwd` / `worktree.repoDir` continue to win. The path is captured once per run, so `setActiveProject` mid-run doesn't reroute in-flight steps. Closes #64.
