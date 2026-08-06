---
"@tailored-ai/core": patch
---

Rooms can be archived. A room could be opened three ways and closed none, so a
finished one kept its poll and check-in timers, kept a line in every `room list`
an agent reads, and held its name against the next room that wanted it.

`room(action="archive")` and `/room archive` retire a room without destroying
it: it stops waking anyone, refuses posts, and releases its name — while keeping
its messages and every subscription's cursor, role and cadence, so `unarchive`
gives the room back rather than an empty channel. Announced in the room by
`builtin:room-announcer`, since archiving silences everyone else in it.

Room names are now unique among live rooms only, so archiving `trip` frees the
name for the next one. Config gains `rooms.rooms[].archived` as a tri-state:
`true` archives, `false` reopens, and omitting it leaves the stored state alone.
