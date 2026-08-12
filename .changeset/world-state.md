---
"@tailored-ai/core": patch
---

Benchmark: scenarios can carry a world — a state machine the agent's tool calls
drive — and be graded on whether they reached a goal state rather than on what
they said.

Every stub before this was a pure function of the call, so nothing could be
locked, nothing had to be unlocked first, and order of operations was not
expressible. A scenario could ask "did you make the right call" and never "did
you work out what the right calls were". `world:` adds state, `requires` guards
that refuse and say what they are waiting for, `sets` mutations that persist
across agents, and `by` so a transition belongs to one specialist. The win
condition is `world_state`, a claim about the machine and never about the
transcript: any route that reaches the state passes.

The first three scenarios found something a text assertion cannot see. A lead
directing two specialists produced a complete, confident room transcript —
"I read the manifest, the ID is VAULT-001" / "Filed" / "Done" — having made
zero tool calls, with the world untouched. One agent's fabrication became the
next agent's input and then the report to the owner. Every existing assertion in
the package would have scored it as success.
