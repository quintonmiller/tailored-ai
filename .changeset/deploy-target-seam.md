---
"@tailored-ai/cli": patch
"@tailored-ai/core": patch
---

Add the `tai deploy` seam so cloud providers ship as plugins.

`tai deploy list | plan | up | down | status | help` drives a `DeployTarget`.
TAI ships `docker` (container on this machine, via `docker/tai/`); AWS, GCP,
Fly and anything else register the same way from a plugin package, so adding a
provider does not mean forking TAI.

The contract is types-only in `@tailored-ai/core` — the package plugin authors
already depend on, and the import erases at compile time. The registry,
discovery, and the command live in `@tailored-ai/cli`, because nothing in the
agent runtime needs to know how the instance was deployed.

Discovery is by *installation*, not configuration: the CLI imports packages
under `<TAI_HOME>/plugins/` and reads a `deployTargets` named export, the same
shape the plugin loader already uses for `meta` and `validateConfig`. It has to
work this way — `tai deploy` is often the command that creates the instance a
`config.yaml` would describe, so it cannot require one to exist first.

`up` always runs `plan` first and refuses when the target reports unmet
preconditions, rather than starting work already known to fail. A plugin that
fails to import is reported by `tai deploy list` and skipped. See
`docs/deploy-targets.md`.
