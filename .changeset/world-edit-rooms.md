---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/ui": patch
---

You can rearrange a room in the 3D world yourself. **Edit room** in a home, a
shared place, a meeting room or the lobby steps the camera back to the whole
room: pick a thing and drag it (on a 10 cm grid, Shift for free), slide what
hangs on a wall along it, turn it with R, copy, repaint or remove it, and add
more from a catalogue of everything an agent can place. Where it fits shows
green and where it doesn't red, with the reason, by the same checks the
agents' `place` tool uses, so nothing ends up in a doorway or on top of
something else. Each change is saved to the place's record with its version,
as yours: the room's recent changes say "You moved the couch", the agent
whose room it is sees it the next time it looks, the redraw of untouched
homes never replaces it, and an agent's `undo` leaves it alone. Undo and redo
take back your own changes; if an agent changed the room meanwhile, you're
told who and shown the room as it is now instead of writing over it. The lobby's kiosks and task board can be moved but not removed. The
places plugin adds `GET /api/ext/builtin:places/edit/kinds` and
`POST /api/ext/builtin:places/edit`, and its scene routes now say what a write
needs (`version`, `scope`, `editable`, `lent`). World-state deletes take an
`expectedVersion`, as writes do (`StateService.delete`, the providers'
`delete`, and `DELETE /api/state/:type/:id?expectedVersion=`), so a delete
never takes someone else's change with it.
