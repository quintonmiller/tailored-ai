---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
"@tailored-ai/server": patch
"@tailored-ai/channel-slack": patch
---

CI now runs `pnpm run lint` and `pnpm run pack:check` on every PR (closes #68 — error-enforcement portion). The lint baseline is cleared of all blocking errors (1 unreachable-code error in `channel-slack`'s test fixed; ~30 errors auto-fixed by `biome check --write`). 197 advisory warnings remain — predominantly UI a11y findings tracked under #93 — and don't block CI.
