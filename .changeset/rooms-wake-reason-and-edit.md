---
"@tailored-ai/core": patch
---

Rooms: `/room reset`, visible wake reasons, and editable messages.

- `/room reset agent:<name>` clears one agent's conversation for one room. A
  tool that was broken and then fixed does not help an agent whose history says
  it is broken — it stops trying, which is reasonable on bad evidence and
  impossible to argue it out of. Its read cursor is left alone, so it resumes
  from now rather than replaying what it just forgot. (#273)
- `RoomWatcher.wakeReason` reports why an agent woke — named, a loose question
  from a person, watching everything, or a scheduled check-in — and the activity
  record leads with it. The reason was always computed and thrown away, which
  made wake policy guesswork to debug. (#267)
- `RoomBackend.edit` + `capabilities.edit`, surfaced as `room(action="update")`.
  `post` now returns a message id. Rooms were append-only, so an agent checking
  in hourly posted an hourly notification whether or not anything had changed;
  one message that updates is quiet. Discord edits through the webhook that
  posted, since the bot cannot edit a webhook's message otherwise. (#268)
