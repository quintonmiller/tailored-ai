---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

Chat and Talk are one page. On the Chat page, an agent with a body fills the page with its room and the conversation is a panel laid over it; **3D** turns the scene off and on, **Chat** hides the panel. Hold **Talk** (or Space) beside the message box to speak: spoken turns join the chat's own conversation (`POST /api/live/sessions` takes `sessionKey`), so typing and talking are one history. Typed turns move the body too: `/api/chat` takes `body` and streams the reply's cues as `cue` events. Each agent can have its own body with `agents.<name>.avatar: {model, animations}`, or none with `avatar: false`; `live.avatar` is the default. `GET /api/live` now reports `enabled`, and takes `?agent=`. Old `#/talk` links open the chat.
