---
# autonomous-agent-p0ae
title: Dashboard UX overhaul
status: completed
type: epic
priority: high
created_at: 2026-05-14T05:28:57Z
updated_at: 2026-05-14T06:02:12Z
---

# Dashboard UX overhaul

Improve the web dashboard's chat & agent experience based on user pain points
(2026-05-13 conversation) and an independent investigation of the current code.

## Why

The dashboard exposes chat, agents, tasks, memory, etc. but the chat-and-agent
loop is the dominant interaction surface and it is the weakest. The user
flagged 8 pain points; an investigation confirmed all 8 and surfaced 5 more.

## Pain points (numbered as in the original conversation)

1. No long-lasting conversation with agents — each visit to Chat starts fresh.
2. Conversation is request/response-shaped; agent questions feel disconnected.
3. No visualization of agent-to-agent (delegate) communication.
4. Agents page is read-only — no create/edit/delete.
5. Chat is page-bound, should be a global concept.
6. No rich entity rendering (task cards, agent chips, doc previews).
7. Memory tools exist but agents barely use them; lots of repetition.
8. Agents don't proactively identify problems / fix / propose tasks.

Plus: silent error handling, buried approvals, fragile agent selector,
a11y gaps, no session pagination/search.

## Slices

- **DUX1** — session persistence & continuity (sessions.title/pinned, restore on mount, rename/pin UI)
- **DUX2** — global chat dock (App shell overlay, ChatContext, keyboard shortcut, approval surface)
- **DUX3** — rich entity rendering (`<task/>`, `<agent/>`, `<note/>` tags → chips; delegate sub-bubbles)
- **DUX4** — agent CRUD via REST + Agents page editor
- **DUX5** — memory-by-default (injectMemory on, summarize hooks, "recalled N notes" chip)
- **DUX6** — proactivity (`<proposal>` tag + accept-to-task UI)
- **DUX7** — conversational shape (`<ask>` tag, in_reply_to threading, pauseable loop)

Cross-cutting (folded into the slice that touches the same files):
toast/error system (DUX2), session sidebar virtualization + search (DUX1),
accessibility pass (DUX2).

## Order of execution

DUX1 → DUX2 → DUX4 (parallel: DUX3) → DUX5 → DUX6 → DUX7.

Phase 5 has the biggest "the agent suddenly feels smarter" payoff per LoC
because the memory infra already exists — it just isn't turned on.
