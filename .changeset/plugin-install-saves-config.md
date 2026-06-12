---
"@tailored-ai/cli": patch
---

`tai plugin install` / `remove` now keep config.yaml's `plugins:` list in sync (comment-preserving YAML edit; real package names resolved even for git/file/tarball specs). Pass `--no-save` to manage the list yourself.
