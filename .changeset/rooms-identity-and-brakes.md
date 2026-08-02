---
"@tailored-ai/core": patch
---

rooms: one name per person, honest `/room reset`, and brakes that fit the room

Found by reading what the agents actually did rather than the code:

- **One person, one name.** A declared human identity now replaces the implicit
  `owner` instead of sitting beside it, matched on transport account id, and
  slash commands stamp that label rather than the raw Discord username. Agents
  were shown `owner` and `alex` for one human, read `@discorduser` in the
  transcript, and got `Unknown participant(s): discorduser` from a validator that
  had never heard of it.
- **`/room reset` clears the session the agent is using.** It built the key
  without asking for the agent's session scope, so with `roomSessionScope:
  shared` it wiped an abandoned per-room session, reported that session's message
  count, and left the live one untouched. The reply now says which memory went.
- **An agent's own posts are condensed in its wake transcript.** They are already
  in its session as the reply it just made; one observed prompt was 6.4 KB, two
  thirds of it the agent quoting itself.
- **Per-room `maxWakesPerHour` / `maxAgentTurns`**, because a coordination room
  and a weekly ideas channel cannot share one number. A wake that produced no
  post and no tool call is refunded — what makes a runaway expensive is replying.
- **A room that fails three times in a row is left alone for thirty minutes.** A
  ref pointing at a deleted channel retried forever. Nobody is unsubscribed.
- **One reply path.** Status updates and check-ins ran a copy that lacked the
  malformed-`pass` correction and the tool-activity record.
