---
"@tailored-ai/core": patch
---

ExecTool now resolves its scratch directory (where truncated command output is persisted) from `$TAI_HOME` / a constructor override / `~/.tai` in that order — the hardcoded `~/.tai/exec-outputs` path used to silently ignore configured TAI homes. The truncation path is also wrapped in `try/catch` so a filesystem failure (permission denied, missing $HOME on a CI runner, sandbox without write access) returns visible truncated output with a "could not be persisted" warning instead of leaving the tool promise unsettled until the timeout fires. Closes #60.
