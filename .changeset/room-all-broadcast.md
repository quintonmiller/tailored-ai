---
"@tailored-ai/core": patch
---

`/room all <message>` — say something to every agent in a room

There were two ways to reach agents from Discord and neither did this. `/room
ping` sends your words to one agent. `/room status` reaches everyone but asks a
fixed question and deliberately leaves nothing in the transcript. Saying an
arbitrary thing to the whole room meant pinging them one at a time.

`/room all message:…` posts your message into the room addressed to every
subscriber whose `wakeOn` is not `none`.

**Addressing them by name is the point.** An agent on `wakeOn: named` or
`addressed` does not stir for a message that names nobody, so typing in the
channel reaches only the `wakeOn: all` subscribers. Naming everyone is what
makes it a broadcast.

Because it goes through the room as an ordinary post rather than waking agents
directly, everything else applies unchanged: `room(action="pass")` still lets an
agent stay quiet, repeat suppression still holds, and the conversation-depth
counter resets because a person really did speak — no special-casing needed.

Unlike `status`, the message appears in the transcript under your name. That is
not the line `status` avoids crossing: these are genuinely your words, so
attributing them to you is accurate rather than putting words in your mouth.

Agents on `wakeOn: none` are excluded from both the addressee list and the "sent
to N" count — they would not hear it, and counting them would make the
confirmation a claim the command cannot back. When *every* subscriber is
`wakeOn: none` it says so instead of posting, because "nobody is here" and
"everybody is deaf" need different fixes.

Two defects found by adversarial review of this change and fixed here. Both
predate it — `ping` and `status` had the first one too:

- **A failed `/room` subcommand said nothing and logged nothing.** The error
  handler called `interaction.reply()` unconditionally, which discord.js rejects
  once an interaction is deferred or replied, and that rejection was swallowed
  by an empty `.catch()`. A failing `ping`, `all` or `status` left the user on a
  "thinking…" spinner forever with no error text anywhere — and the comment
  saying it was "logged upstream" was wrong. It now branches on the interaction
  state and always logs the original error first.
- **`/room all` could report "Sent to N agent(s)" while waking nobody.** A room
  message is parsed back out of Discord as an envelope, and a name is only
  accepted as the speaker when the identity layer knows it. Run from an account
  with no `rooms.identities` entry, the message can return with no speaker and
  `fromSelf: true`, which the wake logic drops for every subscriber before it
  looks at who was addressed. The command now warns when it cannot resolve the
  caller and prints the exact config line to add. Same condition means the
  conversation-depth reset only holds for a recognised speaker — the docs said
  otherwise and have been corrected.
