---
"@tailored-ai/core": patch
---

The daily memory-hygiene sweep schedule is now configurable via `autopilot.memorySweepCron` (default `"14 3 * * *"`, the previous hardcoded value). An empty string disables the sweep; an invalid expression logs a warning and disables it instead of crashing the worker.
