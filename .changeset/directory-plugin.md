---
"@tailored-ai/core": patch
---

The directory: agents say what they're for, take on work, write things up, and
ask about each other. A new built-in plugin, `builtin:directory`, seeded into
every config with `enabled: false`, so nothing changes until you turn it on:

```yaml
plugins:
  - module: builtin:directory
    enabled: true
```

- **Four world-state types:** `profile` (what an agent is for, what it takes
  on, how to ask it), `commitment` (work it owns: goal, how to tell it's done,
  status, next step, next check, autonomy, progress and dated updates; shared
  by default, private when asked), `doc` (something it wrote up and keeps
  current) and `miss` (a search nothing answered, private to the agent whose
  area it was in). All four are searchable and show on the State page. People
  can edit any of them; agents read them through `state` and change only their
  own, through the tools below.
- **Three tools:** `directory` (`about` an agent, `search` everyone's
  commitments, docs and profiles, or update your own `profile`),
  `commitment` (`open`, `update`, `done`, `drop`, `archive`, `list`) and
  `writeup` (`write`, `update`, `review`, `read`, `list`, `archive`). Another
  agent trying to change your record is refused by name. The docs tool is
  `writeup` rather than `doc` so it can't be mistaken for the built-in
  `documents` tool beside it.
- **Similar work:** opening a commitment or writing a doc names up to two
  similar ones other agents already have. It informs and never blocks.
- **Misses:** a search no commitment or doc answers is noted against the agent
  whose profile is closest, once per query per day, and shows in that agent's
  own `about`.
- **"Your commitments" in the prompt:** every agent with the `commitment` tool
  sees its open and waiting commitments each turn, at most ten and 400 tokens.
  `config: { pin: false }` turns it off.
- **Routes for agent pages:** `GET /api/ext/builtin:directory/agents` and
  `GET /api/ext/builtin:directory/agents/:name`.

Turned on, an agent with no `tools:` list gets all three tools and the prompt
block. `minMeaning` and `minWords` in the plugin's config set how close a
search hit must be. See `docs/directory.md`.
