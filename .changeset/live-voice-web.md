---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Live sessions work end to end in the web UI. A new **Talk** page: pick an agent, hold the button (or Space) and speak; what you said appears, then the reply as it is written, and its voice plays a sentence at a time. Typing works too. The server adds `POST /api/live/sessions`, `GET`/`DELETE /api/live/sessions/:id`, and `POST /api/live/sessions/:id/turn`, which takes recorded audio or `{text}` and streams back the transcript, the words and the audio. Also: a short sentence at the end of what has streamed so far now waits to be joined to the next instead of being spoken alone, and voice mode tells the agent to offer only what its tools can do.
