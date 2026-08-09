---
"@tailored-ai/core": patch
---

Stop the base prompt sending agents to look up an identity that is already in the request

It opened with "Check your context and memory for your identity". But `context`
and `core_memory` are prompt *layers*, composed a few hundred tokens below the
base one — the identity is already in the request by the time the model reads
that sentence. There was never anything to look up.

The cost was not the wasted call so much as where the instruction sat: the first
line of the first layer, telling the model to reach for memory before it had
read anything. On the scenario benchmark, over 15 runs per arm against a 27B
model, the agent went from answering **0 times out of 15** with no tool call at
all to **5 out of 15**, and from opening with a memory lookup 5/15 to 2/15. The
full 58-scenario set moved no row beyond the noise floor.

The paragraph now says where the identity is instead of sending the model to
find it, and is shorter for it — which matters for text every agent pays for on
every turn.

Partial progress on the behaviour tracked in #446, not a fix for it: the
remaining calls are the agent *saving* what it was told, which is the memory
paragraph working as written.
