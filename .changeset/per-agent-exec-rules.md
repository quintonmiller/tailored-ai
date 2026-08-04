---
"@tailored-ai/core": patch
---

`exec` command rules can be set per agent, and support deny lists and patterns.

The allowlist was one list on one shared `ExecTool` instance, so granting an
agent `exec` granted it everything on that list. In a real deployment that meant
34 commands including `rm`, `curl`, `node` and `python3` — so `exec` could not
be handed out for one narrow purpose, and every integration that needed to shell
out became a bespoke `custom_tools` entry instead.

`agents.<name>.exec` now takes the same `allow` / `deny` shape as `tools.exec`:

```yaml
tools:
  exec:
    allow: [git, ls, ntn]
    deny: [rm]
    mode: intersect        # default; `override` lets an agent replace these
agents:
  researcher:
    tools: [exec, web_search]
    exec:
      allow: [ntn]         # this agent gets ntn and nothing else
```

Both lists accept glob patterns (`*`, `?`) matched against the command name in
every command position, so a compound command cannot smuggle a second binary
past them. `deny` always wins over `allow`, at both levels.

`mode` is deployment-level on purpose: an agent that could choose `override` for
itself would make `intersect` guarantee nothing. Under `intersect` an agent can
only narrow — and an allow list that intersects to nothing denies everything
rather than falling back to unrestricted, which is the direction that fails open.

`tools.exec.allowedCommands` still works and is equivalent to `allow`. Note this
scopes the `exec` tool only; `custom_tools` run a fixed command and never
consulted these rules.
