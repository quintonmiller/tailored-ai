---
"@tailored-ai/core": patch
---

Withdraw a looping tool instead of ending the turn.

The cycle detector ended the turn outright. That is right when the cycle is the
whole turn and wrong when it is one blind alley inside a turn with work still
available. Measured: a model asked for a fact that had left its history window
called an empty `core_memory` three times, tripped the detector, and the turn
ended — with rounds still on the budget and a tool it had never touched in the
list. Two of six runs happened to try that tool first and passed; four looped
first and lost the turn.

The looping tools are now withdrawn for the rest of the turn and the loop
continues. Every tool in the detected cycle goes, not just the one named in the
last round: on `A → B → A → B` the final round names B alone, and leaving A in
place costs two more rounds to reach the same place. With nothing else to offer
the turn still stops, which is the pre-existing behaviour.

Withdrawing rather than persuading, because persuading was tried three ways and
none of them moved the number: an empty result that said "reading again returns
this", a note at the moment of the repeat that the call was identical, and an
outright refusal of the third call with an explanation. The refusal was worst —
the model kept calling into it five to seven times. A tool that is not offered
is the one thing it cannot call.
