---
"@tailored-ai/core": patch
---

context: make the oversized-context warning configurable, and stop it crying wolf

The size warning was hardcoded at 750 tokens and quoted CLAUDE.md's "~500 tokens
for local models" guideline. That guideline assumes a small window; a deployment
running a 200K-token model and deliberately preferring specific, detailed context
over letting agents guess is making a choice, not a mistake — and a warning that
fires on a correct configuration is one people learn to ignore.

`context.warnTokens` now sets the threshold (default 4000, 0 disables), and the
message says what the number actually costs — context is never truncated, so it
comes out of the history budget instead and shows up as an agent that forgets.
