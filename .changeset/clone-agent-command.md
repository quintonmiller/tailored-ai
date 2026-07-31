---
"@tailored-ai/core": patch
---

Add `/clone-agent` — copy an agent's configuration to a new name, and nothing else.

```
/clone-agent from:iris to:nova
```

Done by hand this is one copy and three checks: duplicate the block under
`agents:`, then confirm the copy has no core memory, no sessions, no notes and
no room subscriptions. The checks are the point — the interesting failure is
the silent one, a "fresh" clone that inherited the original's persona or woke up
in the original's rooms and answered as if it had been there all along. Only
configuration travels; everything an agent has lived is keyed by its name and
stays behind. The reply reports both halves: the fields carried over, one line
each, and what was deliberately left, so nobody has to trust that the clone is
actually blank.

The source definition is read registry-first, the same precedence `resolveAgent`
uses. An agent already migrated to
`data/authored-resources/agent/<id>/manifest.yaml` still has its old block
sitting in `config.yaml`, and cloning that block would copy what the agent used
to be — wrong in fields that still parse, so nothing would complain. The reply
says which one it read.

The write goes through `updateRawConfig`, so a clone that would introduce config
that parses but is never read is refused with the file untouched and the reasons
returned. Every other refusal — unknown source, a target name outside
`[A-Za-z0-9_-]+`, a target that already exists in the registry or in
`config.yaml` — also happens before anything is written.

No restart is needed: `updateRawConfig` reloads the runtime and `resolveAgent`
falls back to `config.agents`, so the clone answers immediately. It is a
top-level command rather than a subcommand of `/agent`, because `/agent` already
carries a required top-level option and Discord forbids a command having both
options and subcommands.
