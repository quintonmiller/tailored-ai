---
# autonomous-agent-sj5u
title: 'S5.4: Step types — agent_run + tool_call'
status: completed
type: task
priority: high
created_at: 2026-05-04T01:08:16Z
updated_at: 2026-05-04T03:13:35Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-47tt
---

Implement the two highest-value step types. agent_run delegates to runAgentLoop with an ephemeral session keyed workflow:<run>:<step>. tool_call resolves the tool from runtime.getTools() and invokes execute(). Tests for both: linear agent_run flow, tool_call success/failure.
