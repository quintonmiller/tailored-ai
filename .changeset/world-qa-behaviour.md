---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
"@tailored-ai/ui": patch
---

Fixes from a pass over the 3D world, each one something a person ran into.

- **What you type stays with its conversation.** A message half written, or
  written for you by a kiosk, an answer on a card or Redo its room, no longer
  carries over when the chat moves to another agent (a door, the map, Talk to,
  a card, the agent picker, the floating chat). Each conversation keeps its own
  words and attached files, and you find them again when you come back. Words
  written for an agent while a reply is still coming in wait with the switch
  instead of showing in the conversation the reply is coming into. A new chat
  that becomes a real conversation, by a typed or a spoken turn, keeps what is
  in the box and the tray.
- **Rooms are themed by whole words, and by weight.** "questions" is no quest
  and "building" no build, so "Research questions and keep a library of notes"
  is a library, not a tavern, and "quarterly-planning-and-review" stays plain.
  A word that means a look only in company (review, notes, campaign) calls for
  nothing on its own. "DnD" is still a tavern and "researchers" a library.
- **No startup warning for tools a plugin provides.** Agents' tool lists are
  checked once plugins have registered their tools, against the tools the
  runtime built, so `place`, `body` and `build` no longer draw "references tool
  … which is not enabled" on every start. A tool nothing provides still warns.
  Config writes check the same way after their reload when the host can say
  which tools there are (`ConfigWriteHost.getResolvableTools`, optional), and
  `validateConfig(config, { tools })` takes the tool names when a caller has
  them, or `tools: false` to leave references for `toolReferenceWarnings`.
  `runtime.toolWarnings()` is that check for a host to run once its plugins
  have registered, with a project overlay's own warnings tagged with the
  project; a reload's overlay check no longer guesses at tools.
- **Face to face beats the desk.** An agent that set off for its desk as its
  turn began turns round as soon as it messages someone near, walks over when
  they are more than three metres apart, and stays for the exchange; the other
  turning on the spot no longer holds it back.
- **A wall thing that won't fit says what to do.** The `place` tool says how
  wide it is, what is in the way, the `scale` it fits at, the one piece whose
  removal makes room, and another wall that has room or nearly does. Rooms
  drawn from a seed, which try spot after spot, skip that explanation
  (`findPlacement(..., { explain: true })` asks for it).
- **The Room card** says who changed a place, from its changes, apart from who
  can change it. **The agent card's** "Now" and "Last did" agree: a turn, however
  short, starts its idle time again.
- **Words:** a meeting seat's tag reads "sitting in on the meeting"; a copy
  shows to a person as "the vase of flowers", and its changes as "added another
  vase of flowers", "moved the other vase of flowers" or "removed a vase of
  flowers", whoever made them; `build` says when it saved a model under another
  name ("Saved as bad_name"); the map counts everyone a quiet room lists, people
  too, or the agents a room that keeps no list wakes ("3 subscribed"), with a
  body or not.
