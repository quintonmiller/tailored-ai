---
# autonomous-agent-wkx5
title: 'S7.6: Discord channel-to-project mapping'
status: todo
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:21:00Z
parent: autonomous-agent-bv73
---

## Goal
Discord channel → project mapping so messages from different channels land in different project sessions, all served by one bot.

## Config

```yaml
channels:
  discord:
    enabled: true
    token: ${DISCORD_BOT_TOKEN}
    projectMappings:
      - channel: "1234567890"     # discord channel id
        project: proj_abc123
      - dm: true                  # all DMs default to this project
        project: proj_xyz789
```

## Behavior
- On message receive, look up project from channel id (or DM fallback). No mapping → use global (project=null).
- Session key becomes `discord:<projectId|global>:<userId>`
- Agent loop runs with `cwd = project.path` and merged project config

## Slash commands
- `/tasks` already exists — scope to current channel's project
- New `/project` command shows which project the current channel maps to (read-only)

## Tests
- Mapped channel → session keyed with project, runs in project cwd
- Unmapped channel → global session unchanged
- Two channels mapped to same project → share project context but not session
