---
"@tailored-ai/core": patch
---

De-role the task watcher: no more hardcoded `coder`/`reviewer` agent names or
personal workflow preambles in core (#204).

What moved where:

- New `AgentDefinition` fields: `worktree?: boolean` (task-watcher dispatches
  to this agent run in an isolated git worktree on a per-task branch) and
  `taskPreamble?: string` (a prompt template prepended to dispatch prompts,
  expanded with `task_*`, `action`, `project_id`, `owner_name`,
  `worktree_path`, `worktree_branch`). Both are surfaced on `ResolvedAgent`
  and parsed for registry-defined agents.
- `TaskWatcher` keys worktree creation off the resolved agent's `worktree`
  flag instead of `agentName === "coder" || "reviewer"`, and prepends
  `taskPreamble` (when set) instead of the two ~115-line hardcoded
  coder/reviewer preambles, which are deleted. New runtime helpers
  `getAgentDefinition(name)` and `getWorktreeAgentNames()`.
- GitHub task backend no longer ships `DEFAULT_AGENT_ROLES` (the personal
  email-fetcher/classifier/planner/... list). The factory now derives the
  agent-role set from `config.agents` keys + `config.taskWatcher.agent` +
  `tasks.options.agentRoles`. The `agent:<name>` label mechanics are unchanged.
- `builtin:coder-project-guard` (id kept for config compatibility) now guards
  the worktree-opted agents (or an explicit `agents: string[]` from its config
  bag) rather than the names coder/reviewer.
- `builtin:scope-creep-flagger` now watches worktree-opted agents and fires on
  handoff to a different configured agent; configurable via `watchAgents` /
  `reviewerAssignee`.
- `builtin:stall-guard` blocked-reason uses the actual agent name
  (`<name>-stalled`) instead of the literal `coder-stalled`.

BREAKING (behavioral) for installs that relied on the names `coder`/`reviewer`:
those agents no longer get an automatic worktree or role preamble. To restore
the old behavior, add `worktree: true` and a `taskPreamble:` to each of those
agents in your config, and (if you use the GitHub backend) make sure the agent
names appear under `agents:` so they keep routing to `agent:<name>` labels.
