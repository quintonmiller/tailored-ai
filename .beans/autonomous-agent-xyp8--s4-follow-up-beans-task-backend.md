---
# autonomous-agent-xyp8
title: 'S4 follow-up: beans task backend'
status: todo
type: task
priority: normal
created_at: 2026-05-03T22:54:30Z
updated_at: 2026-05-03T22:54:30Z
parent: autonomous-agent-qrlk
---

Implement packages/core/src/tasks/beans.ts as a shell-out wrapper over the beans CLI (already used in this repo). Map: type=task/bug to plain tasks; status todo↔backlog, in-progress↔in_progress, completed↔done; priority is separate. Use 'beans list --json --ready' for nextBacklogTask. claimBacklog = update status to in-progress with optimistic etag. unblockBudgetTasks: use a 'budget' tag.
