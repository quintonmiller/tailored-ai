---
"@tailored-ai/trusted-actions": patch
---

Stealth browser contexts no longer hardcode `en-US` / `America/Los_Angeles`. Locale and timezone are captured at `setup amazon` login time, stored in the session, and replayed; sessions saved before this change fall back to the executor host's locale/timezone. The `navigator.languages` patch now derives from the effective locale.
