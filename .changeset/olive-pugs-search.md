---
"@tailored-ai/evals": patch
---

Benchmark a team against an objective instead of an answer.

Adds a simulation seam to the eval harness: a scenario can now name a registered
TypeScript simulation, hand each agent one role's instruments, and be scored on
what the world was worth at the end rather than on whether a check passed. Ships
`factory` — a manufacturer with suppliers, machines that wear out, a hidden
demand function and a lost customer partway through — plus six non-model baseline
policies, a `bench` subcommand that sweeps them, and `sim_metric`,
`beats_baseline` and `responds_within` assertions.

`responds_within` measures organisational latency: the delay in simulated days
between something happening and the right function acting on it, with a flag for
whether the agent that acted is one that could see the event. Scenarios can be
written in TypeScript now (`defineScenario`), loaded alongside the YAML ones.
