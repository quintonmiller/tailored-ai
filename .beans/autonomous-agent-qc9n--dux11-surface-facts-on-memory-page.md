---
# autonomous-agent-qc9n
title: DUX11 — Surface facts on Memory page
status: completed
type: task
priority: high
created_at: 2026-05-14T07:59:43Z
updated_at: 2026-05-14T07:59:43Z
parent: autonomous-agent-p0ae
---

# DUX11 — Surface facts on Memory page

The Memory page only rendered notes; agents had been writing facts via
the `facts` tool (atom-style key/value) and the page showed 0s.

Memory functionality wasn't broken — `recallQuery` reads both tables
and injection was finding them. The UI just didn't render facts.

## Changes

- Server `/api/memory/stats` includes `counts.facts`.
- UI api.ts: `FactRow`, `fetchFacts`, `deleteFact`.
- Memory page: new "Facts" section under Notes, with category/entity/key
  display, value, confidence/source meta, and per-row delete. Stat tile
  added between Notes and Session summaries.
- Docs updated to make the two storage paths explicit: `facts` for
  atoms, `recall(action:"note")` for prose / inferred / ephemeral.
- Default agent instruction in config.yaml updated to spell out both
  paths with examples for each.

## Why

The agent's choice to use `facts` for atoms is correct — it's idempotent
on (category/entity/key) and easy to update later. The instructions just
needed to acknowledge it as a valid storage path so users can predict
where things land.
