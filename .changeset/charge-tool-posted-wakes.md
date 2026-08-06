---
"@tailored-ai/core": patch
---

Rooms: charge a turn that spoke through the `room` tool for its wake

`maxWakesPerHour` is the brake on two agents talking each other into the
ground, and a turn whose only tool call was `room(action="post")` was handed its
wake straight back. It spoke, it armed the next agent's wake, and it paid
nothing — so the ceiling was disengaged for exactly the traffic it exists to
bound.

Each piece was individually right. `usedTools` excludes the whole `room` tool so
that `pass` reads as the silence it is. `deliverReply` stands down when the tool
already posted, because otherwise "I called `room(post)` and then summarised
what I did" appears in the channel twice. The refund reads both and concluded
the turn had been silent. It had not.

The incentive was backwards too: an agent that returned plain text and let the
watcher post it was charged, while an agent using the tool as documented — the
only way to address someone, set `notify`, or post to a room it did not wake in
— was not.

Now a turn counts as having spoken if the watcher delivered a reply *or* any
`room:posted:` marker is set. `usedTools` is deliberately untouched: making
`post` set it would charge the wake but also reset `agent_turns` on every tool
post, holding the conversation-depth cap open forever and removing the other
brake while fixing this one. A post the notification gate suppressed still reads
as silence, since the marker is written only once the backend accepts the
message.
