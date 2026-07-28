---
"@tailored-ai/core": patch
---

Rooms: parent messages, visible tool activity, and correction rounds.

- `OutboundRoomMessage.parentId` says a message belongs underneath another;
  `capabilities.threads` says whether a transport can render that. Discord opens
  a thread on the parent. The seam does not know what a thread is, so a
  transport that nests differently is not forced into Discord's shape.
- `rooms.toolActivity` (`none` | `mutations` | `all`) attaches an agent's tool
  calls under its reply. Each line names the tool and the argument identifying
  its target, never the full arguments — those carry file contents and search
  bodies. Reads are included under `all` because a wrong answer usually traces
  to what was read.
- A written-out `room(action="pass")`, and a pass after changing files, each get
  one correction round instead of being silently suppressed or overridden. The
  agent is told what looked wrong and decides; asking beats overriding, and a
  single attempt keeps a weaker model from spending its budget being corrected.
