---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/ui": patch
---

The 3D world has screens and calendars on its walls. A big screen over the
lobby's kiosks shows your dashboard a widget at a time, and a click opens the
whole Board in a panel without leaving the world; a screen an agent hangs in
its own room shows what it is up to. Homes get a calendar by the desk with
its owner's day (the wakes it booked, cron jobs that run as it, its own
turns, and what it got done today), and the lobby's calendar has everyone's
next wakes; a click opens the full list, where each agent is a step away. A
home someone changed keeps what it has, and `place` `look` tells its agent
how to add one. New read-only route `GET /api/schedules` lists booked wakes,
`GET /api/cron` says when each job next runs, and `GET
/api/exploratory/agents` says when each agent that runs on its own next
takes its turn, within its hours and its daily limit, the way the worker
decides. The Board's recent-activity widget now names the agent of each run
and shows its time in your timezone.
