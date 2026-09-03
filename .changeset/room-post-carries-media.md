---
"@tailored-ai/core": patch
---

Carry a turn's media when an agent posts to a room

`OutboundRoomMessage.media` has existed since rooms shipped: documented, typed,
and honoured by backends, which are told to drop it and post the body alone when
they cannot render files. Nothing ever put anything in it.

So an agent that generated audio and then called `room(action: "post")` sent the
sentence and left the file behind. The render ladder had no `MediaRef` to work
with, so there was no attachment and nothing to turn into a link — while the
same agent replying through the room *watcher* got its media attached, because
that path calls `collectTurnMedia`. Media worked on one outbound route and
vanished on the other.

Observed in a live deployment: the agent noticed, apologised for it, and
worked around it by typing the `[audio: … #id]` placeholder into its own message
body to force the ladder to resolve a link.

`post` now collects the media produced since the turn began and passes it. The
watermark is `turnStartId` (new, exported): the tool runs mid-turn and cannot be
handed a before-the-turn watermark, so it takes the newest `user` message as the
boundary — every turn starts with one, real or synthesised by a room wake.
