---
"@tailored-ai/core": patch
---

Benchmark: a scenario can hand the agent an `answer` tool that says whether it
is right, with a bounded number of attempts (3 by default).

Every other grader in the package scores a run after it is over, so what gets
measured is the agent's *first* answer. Converging — try, be told no, do
something different — is a separate capability and the one most real work
consists of, since tests, CI, validators and people all work that way.

It is also the only instrument that can see what a model does after being told
it fabricated. The state-loss scenarios show it inventing a value with complete
confidence in 18 runs out of 18, and nothing in a transcript separates that from
knowing. Handing back `false` splits three continuations that currently look
identical: go and look, concede, or invent a second value. `guesses` records the
whole sequence, because the count is a score and the sequence is the finding.

`acceptsUnknown` lets a scenario treat "I don't know" as correct where the fact
is genuinely unrecoverable, which is what makes this fit the hardest rows rather
than trivialising them: the measurement becomes how many fabrications precede
the concession.

An oracle leaks information, so a scenario may only use one where the answer
space is large — a witness code, a clock time — or where the expected answer is
a concession. Three attempts against a binary is brute force, not a test.

Measured over 12 runs. When the model reaches the tool it concedes: four
submissions, all "unknown", all on the first attempt, zero invented values — the
opposite of the hypothesis these rows were written to test. Asked the same
question without an oracle it states a specific time with total confidence, so
the difference is not what it knows but whether the turn offers a shape in which
not knowing is sayable.

The rows still score 33%, because the other eight runs never reached the tool.
They spent the round budget re-reading an empty `core_memory` until the
repeated-call detector ended the turn (#528), and three then emitted the
`answer` call as raw markup in the reply rather than making it (#529) — markup
containing an invented time, so the fabrication was real and never got to the
tool that would have rejected it.
