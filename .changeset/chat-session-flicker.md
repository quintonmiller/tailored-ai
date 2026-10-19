---
"@tailored-ai/cli": patch
---

Fix the chat page flickering and losing its messages after you send. Coming back to the chat restored the last conversation's id but not its key, so the next message started a new conversation on the server; the page then bounced between the old conversation and the new one, reloading each time, before settling on the wrong one. The key is now stored and restored with the id (or looked up for a conversation stored before), and the page follows its URL only when the URL changes.
