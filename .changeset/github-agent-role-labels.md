---
"@tailored-ai/core": patch
---

GitHub task backend routes TAI agent-role assignees (coder, reviewer,
planner, etc.) through `agent:<role>` labels instead of GitHub's
`assignees` API. GitHub rejects `assignees: ["coder"]` with 422 because
"coder" isn't a real collaborator, which previously prevented the
backend from creating any task assigned to an agent role.

- New `tasks.github.agentRoles` config option to extend the built-in
  set of agent names (defaults cover the standard TAI agents).
- Real GitHub usernames still go through the assignees API.
- Reads round-trip cleanly: `toTask` prefers the `agent:*` label, falls
  back to the first GH assignee.
- `query` and `nextBacklogTask` filter by label when the requested
  assignee is an agent role.
