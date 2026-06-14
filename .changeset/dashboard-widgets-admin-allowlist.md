---
"@tailored-ai/core": patch
---

Let the `admin` tool author dashboard widgets. `dashboard.` is now in the
`update_config` write allowlist, so an agent can add or edit a config widget with
`admin` `update_config` path `dashboard.widgets` (the hot-reload authoring path the
dashboard seam was built for) instead of being blocked or forced to rewrite
`config.yaml` by hand. Other config sections stay locked down as before.
