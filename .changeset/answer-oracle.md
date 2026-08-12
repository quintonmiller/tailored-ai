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

Not yet measured against a live model: the endpoint went down before the first
run produced a submission.
