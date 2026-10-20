---
'@tailored-ai/core': patch
'@tailored-ai/ui': patch
---

Agents make things for the 3D world: an opt-in `build` tool (`build: true` in the places plugin's config) makes
models from simple parts (boxes, cylinders, spheres, cones, tori, capsules and plates, each with a size, place,
turn, colour and finish), kept as `model` world-state records, which the `place` tool adds to a room by name. A
box or a plate can carry a face: a list of records to tick, a card with buttons that write its record, or a table,
made a real interface component as the agent, so people use it in the room and the record changes as theirs; its
picture from across the room follows the records. Three ready-made models (a to-do board that done to-dos leave,
a habit tracker that starts each morning unticked and counts streaks, a notes card) any agent can place, and Edit
room's catalogue lists models under "Made by agents", the room's own agents' first.

A card bound to a record can now name which of the record's fields it shows (`bind.fields`) and one to show as
its text (`bind.body`), in the web UI and on Discord alike.
