---
# autonomous-agent-u3v2
title: SP5 — additional specialists (project-updater, fact-recorder, task-curator)
status: in-progress
type: task
priority: low
created_at: 2026-05-14T19:36:04Z
updated_at: 2026-05-14T19:36:04Z
parent: autonomous-agent-17dl
---

# SP5 — additional specialists

Deferred. Don't add these proactively. Only carve out a new specialist
when supervisor is observed doing the same focused kind of work
repeatedly and would benefit from a smaller, sharper tool surface for
it.

## Candidates we've discussed

- **`project-updater`** — writes to projects + documents.
  Tools: `projects, documents, recall`.
  Use case: "fold this batch of new info into project X" without
  giving the supervisor the full write surface.

- **`fact-recorder`** — sets atomic facts.
  Tools: `facts, recall`.
  Use case: "record this birthday / renewal date / account number" as
  a small, auditable call rather than a tool call from the supervisor.

- **`task-curator`** — creates and comments tasks.
  Tools: `tasks, task_query`.
  Use case: turning surfaced items into backlog work.

## Trigger criteria

Wait for the supervisor's `exploratory_runs` history to show repeated
direct calls to one of those tools (e.g. >5 `projects(update)` calls
across ticks in a week with no other meaningful work in those ticks).
At that point the specialisation pays for itself: the supervisor stops
re-loading the tool description on every relevant tick and the
specialist's narrower instructions improve write quality.

If we're not seeing that pattern, the answer is "keep the work on
supervisor." Premature specialisation costs orchestration complexity
without buying anything.

## When we do add one

- Pure config — same shape as `email-fetcher` from SP2.
- Add a one-line entry to supervisor's instructions: name, what it's
  for, when to call vs do it inline.
- No `online` block.
- `injectMemory: false` unless we have a reason to inject the global
  context (which we usually won't — specialists are small and focused).

## Out of scope

- Cross-cutting specialists like "summariser" or "writer" — those are
  already served by `researcher` / `writer` agents in config.yaml.
- Domain-specific specialists tied to one project — those live in
  `.tai.yaml` overlays once we hit that need.
