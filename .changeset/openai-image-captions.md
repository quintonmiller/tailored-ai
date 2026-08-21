---
"@tailored-ai/core": patch
---

Keep a media part's `alt` as a caption ahead of the image it labels, on the
OpenAI-compatible wire.

It matters most on the path where it is the *only* label that survives.
`adaptForCapabilities`, relaying a tool result to a model that takes text there,
builds the follow-up user turn from `...media` and nothing else — so any text
the tool wrote stays behind on the `tool` message. A tool returning two images
in one result previously handed the model two pictures with nothing to say which
was which. The placeholder path is unchanged, since `mediaPlaceholder` already
folds `alt` in.
