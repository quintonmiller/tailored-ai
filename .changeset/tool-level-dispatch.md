---
"@tailored-ai/core": patch
---

The loop says when a tool is about to run, and when one did.

`executeToolCall` ran an ordered chain of gates — skill allowlist, validation,
approval, derivability, execute — and nothing extensible attached to any of it.
The runtime bus declared 28 events and not one was at tool level. Three separate
pieces of work were blocked on that same absence: an approval stage any tool can
use, a hook dialect with `PreToolUse` to bridge, and a workflow trigger that
fires on a tool call.

`agent.pre_tool_use` is a **waterfall**, because refusing is the weaker of the
two useful answers. A subscriber can set `deny` — the text goes back to the
model in place of the tool's output — or replace `args`, which is the difference
between a guard that says no and one that says "not like that": narrow a path,
drop a flag, cap a limit. The tool name is deliberately not replaceable, since
swapping it would leave the model's own record of what it called wrong.

Two placement decisions, both asserted rather than assumed. It dispatches
**before the approval gate**, so a rewrite reaches the human who approves it
rather than a human approving one call while another runs. And **before
validation**, so whatever actually executes is what got validated — a subscriber
is not more trusted than the model. What must stay authoritative after a human
says yes stays where it already is, inside the tools: `exec`'s allowlist, the
path boundary, the sandbox.

`agent.post_tool_use` is a broadcast — the call has happened. Only calls that
ran reach it, which is what lets a subscriber count executions rather than
intentions, and `args` is what the tool was given, so a rewrite is visible there.

**Fixes a live bug as the first consumer.** `tool_called` has been a declared
workflow trigger, validated by the loader and advertised through the trigger
registry the UI reads as "Fires when a specific tool is invoked" — with nothing
dispatching it. A deployment could write the config, watch it validate, and get
no warning, no error and no run. It could not be fixed alone: every other
trigger kind has a poller, and this one needed to know when a tool ran.

`builtin:tool-called-trigger` now delivers it, enabled by default — the promise
was already made to deployments relying on it, and a fix they had to switch on
would leave them where they were.
