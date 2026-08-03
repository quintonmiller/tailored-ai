---
name: agent-config-editor
description: Change agent configuration safely — create an agent, edit its tools/model/prompt, wire it into a room, attach a skill — and confirm the change actually took effect. Use whenever asked to add, edit, inspect or remove an agent, change what an agent can do, subscribe an agent to a room, or when an earlier config edit "did nothing".
version: 0.1.0
---

# Editing agent configuration

Deliberately no `allowed-tools`: this skill is attached to several agents with
different toolboxes, and a partial list would silently revoke tools they need —
including `room`, without which a woken agent cannot reply at all.

## The thing that catches everyone

**Editing an agent in `config.yaml` does not take effect on hot-reload. It needs
a process restart.**

Config file changes *are* watched, and the runtime *does* reload — but `reload()`
never rebuilds the agent registry. The registry was populated once at startup,
and it is consulted *before* `config.yaml` on every resolve. So the stale
definition keeps winning, and everything looks like it worked: the file is
correct, the write returned success, `generation` went up, `GET /api/config`
echoes your new value. The running agent still has the old definition.

This applies to `POST /api/agents` and `PATCH /api/agents/:name` too — a 200 there
reports a change the agent will not see.

| You changed | Live on reload? |
|---|---|
| An agent's definition (`agents.<name>.*` — tools, model, prompt, skills) | **No — restart** |
| `rooms.*` (subscriptions, limits, batching) | Yes |
| `cron.*`, `commands.*`, `dashboard.*` | Yes |
| `agent.*` top-level (temperature, maxToolRounds, …) | Yes |

So: **say what you wrote, and say plainly that it needs a restart to take
effect.** Never report an agent as changed when only the file changed.

## 1. Read before you write

Always, in this order:

1. `list_agents` — an existing name is **overwritten without warning**, and the
   most common accidental request is a near-duplicate of an agent that exists.
2. `get_config` on `agents.<name>` — copy the shape of a working agent rather
   than inventing field names.
3. `get_config` on `providers` — before naming a `provider` on the new agent.

## 2. What you are allowed to write

`update_config` accepts only these path prefixes:

```
agents.      commands.      dashboard.      cron.jobs      cron.enabled
agent.extraInstructions     agent.temperature
agent.maxToolRounds         agent.maxHistoryTokens
```

Anything else is refused with `Cannot modify "<path>": path is not in the
allowed set.` Three omissions are deliberate and no phrasing gets around them:

- `custom_tools.` — a custom tool's `command` runs through `bash -c` on the host.
- `permissions.` — the approval gate governing your own calls.
- `context.` — redirects the instruction files injected into every agent.

If a request needs one of those, **say so and stop.** Do not route around it by
writing the same effect into a place you *can* write.

Two more limits worth knowing:

- **Bare parent paths are blocked.** `agents` and `dashboard` are refused (the
  prefixes carry a trailing dot); only `agents.<something>` works. You cannot
  replace the whole `agents:` block in one call.
- Under `agent.`, only the four leaves listed above are writable. `agent.model`,
  `agent.defaultProvider`, `agent.maxTokens` are not.

## 3. Where a definition actually comes from

There are exactly **two** sources, and they rank differently depending on when
you ask:

1. **The agent registry**, loaded from `data/authored-resources/agent/<id>/manifest.yaml`
2. **`config.yaml`** under `agents:`

- **At startup**, `config.yaml` wins: any manifest whose contents have drifted
  from what config would produce is rewritten from config (logged as
  `resynced N agent manifest(s) from config.yaml (drift detected)`).
- **After startup**, the registry wins, and nothing rescans either source.

Net rule: **config.yaml is the source of truth, but only a restart applies it.**

`data/context/agents/<name>/` is **not** a third source. Those are context
*files* read into the prompt, not definitions.

An agent that exists **only** as a manifest and not in `config.yaml` is
half-invisible: it will not appear in `list_agents` or `GET /api/agents`, PATCH
and DELETE 404 on it, and it gets no validation at all. If you find one, say so.

## 4. Fields

A workable agent needs `description`, `tools`, and usually nothing else.

| Field | Default | Notes |
|---|---|---|
| `description` | — | Shown in listings. **Not injected into the prompt.** |
| `instructions` | `agent.extraInstructions` | The extra-instructions layer. |
| `systemPrompt.base` | global base | Replaces the base prompt for this agent. |
| `tools` | **every tool** | Omitting it is rarely intended. ~5 is the target. |
| `model` / `provider` | global defaults | Only set when they should differ. |
| `temperature` | `0.3` | |
| `maxToolRounds` | `10` | |
| `thinking` | provider default | `off\|auto\|low\|medium\|high` |
| `skills` / `skillLoading` | — / `eager` | See §6. Write `skillLoading` explicitly. |
| `roomSessionScope` | `room` | `shared` = one history across all rooms. |
| `injectMemory` | `false` | Prepends a recall block. |
| `nudgeOnText` | `0` | Re-prompt when the model answers with prose. |
| `summarizeOnTrim` | `false` | Summarize dropped history. |
| `skipGlobalContext` | `false` | Load only this agent's context dir. |
| `fileBoundary` | — | Hard filesystem confinement for file/exec tools. |
| `hooks` | — | `beforeRun` / `afterRun`, each `{tool, args?, skipIf?, onError?}` |
| `online` | — | Always-on exploratory config. |

### Personas are not a config field

An agent's character lives in **core memory**, keyed by agent name and injected
every turn. `description` says *which* agent something is; core memory says
*who* they are. You cannot write it — say so and let the owner do it with
`/memory set agent:<name> section:persona`.

## 5. Keys that parse and are silently never read

Unknown keys are **ignored forever**, not rejected. These are the ones that look
like they work:

- **`models:` on an agent is inert.** Nothing reads it. The documented
  "first available is used" failover does not exist. Use `model:`.
- **`skillLoading` without `skills`** does nothing at all.
- **`roomSessionScope` is matched by exact string.** `Shared`, `SHARED` or any
  typo falls back to per-room isolation with no warning.
- **A typo'd field name** (`temp` for `temperature`) produces one startup
  warning into a log and then runs at the default forever.

Before inventing a field name, read a working agent and copy it.

## 6. Skills

```yaml
agents:
  <name>:
    skills:
      - some-skill
    skillLoading: progressive
```

- **Write `skillLoading` explicitly.** Omitting it gets `eager`, which is
  deprecated.
- **A skill must be installed** to resolve. An id that is not installed is not
  an error — it logs `references unknown skill "<id>"` on *every* wake and is
  skipped. If a skill "isn't working", check that first.
- `allowed-tools` in a skill means **opposite things** in the two modes: under
  `progressive` it is a hard allowlist (a partial list revokes everything else
  for the rest of the turn); under `eager` it is a grant list that **merges tools
  the agent does not have** into it. Prefer `progressive`.

## 7. Wiring an agent into a room

Under `rooms.subscriptions`, one entry per (agent, room):

```yaml
- agent: <name>
  room: <room name>
  deliver: push        # push = on a transport event; poll = on an interval
  wakeOn: named        # named | addressed | all | none
  checkInMinutes: 60   # optional: also wake with nothing new said
  batch: true          # optional: read together with its other batched rooms
```

`deliver` and `wakeOn` are **independent axes**. `push`+`named` is an instant
answer that stays quiet otherwise; `poll`+`all` is a digest; anything+`none` is
a read-only seat.

**Any agent in a room needs `room` in its `tools`.** Without it the agent is
subscribed, woken, and cannot reply — the most common silent failure here.

### Batching

A combined turn (one wake, one prompt with a section per room) requires **all**
of:

1. `rooms.minWakeIntervalMinutes` set to a non-zero value, **and**
2. at least **two** of the agent's rooms with `batch: true`, **and**
3. those rooms triggered by a message or a poll — in the same wake.

`batch: true` on a single room does nothing and warns about nothing. With
`minWakeIntervalMinutes` unset it is refused with one warning per agent per
process (so a hot-reload that fixes it produces no confirming log).

**Scheduled check-ins never batch.** A check-in is deliberately excluded, so
`checkInMinutes` on five rooms is five separate turns per hour, not one. Set it
on **one** room per agent unless you mean five.

Also: a check-in costs **two** slots of `maxWakesPerHour`, not one.

## 8. Verify — and know what proves nothing

**Proves nothing:**

- `GET /api/config` and `GET /api/config/section/:key` — they re-read the raw
  file from disk. No defaults, no `${ENV}` interpolation. They echo your edit
  back at you whether or not the runtime ever loaded it.
- A successful `update_config`. The write succeeded; the reload is separate, and
  a failed reload is swallowed with only `[runtime] Reload failed, keeping
  previous state:` in the log.

**Actually verifies:**

1. `get_config` on `agents.<name>` — this reads the *merged live* config, not
   the file.
2. `/api/health` → `generation` must have increased. It is a per-process
   counter that resets to 0 on restart, so it is only meaningful as a
   before/after delta within one process.
3. The log: `[runtime] Reloaded config (generation N)`.
4. For a definition change: **the restart happened.** Nothing else counts.

`update_config` also runs a live tool check the file writer cannot, and refuses
with `Not written — unknown tool(s) …`. That refusal means nothing was written.

## 9. Reporting

State three things separately and never merge them:

- **what you wrote** — the exact path and value
- **whether it is live** — reloaded, or waiting on a restart
- **what you could not confirm**

Never report a restart you did not perform. Never report an agent as changed
when only the file changed. If you were not able to verify, say "written, not
verified" — that is a useful answer; a confident wrong one is not.
