---
"@tailored-ai/speech": patch
---

New package: a `speak` tool that turns text — or a multi-speaker script — into
an audio attachment.

Text goes in, audio comes back as a media part, so it reaches Discord, Slack,
the web UI and the CLI by the same path a screenshot does. Core is untouched:
the tool writes through `ToolContext.mediaStore`, which is all a tier-2 plugin
should need.

The provider is a registry from the first commit rather than after the second
vendor. One implementation ships — `openai_compatible`, the
`/v1/audio/speech` wire format — and it covers both a local Kokoro on CPU and
OpenAI itself, switched by `baseUrl` and `model`.

A `script` of `{speaker, text}` turns renders per speaker and joins the audio.
Multi-speaker scripts with no voice map are refused rather than rendered as
one narrator reading every part, and locally joined audio is always wav, since
concatenated mp3 reports the wrong duration and clicks at the seams.
