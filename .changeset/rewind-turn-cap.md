---
"@tailored-ai/core": patch
---

Raise `/room rewind`'s turn cap from 50 to 1000.

50 was arbitrary and too low. An agent on `roomSessionScope: shared` keeps one
conversation across every room it is in, so its turn count is the sum of all of
them — the first real use needed 77 and the option rejected it. The cap only
guards against a fat-fingered 9999, and a rewind is reversible with `turns:0`,
so it can afford to be generous.
