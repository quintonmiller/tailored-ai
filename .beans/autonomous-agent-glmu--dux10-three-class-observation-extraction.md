---
# autonomous-agent-glmu
title: DUX10 — Three-class observation extraction
status: in-progress
type: task
priority: high
created_at: 2026-05-14T07:49:38Z
updated_at: 2026-05-14T07:49:38Z
parent: autonomous-agent-p0ae
---

# DUX10 — Three-class observation extraction

DUX9 only catches explicitly-marked preferences ("from now on", "I prefer").
A casual statement like "I'm taking my car to the lake on Saturday" carries
three durable / semi-durable facts the agent should silently absorb:

- **Profile fact**: user has a car
- **Profile fact (inferred)**: user enjoys nature / outdoor activities
- **Ephemeral context**: visiting a lake on Saturday <date>

Today the agent drops all three. Expand the extraction discipline.

## Convention

Three tag families, each with their own retention policy:

| Tag                       | Importance | TTL              | Use for                                                                 |
|---------------------------|-----------:|------------------|-------------------------------------------------------------------------|
| `preference` + `pinned`   | 0.95       | none             | Global rules ("never run destructive git without asking")               |
| `preference`              | 0.85       | none (or none)   | Working preferences ("I prefer terse responses", "always TypeScript")   |
| `profile`                 | 0.7        | none             | Durable facts about the user / their world ("has car", "lives Berlin")  |
| `profile` (inferred)      | 0.5–0.6    | none             | Inferences ("user enjoys outdoors")                                     |
| `ephemeral`               | 0.4        | event date + 2d  | Time-bound context ("visiting lake Saturday")                           |

Anything `importance < 0.8` is reaped by the existing TTL sweep when its
ttl_at passes; the explicit short ttl on `ephemeral` is what auto-cleans
those.

## Changes

- Local + example agent instructions: replace the single "preferences"
  paragraph with three-class guidance + examples.
- docs/chat-tags.md: expand "Preference learning" → "Observation
  extraction" with the table above and worked examples.
- No code change. Existing recall tool + injectMemory + TTL sweep all
  handle this already.

## Why no schema / code change

The recall tool already accepts arbitrary `tags`, `importance`, and
`ttl_at`. The pinned tier already handles top-priority. The relevance
tier already handles everything else. The TTL sweep already reaps low
importance. We only need to teach the agent *when* to record what.

Semantic search (DUX5) is the lever that makes profile facts surface
on topically-related questions without lexical overlap; if embeddings
are off the convention still works but is keyword-only.
