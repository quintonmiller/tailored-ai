---
"@tailored-ai/core": patch
---

`summarizeOnTrim` defaults to true.

A trimmed turn used to leave a marker saying N messages were dropped. It now
leaves a summary of what they said. Set `summarizeOnTrim: false` per agent to
keep the old behaviour.

Measured on the scenario benchmark against a 27B local model, three pairs — the
same question through both paths, differing only in the flag:

| pair | marker | summarised | input tokens/run | rounds |
|---|---|---|---|---|
| the fact under discussion | 2/3 | 3/3 | 23,483 → 7,469 | 3.3 → 2.0 |
| a peripheral fact | 3/3 | 3/3 | 43,423 → 7,470 | 7.0 → 2.0 |
| the room path | 3/3 | 3/3 | 11,835 → 3,342 | 4.0 → 2.0 |

Correctness never worse, cost three to six times lower on every axis. A twelve-run
measurement of the first pair gave 6/12 against 12/12, Fisher exact p=0.014.

The extra provider call reads like a price and is not one. The marker path is
cheaper by one request and far more expensive by the turn: an agent told only
that something is missing spends rounds hunting for it, and on the peripheral-fact
pair only answered at all because it exhausted its tool rounds and the
out-of-rounds path handed the history back. The summarising call is bounded to a
3,000-character transcript, so it cannot grow with the history it replaces.
