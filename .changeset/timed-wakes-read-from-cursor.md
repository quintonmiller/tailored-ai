---
"@tailored-ai/core": patch
---

Timed wakes read from the cursor instead of re-sending the same messages for ever.

Check-ins and self-booked scheduled wakes fetched a room with `cursor: null`,
took the last ten messages, rendered them into a prompt, and never advanced the
cursor. The rendered prompt is persisted to the session, so in a quiet room every
firing stored another copy of the same block.

Measured on a production deployment: 124 check-in prompts in one session
collapsing to 23 distinct bodies, a single 1,115-token block stored 23 times, and
roughly 89% of all duplicated prompt content in the database traceable to these
two call sites. The message-wake path, which already read from the cursor and
advanced it, produced almost no repeats — so this was cursor discipline rather
than anything structural.

Both paths now read from the cursor and advance it, like every other wake. A
check-in is told what arrived since it last looked, and when nothing did it is
told exactly that, which is both cheaper and more useful than being handed
messages it has already acted on with nothing marking them as old.

No context is lost. Earlier wakes leave the room's history in the agent's own
session, and a first-ever wake still has a null cursor and still receives the
backlog.
