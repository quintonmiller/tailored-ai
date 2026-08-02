---
"@tailored-ai/core": patch
---

Fix two things `/room rewind` got wrong on first real use.

**The rewind was handed straight back.** A room's wake prompt is built from the
backend's messages — `fetchSince(roomId, sub.cursor)` — not from the session.
Rewinding only the session hid the exchange from the agent's memory and then
re-fed it as "New messages:" on the very next wake, the agent's own last post
included. Observed in production: an agent quoted the message it had just been
made to forget. The rewind now moves that room's cursor to the newest message,
so nothing taken back comes back.

Only the cursor for the room the command was run in moves. A shared-scope agent
has one memory across several rooms, but advancing every cursor would silently
drop genuinely unread messages from rooms nobody asked about.

**The excerpt quoted boilerplate.** A room turn's `user` message is a whole
constructed prompt — identity preamble, room purpose, new messages, reply
instructions — and the preamble is byte-identical on every turn in a room. So
the quote came back as

    > Room "eng". You are planner. Today is …

which told you nothing about where the cut landed, the only thing the excerpt
is for. It now quotes the messages block and falls back to the raw text for
turns that are not room prompts.
