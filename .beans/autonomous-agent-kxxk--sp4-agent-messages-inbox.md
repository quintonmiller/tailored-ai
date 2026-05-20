---
# autonomous-agent-kxxk
title: SP4 — agent_messages inbox + async delegate with reply_to
status: in-progress
type: task
priority: normal
created_at: 2026-05-14T19:36:04Z
updated_at: 2026-05-14T19:36:04Z
parent: autonomous-agent-17dl
---

# SP4 — agent_messages inbox + async delegate with reply_to

Deferred — needed once the supervisor wants to fire long-running
delegations and keep working while they complete. Until SP1/SP2 are in
regular use we don't know whether sync delegation is sufficient.

## Why

Current `delegate(async: true)` returns a task id and discards the
sub-agent's response. That's fire-and-forget (form C from the epic).
What's missing is form B — async with a structured place for the
response to land so the caller can come back to it.

Options considered and why each was rejected for the v1 design:

- **Recall with a reserved tag.** Zero schema, ships fast, but
  conflates IPC with memory. Recall has TTL + promotion rules that do
  not match mailbox semantics (you want explicit ack/delete, not
  decay).
- **`tasks` table.** Already exists, gets UI for free, but pollutes
  the user-visible task list with internal agent-to-agent traffic. Bad
  smell.
- **New `agent_messages` table** ← winner. Messages are addressed,
  single-recipient, ack-able, do not decay. Costs one table + one
  small tool.

## Schema

```sql
CREATE TABLE agent_messages (
  id              TEXT PRIMARY KEY,         -- "amsg_<uuid8>"
  from_agent      TEXT NOT NULL,
  to_agent        TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,            -- the id returned by delegate(async, reply_to=…)
  payload         TEXT NOT NULL,            -- the sub-agent's final response
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  read_at         TEXT,
  acked_at        TEXT
);
CREATE INDEX idx_agent_messages_to ON agent_messages(to_agent, acked_at);
CREATE INDEX idx_agent_messages_corr ON agent_messages(correlation_id);
```

## Wiring

- `delegate` gains optional `reply_to: string` (agent name) when
  `async: true`. Returns `{ correlation_id }` instead of just the task
  id.
- When the async sub-agent's loop completes (success or error), the
  engine inserts an `agent_messages` row with the payload (or error)
  addressed to `reply_to`.
- New `inbox` tool:
  - `inbox(action="poll")` — list unread messages for the calling
    agent. Returns one line per message: `id, from, correlation_id,
    created_at, preview`.
  - `inbox(action="read", id)` — return full payload, stamp `read_at`.
  - `inbox(action="ack", id)` — stamp `acked_at`; row hidden from
    future polls.
- Online tick prompt: prepend "Your inbox has N unread messages:
  [one-line previews]" same way recall is injected. Cheap, makes
  awareness reliable.

## Open subquestion (decide during implementation)

- Should `ack` delete the row or just stamp it? Lean toward stamp +
  index on `acked_at IS NULL` so the audit trail survives. Periodic
  sweep can purge acked rows older than N days if the table grows.

## Acceptance

- `delegate(agent="email-fetcher", task="…", async=true,
  reply_to="supervisor")` returns `{ correlation_id: "…" }`.
- Supervisor's next online tick sees the inbox summary in its prompt
  when the sub-agent completes between ticks.
- `inbox(action="poll")` from supervisor lists the unread message.
- `inbox(action="read", id=…)` returns the payload + stamps `read_at`.
- `inbox(action="ack", id=…)` hides it from subsequent polls.
- Failure case: sub-agent loop errors → message lands with payload
  describing the error (so the caller can react).

## Out of scope

- Cross-agent message broadcast (one sender, multiple recipients).
- Timeouts / expiry on unread messages — caller responsibility for now.
- A user-facing UI for inspecting agent_messages — log-only is fine
  initially.
