---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/ui": patch
---

The 3D world has screens and calendars on its walls. A big screen over the
lobby's kiosks shows your dashboard a widget at a time, and a click opens the
whole Board in a panel without leaving the world; a screen an agent hangs in
its own room shows what it is up to. Every home gets a calendar by the desk
with its owner's day (the wakes it booked, cron jobs that run as it, its own
turns, and what it got done today), and the lobby's calendar has everyone's
next wakes; a click opens the full list, where each agent is a step away.
New read-only route `GET /api/schedules` lists booked wakes, and `GET
/api/cron` says when each job next runs. The Board's recent-activity widget
now names the agent of each run and shows its time in your timezone.
