---
"@tailored-ai/speech": patch
---

A multi-speaker script now needs a voice per speaker, instead of quietly
falling back to the single default voice.

The guard that refuses an unvoiced dialogue was defeated by the ordinary
config. With `voice` set — as every real deployment has it — a script whose
speakers were not named in `voices` resolved every one of them to that single
voice and returned success. The result is one narrator reading all the parts:
audio that renders, reports the right duration, and is discoverable as wrong
only by listening to it.

A model naming its own speakers is the common case, not the edge, so this was
the default behaviour rather than a corner.

Named speakers now resolve only through a per-speaker map (the call's `voices`,
then the config's). The single `voice` still covers `text` and a script with
one distinct speaker, where there is nobody to be confused with. The refusal
names the unmapped speakers and lists the configured ones, so the caller can
fix it in the same turn.
