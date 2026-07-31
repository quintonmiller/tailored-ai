---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Honour `TAI_HOME` everywhere, so `-c <config>` selects a whole instance rather than just a config file.

`resolveHomeDir` read `TAI_HOME`, but nothing in the repo ever assigned it. Core is a library and never sees the CLI's flags, so every module that isolates per-instance state by reading the variable — the vault master key, the workflow secrets key, `exec-outputs`, `tool-outputs`, and the sandbox scratch allowlist — took its fallback branch on every run. Four more paths ignored the variable outright and resolved against `homedir()`: the resource trust store, the resource cache, and the registry index.

The result was a home directory holding the config and database while its keys and cached output went somewhere else. The visible symptom on a real install is hundreds of session directories under `~/.tai/exec-outputs`, a path no config mentions.

- New `taiHome()` / `taiHomePath()` in core is the single answer to "where does this instance keep its state", read from the environment on every call. Anything that caches it at module load captures the value from before the CLI publishes it.
- The CLI now calls `adoptHomeDir()` at each entry point, which resolves the home and publishes it as `TAI_HOME`.
- Scratch output moves from `~/.tai/{exec,tool}-outputs` to `<home>/{exec,tool}-outputs`. The old location stays on the sandbox read allowlist: truncated results hand the model an absolute path, and those pointers live in session history indefinitely.
- `TrustStore` and `ResourceLoader` expose `storePath` / `cachePath`.
