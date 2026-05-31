# Skills (agentskills.io SKILL.md)

A **skill** is a shareable bundle of instructions + tool allowlist that an agent
can use. Skills follow the [agentskills.io](https://agentskills.io) SKILL.md
convention — YAML frontmatter + Markdown body — so anything written for the
OpenClaw / Claude-Code skills ecosystem drops into TAI unchanged.

## Anatomy

A skill is a directory containing one `SKILL.md`:

```
my-skill/
└── SKILL.md
```

```markdown
---
name: my-skill                       # required, must match parent dir
description: One-line purpose blurb. # required
version: 0.1.0                       # optional, defaults to 0.0.0
allowed-tools:                       # optional — narrows the agent's tool set
  - web_search
  - memory
---

# Long-form instructions

Markdown body becomes the skill's prompt. The agent gets this text when it
activates the skill via `load_skill` (progressive mode) or always (eager mode).
```

## Install

```bash
# Local folder
tai resources install ./path/to/my-skill

# Git
tai resources install git+https://github.com/user/skills/my-skill

# Federated registry
tai resources install tai-registry:my-org/my-skill
```

`tai.lock` records every install. The bootstrap on `tai serve` re-registers
every lockfile entry into the live runtime.

## Enable for an agent

### CLI

```bash
tai resources enable my-skill default
tai resources disable my-skill default
```

Writes `agents.default.skills` (and `skillLoading: progressive` if not set)
to `~/.tailored-ai/config.yaml`.

### UI

Open **Agents → edit agent**. The skill picker lives below tools — check the
skills you want, optionally toggle progressive vs eager. Save.

### config.yaml directly

```yaml
agents:
  default:
    skills:
      - my-skill
    skillLoading: progressive   # default; use "eager" only for tiny prompts
```

## Loading modes

| Mode | When |
|---|---|
| **`progressive`** (default) | The agent sees a catalog of skill ids + descriptions in its system prompt and calls `load_skill(name)` on demand. Small system prompt; instructions only appear when needed. |
| **`eager`** (deprecated) | Skill instructions / tools / hooks merge into the agent at resolve time and ride along in every prompt. Bloats the prompt; use only for tiny always-on skills. |

`load_skill` also narrows the tool set to the skill's `allowed-tools` for the
remainder of the loop.

## Sample skill

See [`docs/example-skills/daily-briefing/SKILL.md`](./example-skills/daily-briefing/SKILL.md) for a
fully working example. Install + enable:

```bash
tai resources install ./docs/example-skills/daily-briefing
tai resources enable daily-briefing default
```

Then in chat: "what's on for today?" — the supervisor will activate the skill,
see its instructions, and produce a four-line briefing.

## Authoring tips

- Keep `description` actionable. The model uses it to decide *when* to call
  `load_skill` — "When to call this" is more useful than "What this does."
- Hard-cap tool budget in the body (e.g. "use at most 4 tool calls").
- For local-model compatibility, keep instructions under ~300 tokens.
- Prefer `allowed-tools` over leaving the agent's full toolbox accessible —
  narrows the choice space and improves small-model selection accuracy.
- If your skill needs a CLI installed on the host (e.g. `gotify`,
  `paperless-ngx`), document the install step in the body. TAI does not auto-
  install host binaries.

## Discovery

Browse installed skills:

```bash
tai resources list
curl http://localhost:3000/api/skills
```

Browse the federated registry (Tab: Browse on the UI's Resources page):

```bash
tai resources search "calendar"
```

## Compatibility

Skills written against the agentskills.io / OpenClaw conventions install
unchanged. TAI ignores frontmatter keys it doesn't recognize (e.g.
`compatibility`, `metadata`) — they pass through into `manifest.data` for
future-proofing.
