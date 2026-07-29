---
"@tailored-ai/core": patch
---

Add `agents.<name>.fileBoundary` and room check-ins.

**`fileBoundary`** confines one agent's file and exec tools to a directory,
reusing the enforcement the task watcher already applies to coder/reviewer
worktrees. Needed because `tools.write.allowedPaths` is deployment-wide:
granting an agent `write` otherwise grants the whole filesystem, which is a poor
trade for an agent that reads untrusted web content. A leading `~` is expanded,
since the check is a path-prefix comparison and an unexpanded tilde would
confine the agent to a directory that does not exist.

**`checkInMinutes`** on a room subscription wakes an agent on a timer even with
no new messages, so it can act on time passing rather than only on being spoken
to. Agents set their own through `room(action="subscribe", check_in_minutes=N)`.
The check-in prompt offers `pass` first and asks for speech only when something
needs attention — a scheduled "nothing to report" is the politeness loop with a
clock attached. Floored at 5 minutes; the hourly wake ceiling still applies.
