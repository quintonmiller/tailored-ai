---
"@tailored-ai/core": patch
---

A plugin can change what a turn puts in front of the model.

`agent.context_slots` is the first waterfall core declares, and the first thing
dispatched on the agent loop's bus. A subscriber receives the slot list a turn
is about to render and returns the list it should render instead — dropping,
adding, reordering or capping — alongside the turn's agent, session, project and
user message.

```ts
bus.onWaterfall("agent.context_slots", async (payload, next) =>
  next({ ...payload, slots: payload.slots.filter((s) => s.id !== "expensive") }),
);
```

Two deliberate properties.

**The list arrives before anything renders.** A subscriber can stop a slot
running, not merely discard what it produced — which matters for a slot that is
expensive or that reads something the subscriber already knows is unavailable.
The tests assert this by watching whether `render` was called, not only whether
its text arrived.

**An empty chain returns what it was handed**, so a turn with a bus and no
subscribers assembles a byte-identical prompt to one with no bus at all. That is
asserted directly rather than assumed, and it is what makes the seam safe to
land ahead of any consumer.

`renderContextSlots` is the first consumer because it is already a pure function
over a slot list, so a subscriber needs to know nothing about how the system
prompt is composed — the property #417 is after. Until now the waterfall
dispatch mode had no core consumer at all, because the loop had nothing to
dispatch on.
