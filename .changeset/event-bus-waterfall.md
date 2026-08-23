---
"@tailored-ai/core": patch
---

The event bus gains an around-middleware dispatch mode.

`emit` lets a subscriber observe and `emitAsync` lets it veto by returning
`false`. Neither lets it **change** what happens, so every feature that wants to
shape an agent request has to live inside `runAgentLoop` rather than beside it —
which is most of what #417 is about.

`bus.onWaterfall(event, handler)` and `bus.waterfall(event, payload)` add the
missing mode. A listener receives `(payload, next)`, may transform the payload,
and either calls `next(payload)` to delegate or returns its own value to
short-circuit and own the outcome. `{ prepend: true }` is there for the rare
listener that must run before ordinary registrations.

Waterfall events are declared in `RuntimeWaterfallMap`, separate from
`RuntimeEventMap`, so the dispatch mode is part of an event's contract: a
waterfall event can never be `emit`ed by accident and a broadcast event can
never be handed a `next` it does not expect. The map is extended by declaration
merging, so a plugin can declare and dispatch its own waterfall without a core
release.

Failure behaviour follows the rules the bus already had. A throwing listener is
logged and skipped, and the chain continues with the payload that listener was
handed — one bad subscriber must not break the operation it was only observing.
A listener that returns nothing is treated as a pass-through rather than as an
instruction to truncate: if it delegated, its downstream result stands; if not,
the chain carries on without it. A dispatch runs the snapshot of the chain it
started with, so registering mid-dispatch behaves the way it does for `emit`.

**Core declares no waterfall events yet.** The obvious first one — transforming
an agent request before the model sees it — turns out to be blocked on the agent
loop having no bus to dispatch on, which is a prerequisite worth landing on its
own rather than smuggling in here. The mechanism is useful to plugins today
regardless, since the map is theirs to extend.
