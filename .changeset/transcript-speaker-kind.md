---
"@tailored-ai/core": patch
---

Transcript lines say what kind of speaker wrote them.

`IdentityResolver` decides whether a room participant is an agent, a person, or
nobody it recognises, and the room subsystem already uses that to decide wake
and pause policy. It was discarded at render time, so a person's instruction and
another agent's text reached the model as identical `role: "user"` bytes.

Lines now read `planner [agent]:`, `quinton [person]:`, `drive-by
[unrecognised]:`. Volatility decides where a block goes in a request;
authorship decides how much weight it should carry, and nothing downstream — a
prompt slot, a history composer, or the model — could express the second while
the format did not carry it.

Three properties this relies on: the marker is written by core from the resolved
identity and never from message text; it appears on every line, because a marker
that appears sometimes makes its absence meaningful; and an unresolved label
renders `[unrecognised]` rather than falling through to a bare name, since that
is the case that matters most.
