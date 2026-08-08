---
"@tailored-ai/core": patch
---

Let an agent see every room it watches, not just the one that woke it

A wake prompt names one room and carries that room's new messages. For an agent
in one room that is everything; for an agent in six it is a keyhole, and the
conversations it has open elsewhere are invisible unless they happen to have
spoken last.

`rooms.crossRoomView` (off by default) adds a per-turn block: N lines across all
rooms, a floor of M for each room the agent is not answering in, the current
room marked and taking the remainder. Floors are paid first, so a busy room
cannot crowd out a quiet one. Other rooms' slices are cached for
`cacheSeconds` — otherwise every watched room is a backend round trip on every
turn — while the current room is always fresh.

It renders through a `turn` context slot rather than the wake prompt, so it sits
behind the history and never enters the conversation record. The wake prompt is
persisted as the record of what the agent was asked, and a re-rendered view
stored as a record is what puts one block in a session twenty times over.

Enabling it also adds a short standing paragraph, in the system prompt, telling
an agent in several rooms how to reach the others. Without it a 27B model asked
in one room to tell someone in another something invented `[message to dana]` as
a reply prefix and sent it to the wrong room. The `room` tool could always do
it; nothing said so.
