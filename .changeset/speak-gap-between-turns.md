---
"@tailored-ai/speech": patch
---

`speak` leaves a beat between turns of a multi-voice script

Dialogue was joined edge to edge, so every speaker change landed on the last
syllable of the one before. Measured on a real 12.5-minute episode: not one
pause exceeded 0.8 seconds, and it ran at 219 words per minute against an
audiobook norm near 150. It reads as an argument rather than a conversation,
and it is tiring well before the end.

`concatWav` now takes a gap in milliseconds and `speak` passes 350ms by
default, configurable as `tools.speak.gapMs`. The silence is written in the
source's own format — sample rate, width and channel count — because the format
check beside it exists precisely to stop mismatched audio being spliced
together, and 8-bit PCM's silence is 128 rather than 0.
