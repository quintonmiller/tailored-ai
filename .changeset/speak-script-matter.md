---
"@tailored-ai/speech": patch
"@tailored-ai/core": patch
---

`speak` no longer reads a script's header or footer block as dialogue

A script file is usually wrapped in notes — `Cast: ...`, `Setting: ...`,
`Notes for TTS: ...` — and every one of those lines is shaped exactly like a
line of dialogue. A real 141-line script parsed its cast as `GM, REX, MARA ...`
plus `Setting`, `Tone`, `Running gag` and `Notes for TTS`, and the render was
refused for the uncast "speakers".

Three signals together separate notes from dialogue: they sit at an edge, there
are few, and nobody cast them. All three are required — a character can speak
the first line, and a script can open with several short exchanges. What keeps a
genuinely miscast character from vanishing is visibility rather than refusal:
every dropped line is now named in the tool result, so `skipped: MARA` reads as
a missing voice and `skipped: Notes for TTS` reads as a correct trim.

Also fixes a false startup warning ("provider is not registered (have: none)")
on every boot of a working install: a plugin's `validateConfig` runs before its
own `register()`, so the registry it populates is always empty at that point.
Documented in core alongside the call.
