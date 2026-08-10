---
"@tailored-ai/core": patch
---

`recall` and `facts` say what they are not for.

Both described what they hold and never what they don't, so a model reached for
them to answer a question whose answer was one message up. Measured on a 27B
local model, five runs per scenario:

| scenario | before | after | memory calls |
|---|---|---|---|
| the answer is in the previous message | 1/5 | 5/5 | 7 → 0 |
| nothing in the conversation mentions it | 0/5 | 3/5 | 10 → 3 |
| the answer really is in memory | 5/5 | 5/5 | 10 → 16 |

The third row is the one that decided it. Narrowing a tool description risks the
model abandoning the tool altogether — "an instruction that offers a way out gets
taken" — so legitimate memory use had to be measured too. It went up, not down:
the descriptions discriminate rather than suppress.

`tool-selection` holds at 27/27 with every scenario unchanged.

`memory` and `core_memory` are deliberately untouched, so a model that merely
switched tools would show as a switch rather than a win.
