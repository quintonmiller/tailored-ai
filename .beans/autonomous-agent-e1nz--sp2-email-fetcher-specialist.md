---
# autonomous-agent-e1nz
title: SP2 — email-fetcher specialist + supervisor delegates to it
status: completed
type: task
priority: high
created_at: 2026-05-14T19:36:04Z
updated_at: 2026-05-14T19:48:00Z
parent: autonomous-agent-17dl
---

# SP2 — email-fetcher specialist

Add the first specialist — a small read-only agent that fetches the
recent inbox, filters junk, and returns a structured summary the
supervisor can reason over. Pure config.

The existing `email-triage` workflow (classifier + actor) is unaffected:
the supervisor calls `email-fetcher` as a cheap "is there anything
material in the inbox?" probe, then invokes the heavy workflow via
`run_workflow` only when warranted.

## Changes

### `~/.tailored-ai/config.yaml`

- Add `agents.email-fetcher`:
  - `description`: "Read-only inbox probe. Lists recent unread mail,
    filters obvious junk, returns a compact JSON or bulleted summary.
    Called by supervisor to decide whether to trigger heavier
    workflows."
  - `instructions`: short. Tell it to:
    1. Read `email-triage-log.md` (profile scope) for already-seen IDs.
    2. `gmail(action="search", query="is:unread is:inbox
       -category:promotions -category:social -category:forums")`.
    3. Drop IDs already in the log.
    4. Drop obvious junk by headers alone (OTP, shipping confirmations
       with no problem, automated notifications).
    5. Return a short summary: count + per-item line with subject,
       sender, why-it-may-matter (one phrase). No body reads — that's
       the actor's job in the workflow.
    6. If nothing survives, return exactly `NO_NEW_MAIL`.
  - `tools`: `gmail, memory, recall`.
  - `temperature: 0.2`, `maxToolRounds: 6`, `injectMemory: false`
    (specialist doesn't need the global context — keeps it cheap).
  - No `online` block — never ticks on its own.

### `~/.tailored-ai/config.yaml` — `default` agent instructions

- In `agents.default.instructions` (now the supervisor role per SP1),
  add to the specialist list:
  - `email-fetcher` (read-only inbox probe): use when checking whether
    anything material has arrived. Cheap, returns short summary. Do
    **not** delegate to it more than once every ~30 minutes —
    recall-check `inbox checked` notes before firing.
- Add the supervisor-side recipe:
  1. `delegate(agent="email-fetcher", task="check recent inbox")`.
  2. If response is `NO_NEW_MAIL`: write a recall note "inbox checked
     <timestamp>, nothing new" with importance 0.3, tags
     `["routine","inbox"]`. Stop.
  3. Else: `run_workflow("email-triage")` to do the heavy work. Read
     its result, write a recall summary, and only ping the user if
     something truly needs them.

## Acceptance

- `pnpm run dev -- -a email-fetcher -m "check"` returns either a short
  bulleted summary or `NO_NEW_MAIL`.
- Manually invoking from supervisor's session with
  `delegate(agent="email-fetcher", task="check inbox")` returns the
  same shape via the tool.
- Inside an online tick, supervisor decides to call email-fetcher
  (cadence + goals + recall combine to make it the most useful action
  at least some of the time); an `exploratory_runs` row shows the tool
  call.
- The existing `email-triage` workflow still works when supervisor
  triggers it via `run_workflow`.

## Out of scope

- Anything that *writes* — that's the workflow's job or future
  specialists' (SP5).
- Push / webhook triggers — supervisor still polls via cadence here.
- Dedup against any system other than `email-triage-log.md` (which the
  actor already maintains).
