---
"@tailored-ai/ui": patch
"@tailored-ai/core": patch
---

The chat over the 3D world now follows who you are with. Going to an agent's home talks to that agent, picking up your latest conversation with it; coming back talks to the agent you came from; a reply still on its way finishes first. The top of the panel names who you're talking to, with a dot in their body's colour, what they're doing, and a way to switch. A meeting room shows that room's own recent conversation to read (`GET /api/ext/builtin:places/transcript/:id`, read only) with its members as tabs to talk to. Switching agents anywhere in the web UI now leaves the last agent's conversation instead of posting the next message into it, and new web conversations' keys name their agent (`web:<agent>:<time>`). Walking on a visit is brisk (2.75 m/s), Shift runs at twice that, flying is faster again, the walk cycle keeps pace with the ground (a run clip plays when the library has one), and the camera keeps up without lag.
