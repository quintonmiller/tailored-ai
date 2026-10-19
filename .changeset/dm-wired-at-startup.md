---
"@tailored-ai/core": patch
---

An agent's direct messages (`room` with `action: "dm"`) work from the moment TAI starts. The tools built at startup were handed a context without message delivery, so a direct message answered "Direct messaging is not wired up in this deployment" until the first config reload. Every place tools are built now shares one context.
