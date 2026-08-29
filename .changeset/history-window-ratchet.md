---
"@tailored-ai/core": patch
---

Stop the history window reopening mid-turn and handing back messages the model
was told were dropped.

The per-round history budget is `maxHistoryTokens` minus the system prompt, the
tail, and the tool schemas. It is recomputed every round because the tool set
can change mid-turn, which is correct as a ceiling and was wrong as a floor:
withdrawing a tool stops its schema being charged, the budget jumps by thousands
of tokens, and the next trim keeps messages the previous one evicted.

Measured on the scenario benchmark. With a 2,500-token budget against ~4,800
tokens of tool schemas, the history budget was zero, so nineteen rounds showed
the model `[System: 68 earlier messages … are no longer shown]` and it spent its
whole round budget searching memory tools for a fact it had been told was gone.
On the last round the repeated-call check withdrew the final tool, the schemas
left the budget, and all 73 messages came back — no marker, no explanation. The
model read the fact and reported it.

`trimHistoryWithStart()` now returns where the surviving history begins and the
loop holds that index as a floor for the rest of the turn. Both trim paths and
the smaller-rung refit honour it. The floor never empties the history, and
callers that pass none — every caller outside the loop — behave exactly as
before. Across turns the window still reopens; only within a turn does "no
longer shown" have to keep meaning that.
