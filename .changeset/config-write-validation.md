---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Refuse a config write that would land keys nothing reads.

There were twelve runtime paths writing `config.yaml` — three in the admin
tool, seven HTTP routes, a plugin tool, and the setup TUI — each hand-rolling
read → mutate → stringify → write → reload with its own idea of what to check
first. The strongest checked a YAML round-trip and the agent's tool references.
The weakest, `PUT /api/config`, wrote the request body to disk without parsing
it; since `runtime.reload()` swallows its own failures, that route answered
`200 {"ok":true}` on unparseable YAML while the process kept serving the
previous config, and the damage only surfaced at the next restart.

The gap they shared: none of them ran `validateConfig`. So an agent could
create another agent with `name:` and `temp:` instead of `temperature:`, and
every layer accepted it — the write, the round-trip, the manifest export. The
agent ran at the default temperature for a day. `validateConfig` had detected
exactly this since #252; it just ran at startup, into a log, after the fact.

Adds `config-write.ts` with `updateRawConfig` and `writeRawConfigText` as the
single door, and routes the admin tool and every server route through it. A
write that would introduce config which parses but is never read is refused
with the offending key named and a suggestion ("Did you mean `temperature`?"),
and the file is left untouched.

Two decisions that keep the gate from becoming a lockout. Writes are judged on
the findings they *introduce*, compared against a pre-write snapshot, so a
deployment's unrelated pre-existing warnings can't make its config permanently
unwritable. And only unknown keys refuse — they are never transient and the
author is right there; everything else `validateConfig` reports comes back as
`warnings` for the caller to surface.

Also fixes `updateRawConfig` refusing to patch a config it could not parse
rather than overwriting it, and makes `create_agent` accept the `value`
parameter its own schema advertises.
