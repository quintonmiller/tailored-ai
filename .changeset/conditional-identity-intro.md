---
"@tailored-ai/core": patch
---

Base system prompt no longer assumes the agent has no identity. It now checks context and memory first and only introduces itself when no identity exists anywhere — previously it would cold-introduce even when an identity context file was loaded.
