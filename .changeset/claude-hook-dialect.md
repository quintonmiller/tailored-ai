---
"@tailored-ai/core": patch
---

A hook can be a program.

`builtin:claude-hooks` registers the `command` handler on the seam the previous
change opened: run a program, hand it the event as JSON on stdin, read its
answer off stdout and its exit code. Exit 2 refuses with stderr as the reason;
`permissionDecision: "deny"` refuses with a written one; `updatedInput` rewrites
the call; anything else is advisory and `denyIf` can still match it.

**What this is for, stated honestly, because the obvious pitch is wrong.** It is
not portability. Claude Code's tools are `Bash`, `Read`, `Write`, `Edit`; TAI's
are `exec`, `read`, `write`, `edit`. Matchers are exact, so `"matcher": "Bash"` —
the commonest example in the wild — matches nothing here, and a borrowed script
would run and gate nothing, which is worse than failing. TAI deliberately does
*not* rename `exec` to `Bash` on the way out: manufacturing that compatibility
would send the script's own logic after the wrong thing.

What it delivers is that a hook can be written in any language. Their JSON shape
is used because it is documented and already implemented by several others, and
there is no reason to invent a third one.

**Seeded disabled.** Every other hook can only reach a tool the deployment
already registered and enabled — a real boundary, and this removes it by handing
config the ability to run arbitrary programs with the agent's privileges. That
should be a decision somebody made, not a default they inherited. The
environment is scrubbed of `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*`,
`OPENAI_*`, `ANTHROPIC_*` and `OTEL_*` — not a boundary, since the hook runs as
the agent, but hygiene against a credential riding along into a subprocess.

One deliberate divergence from their contract: a `command` whose binary does not
exist **refuses** on a refusable event, where Claude Code treats a broken hook
as advisory. An unregistered *tool* is skipped because the deployment may have
disabled that plugin elsewhere and an unrelated call should not pay for it; a
`command` is named right there in the hook, so its absence is unambiguous and
the check this call was supposed to get did not happen.

Also completes `updatedInput`'s counterpart in core: an `EventHookResult` may
now return `args`, and a rewrite is carried forward so later hooks in the chain
review the call as it now stands rather than as first asked.
