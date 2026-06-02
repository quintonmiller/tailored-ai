---
"@tailored-ai/core": patch
---

**Security:** Filesystem `allowedPaths` checks in `ReadTool` and `WriteTool` now use a proper path-containment helper instead of `startsWith`. Previously, allowing `/srv/project` also permitted `/srv/project-secrets` (sibling-prefix), and a symlink inside an allowed directory pointing at `/etc/passwd` would let the read/write tools escape the sandbox. The new `isPathContainedRealpath` helper normalizes paths, requires a true descendant boundary, and resolves symlinks (with nearest-existing-parent resolution for write targets that don't exist yet). Closes #59.
