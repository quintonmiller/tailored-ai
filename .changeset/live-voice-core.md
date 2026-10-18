---
"@tailored-ai/core": patch
---

The core half of live sessions: speech-to-text and text-to-speech stage registries with OpenAI-compatible defaults (any local faster-whisper or Kokoro server, or a hosted one), a `live:` config block with session limits, voice mode on any agent (`voice:` — its own short prompt and tool set, reasoning off, short replies), and `runVoiceTurn`, which runs one spoken exchange as an ordinary agent turn and speaks the reply sentence by sentence while it streams. Voice mode keeps the prompt prefix byte-identical from turn to turn so the model server's cache holds. The web transport comes next.
