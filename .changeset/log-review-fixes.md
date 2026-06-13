---
"@tailored-ai/core": patch
---

Fixes surfaced by reviewing real autonomous-run logs:

- **exec**: allow safe compound commands under an allowlist. Chaining (`&&`,
  `||`, `;`), pipes (`|`), and redirections now pass when every command-position
  head is allowlisted, instead of the whole command being rejected for
  containing a shell operator. Command substitution, backticks, process
  substitution, subshells, background `&`, and newlines are still rejected.
- **memory/embeddings**: clamp each embedding input to
  `memory.embeddings.maxInputChars` (default 8000) and, on a context-overflow
  400, retry with the cap halved — so an oversized recall query no longer
  silently drops semantic search to keyword-only.
- **retry**: `withRetry` now stops immediately when `shouldRetry` returns false
  (previously it kept re-running `fn`, only skipping the backoff delay).
- **config**: `validateConfig` treats `task_query` as enabled whenever `tasks`
  is enabled (they register together), removing a spurious per-agent warning.
- **read tool**: friendly errors for reading a directory (EISDIR) or a missing
  file (ENOENT) instead of the raw errno message.
- **tasks/github**: pin `x-github-api-version: 2022-11-28` on the Octokit
  client to stop endpoint-deprecation warnings.
