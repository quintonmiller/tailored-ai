---
"@tailored-ai/core": patch
---

Declaring a custom system-prompt layer is now enough to render it, and turning
the tail off says so.

Two defects made `systemPrompt` unsafe to use for the thing it exists for.

A custom layer only rendered if it was also named in `order`, and `order` means
"names not listed are omitted". So adding one block cost you enumerating all
seven built-in layer names in the right sequence, and an enumeration with a name
missing deleted that built-in silently. A `custom:` entry on its own — the shape
someone reaches for first — parsed fine and did nothing.

Worse, `order` set without `tail` switches the tail off. That behaviour is
deliberate (an explicit order is a statement about placement) but it was
unannounced, and the tail is where the volatile layers live. Adding a block
therefore either moved `chat_live_state` into the system prompt — which carries
a clock, so it changed the prompt every turn and defeated prompt caching — or,
if `order` did not list them, dropped the clock and recalled memory out of the
request altogether. Nothing in the config hinted at either outcome.

Now: an unplaced custom layer is appended after the built-ins, naming it in
`order` or `tail` still decides where it goes, and `tail` accepts a custom layer
without `order` having to list it too. Setting `order` without `tail` warns once
per config, naming which layers moved and what it costs.

No behaviour change for a deployment that already sets `order` and `tail`
explicitly, or for one that sets neither.
