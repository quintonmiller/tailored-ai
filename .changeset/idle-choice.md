---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

The agent decides what its body does when nobody is talking to it. Every two to four quiet minutes, while the chat page is in view, the page asks: `POST /api/live/idle` with where the avatar is and the hour runs one small completion on the agent's own model (voice mode, its body's cues, reasoning off, nothing stored) and returns the cues it chose: go sit on the couch, look out of the window, or stay put. One ask per agent per 45 seconds at most; with live sessions off, or if the ask fails, the avatar wanders on its own as before.
