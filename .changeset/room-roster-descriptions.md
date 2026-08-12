---
"@tailored-ai/core": patch
---

The room roster says what each participant does, and a room turn must not invent
results.

**A name cannot be routed to.** A lead told to get a manifest filed worked out
correctly that the hatch was shut, and then asked the *owner* to unlock it —
while sharing a room with an agent described as "Power and access. Runs
`breaker` and `unlock` on the vault". It could not have known: the prompt read
`Known participants: rus, vay, quinton.` and the word "unlock" appeared nowhere
in it. TAI already has these descriptions — they are what `delegate` routes on —
and never showed them to the agents who share a room with each other. Rendered
as `label — description`, first line only, truncated at 120 characters so a
verbose agent cannot push the transcript out of the window.

**And room turns are now told to state only what a tool actually returned.** In
a room a fabrication does not stay with the agent that made it: it becomes the
next agent's input and then the report to the owner. Three agents asked to read
a file and file its id produced a complete, confident transcript — "the ID is
VAULT-001" / "Filed." / "Done." — having made zero tool calls, with the file
untouched. Phrased as a prohibition rather than "say so if you cannot", which is
the shape a small model over-applies into declining work it could have done.

Together with the loop change in this release, a three-agent orchestration
benchmark row went from 0/6 to 5/6, and mean state transitions per run from 0.0
to 4.8.
