---
"@tailored-ai/core": patch
---

`interface`: an answered component no longer costs the agent an error.

Run against a local 27B model, an agent that sent a choice and got its answer
then tried to close the choice in two runs of three, and was told it was
"already answered" as a failure. The tool's note on sending now says an
answered component closes itself (zero of three tried after that), and closing
one anyway succeeds and says what the answer was.
