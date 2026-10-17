---
"@tailored-ai/speech": patch
---

`speak` can say *how* a line is delivered, not just what it says.

A script turn takes an optional `direction` — "wry", "tired, under his breath",
"sudden and loud" — which travels to the provider as the `instructions` field
that OpenAI's TTS and Breeze both accept, and is omitted entirely for providers
that do not know it. In a script file it goes in a parenthesis before the
colon: `GM (flat, a count not a threat): The ledger's missing a page.`

The expressive control already existed on the server side and stopped at the
tool boundary: nothing in this package mentioned it, so a multi-voice recording
was several voices all reading at one pitch. Consecutive lines from one speaker
still join into a single utterance, but no longer across a change of direction
— joining two deliveries renders the second in the first's voice, and the text
still reads correctly, so only listening reveals it.
