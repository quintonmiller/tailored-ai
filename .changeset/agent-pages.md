---
"@tailored-ai/core": patch
"@tailored-ai/ui": patch
---

Every agent has a page. With the directory on (`builtin:directory`), opening an
agent in the web UI shows what it's for, what it's working on (next step,
progress, next check, how long since it moved, and its dated updates), what's
waiting on you, what it finished in the last two weeks, its docs (open one to
read it in place), and the questions others asked in its area that nobody could
answer. The page keeps up as the records change, without a reload. The settings
the Agents page used to open on are one click away, on the Settings tab. The
Agents list is now a grid of cards, each with the agent's purpose line, how
much it has open and waiting, and, for an online agent, its state and today's
runs. A fresh agent's page says it has nothing yet in one line rather than four
empty sections. With the directory off, nothing changes except a line under the
configured description saying how to turn it on; a directory that fails says
it couldn't load rather than that it's off.

- **Hand it something.** A short form at the bottom of the page (a goal, and
  how you'll know it's done) opens a commitment the agent owns, from you. The
  agent sees it in its "Your commitments" block on its next turn, and the page
  says so, or says why it won't: it has no `commitment` tool, or `pin` is off.
  Behind it is a new route,
  `POST /api/ext/builtin:directory/agents/:name/commitments`, which refuses a
  name that only has a profile left.
- **The agent arranges its page.** A new `page` record, one per agent, holds a
  note in its own words, the order of its sections, the ones it hides, and up
  to six sections of its own, each a list of the records a world-state query
  matches. The agent keeps it with a new `directory` action, `page` (`note`,
  `order`, `hide`, `add`, `remove`), and `about` yourself shows your page note.
  A section's query runs as the agent before it is saved, and keeps the scopes
  the agent could see, so a page never lists a record the agent couldn't find
  itself; a type people can't read is refused, since the page reads as a person.
  "Waiting on you" and "Questions nobody could answer" can't be hidden by the
  agent. People can change the record on the State page, and a section a person
  hid stays hidden when the agent changes its own hidden list. A `null` argument
  is no change, so a model that sends one for every optional argument reads its
  page rather than clearing it.
- **Where a commitment came from.** A commitment someone handed over now says
  so in the agent's prompt block, `about` and `commitment list` ("open, from a
  person, ..."), from its `from` field. Commitments without `from` read as
  before.
- **Lists can be ordered.** A list or table bound to a query takes `orderBy`
  (a field, `-` first for descending, as a `state` query does), in the
  `interface` tool's `bind` and wherever the list is redrawn. Without it, lists
  stay oldest first.
- **Routes that outlive a reload say so.** The directory's routes, mounted
  once at start, now answer `404` "The directory is turned off." after a reload
  turns it off, instead of failing on types that are gone.
