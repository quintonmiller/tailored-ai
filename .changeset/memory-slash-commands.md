---
"@tailored-ai/core": patch
---

Add `/memory` — read and edit what an agent remembers about itself.

Core memory is per-agent, survives every session, and goes into the system
prompt on every turn. Until now the only writer was the agent itself through
the `core_memory` tool, and there was no reader outside the database. An agent
could write itself a persona that shaped every later answer and nobody could
see it, let alone correct it. Sessions could already be reset and rewound; core
memory could only be changed by asking the agent nicely.

```
/memory show   agent:kiki [section:persona]
/memory set    agent:kiki section:persona content:…
/memory append agent:kiki section:persona content:…
/memory clear  agent:kiki section:persona
```

`set` and `clear` return the text they destroyed. Core memory has no history
table, so without that an overwrite is unrecoverable — the same reason
`/room rewind` hides rather than deletes. Replies are ephemeral, since a
persona is usually written in the first person and a channel is the wrong place
to print it. `updated_by` records the person rather than the agent, because
almost every existing row is self-authored and "who wrote this" is the first
thing you want when a persona looks wrong.

An unknown agent or section is refused before any write: a typo would otherwise
create core memory nothing ever reads. Agent names autocomplete from the agent
registry and config together, so authored-resource agents appear too.
