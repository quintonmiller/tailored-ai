---
'@tailored-ai/core': patch
'@tailored-ai/ui': patch
---

A commitment's `nextCheck` is now read as a time or a change to watch for. With the directory on (`builtin:directory`), the `commitment` tool reads it as it's written and says what it made of it, the way `schedule` echoes a booking: "Friday 9am", "in 2 days" or "2026-10-28" become a moment in the runtime's time zone ("Check: Fri, Oct 23, 09:00, in 22h."), and "when plan/lisbon changes", "when plan changes" or "when a booking changes where status=confirmed" become a change to watch for, with a backstop a week out. Anything else stays a note: the update still goes through, and the reply says nothing will wake the agent for it and lists the forms that would. A change can only be one the agent it wakes can read. What the directory reads is kept beside the text in new commitment fields, `checkAt` (UTC), `checkOn` (`{ type, id?, where? }`), `checkedAt` and `checkEvents`, and they follow the text: a person's edit of `nextCheck` on the State page, the agent's page or a room's page is read again the same way. On a room's commitment, a person's `nextCheck` holds like their other edits; the fields beside it never do. Commitments written before this keep their text with nothing beside it until it's next written.

The agent page's Working on list shows how far off each check is (or "(a note)" for text nothing wakes the agent for) and when it was last checked, and pressing the check changes it. A room's page shows the same, and its Edit form takes the next check; `PATCH rooms/:room/commitments/:id` accepts `nextCheck`.

`schedule`'s `when` (and so a check's time) also takes a weekday: "friday", "friday 9am", "mon at 14:00", "next friday", meaning the next one whose time is still ahead, 09:00 when no time is given.
