# Defensive patterns

Each pattern below is a class of defect that shipped, or nearly shipped, in this
repo — stated as the rule that prevents its recurrence rather than as the story
of how it happened. Read this before writing lifecycle, teardown, config,
provider, or prompt-assembly code.

The framing matters: a rule you can apply while writing the code is worth more
than an incident you can recall afterwards. Where the rule has a home in the
codebase already, it links there instead of restating it.

---

## Config that parses but is never read

A key lands in `AgentConfig`, gets documented, gets set by a user, and nothing
consumes it. It is indistinguishable from a working feature until someone
notices the behaviour never changed. Two settings shipped this way
([#335](https://github.com/quintonmiller/tailored-ai/issues/335)), and
per-agent shape checks have been inert more than once.

**Rule:** a config field is not done until something reads it and a test proves
the read. When you add one, grep for its own name — if the only hits are the
schema, the default, and the docs, you have shipped a decoration.

Related: `pnpm run guard:local-refs` catches structural drift, not this.
[#536](https://github.com/quintonmiller/tailored-ai/issues/536) proposes
generating the catalog that would make an unread field mechanically visible.

## Control flow inferred from model-facing strings

Parsing what the model said to decide what the runtime does couples behaviour to
phrasing. It breaks on a model swap, on a prompt edit, and on a language the
author did not consider — silently, and in a way no type checks.

**Rule:** decisions come from structure — a tool call, a tag, a typed event —
never from matching prose. If the model must signal something, give it a
mechanism that a schema can describe. See
[docs/chat-tags.md](./chat-tags.md) for the sanctioned surface.

Corollary, from [CLAUDE.md](../CLAUDE.md): **no conditional response tokens.**
An instruction that offers a way out gets taken — smaller models read a sentinel
like `NO_REPLY` as the answer itself.

## Registrations without inverses

Anything a component installs into shared state — a factory, a listener, a
route, a timer — must be removable by whoever installed it. Without a
per-registration inverse there is no unit to revert, and teardown degrades into
throwing away shared state and hoping. That produced duplicate channel listeners
after a config reload ([#58](https://github.com/quintonmiller/tailored-ai/issues/58))
and trigger pollers hot reload never reconciled
([#65](https://github.com/quintonmiller/tailored-ai/issues/65)).

**Rule:** `register` returns a `Disposer`. The disposer removes only the entry
that call made, and is idempotent — see
[architecture.md](./architecture.md#registration-disposers). A disposer that
deletes whatever currently sits under the id will one day delete a live
registration it never owned.

## Dispose must reach quiescence, not just request it

Teardown that issues a kill or an abort and returns leaves orphans: the process
is still running, the socket is still open, the callback still fires into a
half-torn-down world.

**Rule:** cleanup awaits the thing actually stopping, and closes listener
registries **before** killing so late completions land somewhere silent rather
than somewhere surprised.

## Contain callback exceptions in the dispatcher

One throwing subscriber must never starve the subscribers after it, or reject
the promise it happens to run inside. Core lifecycle cannot depend on every
plugin being well-behaved.

**Rule:** wrap the dispatch loop, log, continue. `TypedEventBus` does this in
both `emit` and `emitAsync` (`packages/core/src/events.ts`) — a throwing handler
is also treated as **non-veto**, so a broken observability plugin cannot
accidentally block real work.

## Report orthogonal outcomes independently

A result can be several things at once: a process can time out *and* exit 0
because it trapped the signal. Nesting one flag's report inside another's branch
makes a caller read a cut-short run as a clean success.

**Rule:** surface each independent fact on its own — `timedOut`, `signal`,
`exitCode` — and let the caller combine them.

## Widen the interface production actually calls

A capability added to the wrong interface compiles, type-checks, ships, and does
nothing. `Channel.send` and `OutboundNotifier.send` look interchangeable until
you notice which one the live path calls.

**Rule:** before widening an interface, grep for its callers and confirm the
path you care about is among them. "It compiles" is not evidence that anything
reaches it.

## Sweep for the operation, not the syntax

Auditing for `${...}` template interpolation misses `.join()`, raw column reads,
and every other operation that stringifies an object just as thoroughly. A
template-only sweep left four sites standing, one of them a live bug.

**Rule:** enumerate the *operations* that can coerce, then search for each.
Searching for one syntax and calling the class handled is how the survivors
survive.

## Silent truncation

Content disappears and the model reads what remains as the whole of it. This is
the failure prompt assembly keeps producing, which is why `capSlot`
(`packages/core/src/agent/context-slots.ts`) appends a visible marker rather
than trimming quietly, and why history trimming marks the cut.

**Rule:** anything that drops content says so, in the output, where the reader
of that output will see it. A budget that truncates invisibly is worse than one
that refuses.

## Prefer informing over overriding

Four guards in a row each caused the failure they were added to prevent. A guard
that silently overrides the agent removes the feedback loop that would have
taught it — and removes your ability to see what it would have done.

**Rule:** default to telling the agent what you know and letting it decide.
Reach for a hard override only where the action is irreversible. When you do
override, say so in a way the agent can read, so the next turn is not reasoning
against a reality it was not told about.

Related: [CLAUDE.md](../CLAUDE.md)'s note on tradeoffs being expected with a
small local model — the guard that "fixes" a 27B model often breaks a larger
one.

## Never hand spawned commands the ambient environment

A subprocess that inherits the parent environment can leak credentials into its
own output, into `env` dumps, and into any file it writes.

**Rule:** scrub `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*` before spawning.
Temp files get a private directory, random names, and owner-only exclusive
opens; predictable world-readable paths invite symlink races.

## A benchmark delta needs a control arm

Re-running a subset of failures scores higher on identical code — selection
alone was worth several points. Run-to-run noise on this suite is real, so a
small movement is not evidence of anything.

**Rule:** compare arms, never a run against a remembered number. Change one
thing, keep the tree still for the duration, and treat a delta inside the noise
floor as no result. And a run that completes with a suspiciously round zero is a
dead backend, not a scoring regression — check that tool calls happened at all.

## Async state is not synchronous state

A status transition is not the result of one request. Several queued messages
can share one "running" interval, and cancellation can discard items that never
started.

**Rule:** a caller that needs the outcome of a specific request defines its own
interval explicitly, and describes any output as interval-wide rather than
attributing it to one message. Handle the "nothing to wait for" branch too — a
wait for a transition that can never occur hangs forever.

## Suspect the configuration before the component

Three config faults in one afternoon each looked exactly like a model
regression: a quantisation that did not fit the card, a mismatched cache dtype,
and a tool-round cap that strangled a more exploratory model.

**Rule:** when something newly performs badly, exhaust the configuration
differences before concluding anything about the component. The same rule
applies one level down — check sampling parameters before blaming context
assembly, because degenerate repetition is usually a missing repetition penalty
rather than a prompt problem.

## Verify a negative finding by a second method

"I looked and found nothing" is the easiest wrong answer to produce, and the
hardest to notice. Two independent searches reported a repo clean; a third found
a live credential.

**Rule:** spot-check "nothing found" with a different method before relaying it,
especially for anything security-shaped.

## A reload can rebuild a collaborator in the middle of a turn

`reload()` rebuilds tools, the provider and the time provider. Two paths reach
it without anyone deciding a turn should end: `updateRawConfig` calls
`host.reload()` after every config write (`config-write.ts`), and the config
watcher reloads on an external edit to `config.yaml` after a 500ms debounce
(`runtime.ts`).

Both are reachable mid-turn. `admin` is a meta tool appended to every top-level
turn, so a model can rewrite config and rebuild its own provider between one
round and the next — a turn whose first response calls `admin` runs its
remaining rounds on a different provider instance than it started on. A person
editing `config.yaml` while an agent is working does the same thing.

That broke a wrapper which assumed one provider per run and hung per-run state
on it. Both halves failed, and the contrast is the useful part. One truncated a
file whenever it was constructed, so the rebuild discarded everything gathered
so far — including the record of the very call whose response had caused the
reload. That failure was loud at the next use. The other restarted a position
counter at zero, so a repeated lookup silently returned the first answer twice:
no error, just a wrong result that looked right.

**Rule:** ask what a piece of state's lifetime actually is, then put it on
something that lives exactly that long. State belonging to a run is decided once
before the run starts and handed to each rebuilt collaborator. "Constructed
once" is an assumption about someone else's lifecycle, not a fact about your
own — anything you initialise in a constructor runs again every time that
collaborator is rebuilt.

## A fake collaborator cannot falsify an agreement about a third party

A wrapper around the model provider passed 24 unit tests against a fake upstream
while being unable to handle most of the benchmark's real scenarios. The fake
answered whatever it was asked, so both sides of the wrapper agreed no matter
what the prompt contained — and the prompt's contents were the entire question,
because scenarios substitute freshly minted per-run values into it.

**Rule:** a double for the thing an agreement is *about* can only confirm that
the two sides call each other. Where correctness depends on the shape of a real
input — a prompt, a schema, a wire format — one run against the real thing is
not extra coverage on top of the unit tests, it is the only coverage that can
fail.
