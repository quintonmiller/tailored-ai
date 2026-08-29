---
"@tailored-ai/core": patch
---

Rooms carry attachments, in and out.

A room was text and only text: `RoomMessage.body` was a plain string, and the
Discord rooms backend built every inbound message from `msg.content` without
ever looking at `msg.attachments`. Dropping a screenshot into a room channel
therefore reached nobody — and said so to nobody, because the text still
arrived. An image posted with no caption produced an empty message, so the
agent saw nothing at all.

The DM and @mention paths had none of this problem, which made it invisible: the
same picture in a DM worked. The split was that registering a room makes the
mention path stand down for that channel, and the rooms path that replaces it
was written before media existed.

`RoomMessage.media` and `OutboundRoomMessage.media` now carry `MediaRef`s, and
`RoomCapabilities.media` says whether a transport has the concept — a required
field, so every backend has to answer rather than inherit a default. Both
built-in backends support it: the local one stores refs in a new nullable column
(`ALTER TABLE` is metadata-only, so no existing row is rewritten), and Discord
captures attachments into the media store on the way in and uploads them on the
way out.

Capture happens in `fetchSince` and nowhere else, because every path that builds
a transcript an agent will read goes through it — the push listener only decides
whether to wake someone — and messages with no attachment pay nothing. Bytes are
fetched at read time rather than referenced: a Discord attachment URL expires
well before an agent wakes on a backlog and follows it.

Outbound, files ride the last non-empty chunk of a split message, so a long post
does not show its picture above the text that introduces it, and an
attachment-only post still sends. On the way in, each attachment is also named
in the transcript against its own line — that is what says which message an
image belongs to, and it is what survives once the history budget evicts the
picture itself.

A wake carries at most `MAX_WAKE_MEDIA` (4) images, newest first, skipping the
agent's own posts and deduplicating by content address. The loop prices a media
part at 1,500 tokens, so an uncapped room that took twenty screenshots between
wakes would spend its whole history budget on pictures and evict the
conversation explaining them.
