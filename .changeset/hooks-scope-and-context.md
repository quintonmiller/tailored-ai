---
"@tailored-ai/core": patch
---

Fix two ways a config-declared hook was not what it looked like.

**Most events bound a hook that never fired.** Dispatch scoped by
`payload.agent`, and only 10 of the 34 bindable event names carry that field.
The other 24 passed `validateConfig`, logged nothing, and did nothing. Four of
them — `agent.completed`, `agent.dispatched`, `agent.stalled`,
`task.needs_human` — name the agent right there in the payload under
`agentName`, and the scoping did not look. The remaining twenty name no agent at
all, because a task transition or a proposal opening happens to a deployment
rather than to an agent, and there was nowhere to declare a hook that was not an
agent's.

Three parts, because a partial fix here is a worse lie than the bug:

- Both spellings are read, and normalised before matching, so `when: { agent: … }`
  means one thing across the catalog instead of depending on which word a given
  event happens to use.
- A top-level `hooks.on` declares the deployment's own hooks, which fire on every
  occurrence. Deliberately only `on` — `beforeRun`/`afterRun` are points in *an
  agent's* turn and mean nothing without one. Deployment hooks run first, so an
  agent's hook cannot preempt a rule the operator set for everyone.
- `validateConfig` now warns when a hook is declared under an agent on an event
  that names none, and points at the top level as the fix. The classification is
  a compile-time guard against `RuntimeEventMap`, the same shape that already
  pins the broadcast list, so a new event arrives classified or fails the build.

The irony is on the record: `hooks.on` keys off TAI's own event catalog
specifically so that a mistake is a warning rather than a hook that silently
never fires. It caught the typo and shipped a fresh instance of the same disease
underneath it.

**A hook was more privileged than the agent it guarded.** A tool invoked from a
hook got a context built from scratch — no `workingDirectoryBoundary`, no
`execRules`, and `workingDirectory` set to the server process's cwd rather than
where the agent works. So a hook calling `exec` ran outside the deployment's
command allowlist, and one calling `write` could leave a worktree boundary that
confined the agent whose calls it was there to police. That is the wrong way
round: a guard that outranks what it guards can be used to escape the
confinement it exists to enforce.

The cause was that "the context an agent's tools run with" was assembled in two
places and they disagreed. There is now one builder on the runtime, used by both
the loop and the hook path, so a field added to it cannot reach one caller and
miss the other. This is the second time that exact split has produced a
security-relevant no-op — the first is recorded in `config-schema.ts`, where
`fileBoundary` never reached `toolContextExtras` and three agents ran with a
declared filesystem confinement that did nothing.
