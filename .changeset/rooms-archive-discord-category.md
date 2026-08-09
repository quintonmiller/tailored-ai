---
"@tailored-ai/core": patch
---

Archived rooms can be filed under a Discord category. Set
`channels.discord.archiveCategory: Archived` and archiving a room moves its
channel there; restoring puts it back in whatever category it came from.

The channel is moved, not locked or hidden — people can still read it and still
talk in it, which is the point of keeping the record. Moving never resyncs
permissions to the new category: discord.js does that by default, and since room
membership is derived from channel permission overwrites, accepting it would
erase the room's roster as a side effect of tidying the sidebar.

Unset by default, so archiving leaves channels exactly where they are. The move
needs Manage Channels and is best-effort — if it fails the room is still
archived, with one warning in the log.

Adds the `RoomBackend.archiveRoom?()` seam and `RoomCapabilities.archive`, which
reports false both when a transport cannot file rooms and when nobody configured
it to. Backends can park opaque state across an archive via
`RoomStore.getBackendState` / `setBackendState`.
