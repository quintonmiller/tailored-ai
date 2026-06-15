---
"@tailored-ai/core": patch
---

Add a built-in `edit` tool for surgical, exact-match file edits. Agents previously
had only whole-file `write`, so changing a large existing file meant regenerating
it — impractical, and coding agents would stall on it. `edit` replaces an exact
`old_string` with `new_string` (unique unless `replace_all`), mirroring the
read/write tools' path resolution, sandbox boundary, allowlist, and sandbox-aware
IO. Enabled by default (`tools.edit`), opt-out with `enabled: false`; inherits
`tools.write.allowedPaths` when its own allowlist is unset.
