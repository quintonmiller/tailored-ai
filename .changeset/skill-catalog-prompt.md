---
"@tailored-ai/core": patch
---

The progressive-skill catalog tells agents that skills are not loaded, and when to load one.

The block read "Activate one with `load_skill(name: <id>)`", which is an offer.
An agent that believes it already knows the task has no reason to accept one, and
that is exactly what happened: an agent woken for Notion work, with the notion
skill in its catalog, made **zero** `load_skill` calls and worked from its own
session history instead — repeating a broken pipeline the skill explicitly warns
against, twice, in a warning it never read.

The failure is silent. Nothing logs "the agent skipped its skill", and the answer
often looks fine because the agent recovers by trial and error, several rounds
later than it needed to.

The block now states plainly that the instructions are **not** in the prompt, that
each line is a label rather than the content, and that a skill should be loaded
before starting a task it covers *including when the agent already believes it
knows how* — because a skill is the current shared instructions and gets corrected,
while an agent's recollection is whatever happened to work last time.

Costs about 100 extra tokens in the system prompt of agents that have progressive
skills, and nothing for agents that do not.
