---
"@tailored-ai/core": patch
---

Rooms: choose whether an agent remembers each room separately or all together, and make task ownership legible.

`agents.<name>.roomSessionScope` is `room` (default, a session per room) or
`shared` (one session across every room). Per-room isolation means an agent
moved into a new room starts blank; `shared` lets an assistant carry a thread
between places, at the cost of mixing unrelated context and growing history with
the number of rooms rather than the conversation.

`task_query` gains `mine`, which scopes to the calling agent, and every result
now states ownership — `yours`, `assigned to X`, or `unassigned (not yours)`. An
unassigned task previously rendered as bare text, so "no assignee" read as "no
information": eleven agents freshly added to a channel each reported the same two
unassigned personal tasks as their own in-flight work. Session history cannot
answer "what am I working on" because it is per-room; durable state has to.
