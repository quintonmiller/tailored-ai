---
"@tailored-ai/core": patch
---

rooms: `dm` delivers straight to an agent instead of opening a channel for it

Shared sessions took the room's second job away — `room:all:<agent>` does not
reference a room — so materialising a Discord channel to carry one message was
pure overhead, and at 27 agents it was 27 channels waiting to happen. `dm` now
hands the message to the recipient and returns its reply; the exchange lands in
the recipient's session, so it stays durable and inspectable without being a
place. `rooms.desks` becomes an opt-in mirror for a direct line you want to read.
