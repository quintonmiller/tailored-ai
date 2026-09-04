---
"@tailored-ai/core": patch
---

Link media a room post cannot upload, instead of failing the post

The room path uploaded whatever media it was handed. That was harmless while
nothing handed it any, and became a total failure the moment something did: a
21 MB generated recording is past Discord's limit, the upload 413s, and because
the files ride a chunk of the message, **the whole post fails** — so the agent
loses its words as well as its audio, and every later post in the same turn
fails the same way.

The channel path has always applied a ladder here — attach what fits, link what
does not. The room path never did, and never needed to until `room(action:
"post")` started carrying a turn's media.

It now applies the same rules: honour `media.delivery: link`, link anything past
a conservative 8 MB floor, and when there is no link to offer, say so in the
body rather than failing. "It exists but you cannot have it" is diagnosable; a
413 that eats the message is not.
