---
"@tailored-ai/core": patch
---

Contribute a block of context without knowing the prompt layout.

`systemPrompt.order` / `.custom` can express any layout but demands you
understand the whole one — and until recently, adding one block meant
enumerating all seven built-in layers and silently switching off the tail while
you were at it.

A slot is the other half of that seam. The author answers one question — does
this change between turns? — and core decides everything else:

```ts
registerContextSlot({
  id: "on-call",
  refresh: "turn",        // "reload" → system prompt; "turn" → behind the history
  budgetTokens: 200,
  agents: ["*"],
  render: (ctx) => whoIsOnCall(),
});
```

or in config, with no code, via `prompt.slots` — where a `file:` slot is re-read
each turn, so an edit lands without a restart.

Core owns placement, ordering, budget enforcement (it truncates and says that it
truncated), agent scoping, and failure isolation: a slot that throws is skipped,
warned about once, and the turn continues.

The per-turn group renders as one contiguous block, which is a requirement
rather than a preference — the Anthropic history cache breakpoint targets
`messages.length - 2` and assumes exactly one volatile trailing message.

There is deliberately no `refresh` value that appends to the conversation
record. A slot is a view, rendered fresh and replacing last turn's copy; adding
one and rewriting history are different acts, and the second belongs to a
composer.

`DEFAULT_LAYER_ORDER` gains `slots_standing` and `slots_state`, and
`DEFAULT_TAIL_LAYERS` gains `slots_state`. A deployment that pins `order`
explicitly keeps working and simply renders no slots until it names them.
