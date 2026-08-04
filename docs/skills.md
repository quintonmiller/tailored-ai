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
    skillLoading: progressive   # set this explicitly — omitting it gets "eager"
```

## Loading modes

| Mode | When |
|---|---|
| **`progressive`** (recommended) | The agent sees a catalog of skill ids + descriptions in its system prompt and calls `load_skill(name)` on demand. Small system prompt; instructions only appear when needed. |
| **`eager`** (deprecated, and what you get by omitting the key) | Skill instructions / tools / hooks merge into the agent at resolve time and ride along in every prompt. Bloats the prompt; use only for tiny always-on skills. |

> **Write `skillLoading` explicitly.** With the key omitted the resolver falls
> back to `eager` — the deprecated mode, which then warns. This doc used to call
> `progressive` the default, so following it and omitting the key got you the
> path it told you to avoid.
>
> `tai resources enable` and the UI agent editor both write `progressive` for
> you, so this only bites hand-edited config.

The two modes also treat `allowed-tools` differently, in ways that are easy to
trip over — see [Tool access](#tool-access) below.

### Progressive means the agent has to choose to load it

Nothing loads a skill for the agent. The catalog block says so in as many words —
that the instructions are not in the prompt, that each line is a label, and that a
skill should be loaded before a task it covers *even when the agent thinks it
already knows how*. That last clause exists because of a real failure: an agent
woken for Notion work, with the notion skill in its catalog, made **zero**
`load_skill` calls and worked from its own session history instead, repeating a
broken pipeline the skill warns against — twice, in a warning it never read.

Watch for it, because it fails quietly:

```sql
-- did the agent actually load the skill on its last run?
SELECT COUNT(*) FROM messages
WHERE session_id = ? AND tool_calls LIKE '%load_skill%';
```

Nothing logs a skipped skill, and the answer often looks fine because the agent
recovers by trial and error several rounds later than it needed to.

**When to reach for `eager` anyway.** If an agent's whole job is the skill, the
catalog round-trip is pure overhead and the risk of it being skipped is not worth
the tokens saved. A single-purpose agent — one where you would be surprised to see
it do anything *but* that skill — is the case for `eager`. It is only safe when the
skill declares no `allowed-tools`, or declares a complete one; see
[Tool access](#tool-access).

`load_skill` also narrows the tool set to the skill's `allowed-tools` for the
remainder of the loop.

## Tool access

`allowed-tools` means **opposite things** in the two modes. This is the single
biggest source of surprise in the subsystem, so read this before writing the
key.

| | `eager` | `progressive` |
|---|---|---|
| A tool the agent **has** | already available | **rejected** unless the skill also names it |
| A tool the agent **lacks** | **granted** — merged in from the host tool set | answers `Unknown tool` |
| Net effect | a grant list | a hard allowlist |

Two consequences worth stating plainly:

- **A skill cannot grant a tool progressively.** Naming one the agent lacks
  does not add it; it narrows the allowlist to a name that resolves to nothing.
- **Naming too few tools is worse than naming none.** An empty `allowed-tools`
  means "no restriction". A partial list silently revokes everything the agent
  had that the skill did not think to mention — including tools it needs for
  unrelated parts of the same turn.

The model is not told about the narrowing: it still sees the full tool schemas
after activation, so it keeps calling tools it can see and collects rejections.
If a skill looks like it is "not working", check for rejection messages before
suspecting the instructions.

Under `eager` there is a further wrinkle: because the merge happens at resolve
time from the host tool set, editing a `SKILL.md` on disk **widens a live
agent's capabilities** with no approval step.

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
