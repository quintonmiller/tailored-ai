---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

The Talk page can show an avatar. Set `live.avatar.model` to a VRM file (under `<TAI_HOME>/avatars/`, or an absolute path) and the agent gets a 3D body that breathes and blinks, leans in while you talk, looks away while it thinks, and moves its mouth with its voice. All of it comes from the turn and the audio, so it costs no tokens and no delay. Drawn with three.js, loaded only when an avatar is set. The server adds `GET /api/live` and `GET /api/live/avatar`, and the default content security policy now allows `blob:` in `connect-src`, which the 3D loader needs to read a model's embedded textures.
