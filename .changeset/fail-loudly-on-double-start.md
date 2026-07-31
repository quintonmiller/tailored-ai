---
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

Fail loudly, and early, when the HTTP port is already taken.

`serve()` registered no `error` listener, so `EADDRINUSE` surfaced as an unhandled event: the process died on a raw stack trace that never named the port or the likely cause. And the Discord gateway login, cron, autopilot and the room watcher all start *before* the HTTP bind, so a second instance started by mistake logged a second bot into the guild and fired cron for several seconds before the collision killed it.

- New `checkPortAvailable()` runs before anything with side effects, so a doomed start exits with a message instead of briefly standing up a duplicate bot.
- `start()` now handles the bind error itself, as a backstop for the case where something takes the port between the check and the real bind.
- `portInUseMessage()` names the port, says another instance is the likely holder, and points at `tai-ctl.sh status` / `switch`.

Two TAI instances share one port deliberately — it is the lock that keeps only one running — so a collision is an expected event that has to read as one.
