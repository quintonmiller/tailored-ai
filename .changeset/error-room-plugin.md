---
"@tailored-ai/core": patch
---

Add `builtin:error-room` — forward runtime errors to a room so an agent can triage them.

Errors that only reach the log get found by accident, days later, usually
because something else looked wrong. This posts them into a room instead, where
a subscribed agent can read the error, look at what it names, and say what it
thinks is wrong.

Three things are designed in rather than bolted on, because each would
otherwise be worse than the problem:

- **Reporting an error cannot cause an error.** A re-entrancy flag means
  nothing logged while reporting is itself reported. Verified against a backend
  that fails *and* logs on every post: one attempt, no recursion.
- **A flood cannot reach Discord.** Identical errors collapse to one entry with
  a count, batches post on an interval, and a per-hour ceiling replaces the
  overflow with a count of what was withheld. Repeats route through the
  existing NotificationGate.
- **Credentials are redacted** before anything leaves the process — `key=value`
  secrets, bearer tokens and JWT-shaped strings.

Config: `{ module: "builtin:error-room", config: { room, notify, levels,
batchSeconds, maxPerHour, maxPerReport, ignore } }`.
