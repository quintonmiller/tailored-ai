---
"@tailored-ai/core": patch
---

Generated config and tool catalogs, verified in CI.

Two failure modes recur here and neither is caught by tests: a config key that
parses, documents, and is never read (#335 is two of them), and hand-maintained
inventories that drift from the code. Both are mechanically checkable.

`pnpm run gen:catalogs` writes `docs/config-catalog.md` from `DEFAULT_CONFIG`
and `docs/tool-catalog.md` from the tool-factory registry. `pnpm run
verify:catalogs` runs both with `--check` and fails when a committed catalog is
stale, so a config field or tool added without regenerating is caught in CI
rather than months later. Both import the compiled modules rather than
re-parsing TypeScript, so the catalogs describe what actually ships; the CI step
runs after the build for that reason.

The config catalog carries two read-site signals per field — the leaf key, and
the stricter dotted path — and flags only fields where both are silent, because
a list that is mostly false positives is a list nobody reads twice. Optional
chaining had to be tolerated in the strict matcher: `config.tools.memory?.enabled`
is the dominant access pattern, and a literal dotted match reported nearly
everything as unread.

The tool catalog reads each factory's **real** config gate out of the factory
body rather than assuming `tools.<id>`. That distinction matters: `schedule` is
gated by `config.schedules.enabled`, and a catalog that guessed would report it
as missing a default it never wanted. Six factories currently have a gate with
no entry in `DEFAULT_CONFIG` — they exist but are invisible in a fresh
`config.yaml`, which is right for an optional integration and wrong for anything
else. The list is there to be reviewed, not assumed broken.
