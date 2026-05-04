---
# autonomous-agent-rndc
title: 'S5.10: Autopilot workflow integration (opt-in)'
status: completed
type: task
priority: low
created_at: 2026-05-04T01:08:17Z
updated_at: 2026-05-04T03:28:30Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-c81v
---

When a project task has a 'workflow:<name>' tag and the named workflow exists, AutopilotWorker invokes it instead of runAgentLoop. Input is { task, agent }. Existing autopilot path keeps working when no tag is set.
