---
"@tailored-ai/core": patch
---

Every agent turn is now bracketed on the event bus by `agent.turn_started` and `agent.turn_ended`, whichever surface ran it, with why the turn ended or the error it threw. World state gains a built-in `memory` provider for records that only matter while they last: kept in the process, with a short history, and queried exactly as SQLite would.
