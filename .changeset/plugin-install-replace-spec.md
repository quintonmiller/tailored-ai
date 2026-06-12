---
"@tailored-ai/cli": patch
---

`tai plugin install` now replaces an existing dependency installed under a different spec (e.g. swapping a `file:` link for a registry version) instead of failing with ERESOLVE. The stale manifest entry is dropped before npm runs and restored if the install fails.
