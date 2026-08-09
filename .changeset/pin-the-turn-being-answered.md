---
"@tailored-ai/core": patch
---

Stop a heavily trimmed conversation answering a question the user retracted

When trimming dropped every user message, the safety net that keeps a request valid spliced the **first** user message back in as the current turn. On a session where the user had changed their mind, the model was handed a statement that had since been retracted and answered it — confidently, with the cancelled date.

It is reachable on any second round under history pressure: round two ends on an assistant or tool message, and the trim keeps only the last message, so no user message survives to be kept.

The message spliced back is now the most recent one, which is the turn the model is actually answering. The case the net was written for — a task prompt followed by tool churn — has exactly one user message, so first and last are the same there and nothing about it changes.
