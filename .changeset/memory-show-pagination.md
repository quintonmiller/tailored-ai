---
"@tailored-ai/core": patch
---

Show all of an agent's core memory, not the first third of it.

`/memory show` clipped each section to 900 chars and the whole reply to 1700.
That made it useless for exactly the memories worth reading: a 2,328-char
persona came back as a third of itself, and asking for that one section did not
help, because the per-section clip applied either way.

Core memory is the text that shapes every one of an agent's turns. Two thirds
of it is worse than none, because it reads as complete.

Replies now split across as many messages as they need, using the same
`splitMessage` helper the chat path already used — extracted to
`channels/split-message.ts`, since importing it from `discord.ts`, which
imports the command modules, would have been a cycle. When a memory is large
enough to exceed even that, the reply says how many messages were withheld
rather than stopping silently.

`set` and `clear` also return the full prior text now. It was clipped at 1200,
which defeated the point of returning it — it is what you paste back to undo
the change.
