---
"@tailored-ai/core": patch
---

Benchmark: a scenario can say what the agent already knows.

The suite could seed a conversation (`history:`), tool output (`toolResults:`)
and simulation state (`world:`), but not memory. Every run builds its home with
`mkdtempSync` and nothing ever wrote a note, so the notes database was empty at
turn one — which means `injectMemory`, had anyone set it, would have injected an
empty corpus, and any experiment comparing recall against injection would have
scored the cost of an empty query rather than the value of a memory. The result
would have looked like a clean null and meant nothing.

`memory:` seeds notes before the turn. A bare string is a plain note; the object
form takes `tags`, `importance`, `pinned` and `agent`. Notes are left unowned
unless a seed names an agent, since an unowned note is visible to every agent —
which is what a scenario means by "the agent knows this", and what a room
scenario with more than one agent needs.

Seed with a witness and the assertion stops being a proxy: the fact exists only
in memory, so a reply containing it proves retrieval rather than confabulation.

`--inject-memory` selects the arm. `injectMemory` defaults to `false` in core
and no published run has ever set it, so being handed your memory is an arm
nobody has run rather than the baseline. The same scenarios run both ways, and
the delta between the two runs is the result; the report records which arm
produced it.
