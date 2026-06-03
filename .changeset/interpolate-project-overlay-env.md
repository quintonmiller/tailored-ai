---
"@tailored-ai/core": patch
---

Project overlays (`.tai.yaml`) now have `${ENV}` references interpolated
before merging onto the global config. Previously a per-project overlay
that referenced `${GITHUB_PERSONAL_TOKEN}` in `tasks.github.token`
reached the GitHub task backend as the literal string
`${GITHUB_PERSONAL_TOKEN}`, producing `Bad credentials` on every Octokit
call. The base config has always been interpolated by `loadConfig`; the
overlay path skipped this step entirely.

Fix applies in `mergeProjectOverlay` itself so every overlay consumer
(per-project task backends, the active-project runtime overlay, etc.)
benefits without each caller having to remember to interpolate.
