---
"@tailored-ai/core": patch
---

Stop the per-turn prompt layers from invalidating the whole prompt cache.

Prompt caching matches an exact token prefix. `chat_live_state` and
`recall_memory` are rebuilt on every turn and both sat inside the system
prompt, which sits in front of the entire conversation — so each run
re-paid for its system prompt *and* its whole history. Measured on a busy
48h of the reference deployment, input was 99.5% of everything billed and
cross-run reuse was approximately zero.

Both layers now render after the history instead, as a single labelled
turn. The system prompt and the history become a stable prefix; only the
tail is fresh. The model still sees both blocks, exactly once, and they
are still charged against the same history budget they used to occupy.

`SystemPromptOverride.tail` controls this. `tail: []` restores the old
layout. Setting `order` yourself disables the default — an explicit order
is a statement about placement, so nothing moves unless you also name
`tail`. A layer omitted from `order` stays omitted; `tail` never
reintroduces one.

Rounding the timestamp in `chat_live_state` would not have worked: the
block also renders relative ages ("5m ago") and a live task list, so it
varies every turn regardless of the header.
