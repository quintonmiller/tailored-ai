---
"@tailored-ai/core": patch
---

A progressive agent's skill catalog is no longer empty outside the runtime's own call paths

`resolveAgent`'s options argument is the seventh positional parameter and every
field in it is optional, so a call site that forgets it compiles and runs — and
silently hands the agent an empty skill catalog. Six call sites did: the room
watcher, the task watcher, three in the Discord channel, and one in the runtime
itself. Every agent woken by a room message, a task, or a direct message could
therefore only use a skill it was told about by name; `load_skill` worked,
discovery did not.

The only signal was one line at startup ("skill catalog will be empty") that had
been scrolling past on every boot.

A type cannot catch this, because the parameter is legitimately optional for
callers with no runtime. A test now asserts the shape of every `resolveAgent`
call in core instead, which is what a new call site will trip over.
