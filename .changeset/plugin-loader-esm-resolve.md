---
"@tailored-ai/cli": patch
"@tailored-ai/google-tools": patch
---

Plugin loader falls back to manual exports-map resolution for pure-ESM
plugins. Previously a plugin whose published `exports` map only declared
the `import` condition (no `default`, no `require`, no top-level `main`)
failed to load because `createRequire().resolve()` couldn't see the
`import` condition. Affected `@tailored-ai/google-tools@0.1.1` —
restarting the agent after a fresh `tai plugin install` produced
"plugin … is not installed" even though it was.

Two changes ship together:

- `@tailored-ai/cli`: the plugin loader now tries `createRequire().resolve`
  first, then walks the plugin's own `package.json` exports map by hand
  (`exports["."].import` / `default` / `require`, then `module` / `main`)
  and dynamic-imports the resolved file path. Pure-ESM plugins load
  without the author having to publish a CJS-visible entry condition.
- `@tailored-ai/google-tools`: the `exports` map now also exposes a
  `default` condition so older versions of the loader still resolve this
  package correctly via the CJS path.

A regression test covers the pure-ESM-only layout end-to-end in the
plugin manager's importer.
