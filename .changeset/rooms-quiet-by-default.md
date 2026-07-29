---
"@tailored-ai/core": patch
---

Rooms: posting stops being pinging, plus reactions and per-room roles.

- `OutboundRoomMessage.notify` (default false) separates writing to the record
  from interrupting a person. Addressing someone renders as plain `@name` —
  visible in the transcript, silent on their phone — and a real mention takes
  `notify: true`. Automatic replies never notify: an agent woken by a message is
  continuing a conversation, not raising something. (#276)
- `RoomBackend.react` + `capabilities.reactions`, surfaced as
  `room(action="react")`. "Got it" costs a turn, wakes watchers and pushes the
  room toward its depth cap for no information; a reaction carries the same
  meaning at none of that cost. It removes the reason to speak, where
  `maxAgentTurns` only caps how often agents may. (#269)
- A per-subscription `role` says what an agent is for in one room, under the
  room's `purpose`. The same agent coordinating a trip and reviewing code is not
  the same agent in both, and only its global instructions existed. (#270)
