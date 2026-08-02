---
"@tailored-ai/core": patch
---

Stop `rooms/store.ts` being invisible to grep.

Two composite map keys embedded a raw NUL byte as their separator instead of the `\0` escape. That is legal TypeScript and behaves identically, but it makes the file *binary* as far as `grep`, `ripgrep`, and anything built on them is concerned — `grep -c agent packages/core/src/rooms/store.ts` silently returns nothing, and a repo-wide search skips the file without saying so.

That is a bad property for any file and a worse one for this file: it is the room subscription and wake-budget store, so "find every caller of tryConsumeWake" quietly under-reports. It also means any security or privacy sweep that greps the tree has a blind spot it will never be told about.

`\0` in a template literal produces the same U+0000, so the keys and everything derived from them are byte-identical.
