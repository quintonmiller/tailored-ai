---
"@tailored-ai/core": patch
---

**Fix:** `recall list` now returns notes in deterministic newest-first order, even when many notes share the same `created_at` second. SQLite's `datetime('now')` is second-precision, and the previous tiebreak — `id DESC` where the id is `note_${randomHex}` — was *not* monotonic in insertion order. Two notes written in the same tick came back in arbitrary order. The query now tiebreaks on `rowid DESC` (SQLite's implicit monotonic insertion counter), giving sub-second deterministic ordering with no schema migration. Closes #63.
