---
'@tailored-ai/core': patch
'@tailored-ai/ui': patch
---

Agents you can tell apart in the 3D world. Each agent's role is read from its name and description, from words alone with no model call ("coder", "producer", "travel agent", "bookkeeper", "game master"), its instructions and tools only choosing between roles those already say, and a home nobody has changed is redrawn as the kind that suits it: a coder's workshop with server racks, a producer's studio with a microphone on a stand, a travel agent's lounge with a globe and a map, a bookkeeper's study with ledgers, a game master's den with a game table. Bodies wear a few accessories in their own colour, fixed to the head, chest or hips so they follow every pose: a headset, glasses, a beret, a cap, a wizard or adventurer hat, a scarf, a bow tie, a lanyard, a satchel, a tool belt. Each role has a default; an agent chooses with the `place` tool's `room` action (`wear`), and a person from a row of chips on the agent's card, both kept in a `wear` world-state record. The map and the card say each agent's role in a word beside its colour, the map's search finds agents by role, and photos show what an agent wears in its own colours.
