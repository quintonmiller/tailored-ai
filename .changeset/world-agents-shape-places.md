---
"@tailored-ai/core": patch
"@tailored-ai/ui": patch
---

Agents reshape their places to fit what they do. A room's members can go into its meeting room with the `place` tool and change it like their own; the first change keeps it, and it is drawn as they left it from then on. The `room` action sets a place's `theme` (beach, tavern, studio, workshop, library, or none), which beats the guess from its name, and its `purpose`, which the map shows. An opt-in tend pass (`tend: { every, agents }` in the places plugin's config) wakes each agent now and then, at a time of its own, with what it did lately and its room, to change the room if something should show it. In the 3D world a change grows or glides in with the agent's line about it over its head, the **Room** button shows a place's recent changes, and an agent's card can ask it to redo its room.
