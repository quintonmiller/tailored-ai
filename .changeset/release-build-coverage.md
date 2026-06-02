---
"@tailored-ai/browser-mediator": patch
"@tailored-ai/channel-slack": patch
"@tailored-ai/cli": patch
"@tailored-ai/core": patch
"@tailored-ai/google-tools": patch
"@tailored-ai/server": patch
"@tailored-ai/trusted-actions": patch
---

Release build now covers every publishable package (closes #56). The root `build` script previously enumerated packages by hand and forgot `channel-slack` and `google-tools`; `pnpm publish -r` would have shipped them with stale or missing `dist/` output. Build is now `pnpm -r run build` and the release workflow runs a new `pnpm run pack:check` smoke that packs every public package and asserts each tarball contains `dist/index.js`. The Changesets fixed group adds `channel-slack` and `google-tools` so they version in lockstep with `core`'s plugin contract.
