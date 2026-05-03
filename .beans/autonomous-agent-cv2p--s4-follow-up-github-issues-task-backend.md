---
# autonomous-agent-cv2p
title: 'S4 follow-up: GitHub Issues task backend'
status: todo
type: task
priority: high
created_at: 2026-05-03T22:54:30Z
updated_at: 2026-05-03T23:51:44Z
parent: autonomous-agent-qrlk
---

Implement packages/core/src/tasks/github.ts. Decision: gh CLI shell-out vs @octokit/rest — start with octokit (typed; no system dependency). Status mapping: open ↔ backlog/in_progress/blocked (via labels), closed ↔ done. Autopilot helpers (claimBacklog, nextBacklogTask, unblockBudgetTasks) need a labeling convention since GH lacks a 'rank' field — use issue number as rank, and a 'budget-blocked' label for the unblock helper.
