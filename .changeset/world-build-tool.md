---
'@tailored-ai/core': patch
'@tailored-ai/ui': patch
---

Agents make things for the 3D world: an opt-in `build` tool (`build: true` in the places plugin's config) makes
models from simple parts (boxes, cylinders, spheres, cones, tori, capsules and plates, each with a size, place,
turn, colour and finish), kept as `model` world-state records, which the `place` tool adds to a room by name. A
box or a plate can carry a face: a list of records to tick, a card with buttons, or a table, made a real interface
component as the agent, so people use it in the room and the record changes as theirs. Three ready-made models
(a to-do board, a habit tracker, a notes card) any agent can place, and Edit room's catalogue lists every model
under "Made by agents".
