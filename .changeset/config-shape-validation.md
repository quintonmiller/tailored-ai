---
"@tailored-ai/core": patch
---

Config values are checked against the type their field is declared as, at load and at every runtime write.

`AgentConfig` is a TypeScript interface, so it is erased at runtime and there was
nothing left to compare a parsed value against. `validateConfig` is a *semantic*
checker — this tool needs an api key, that agent references a tool nobody
enabled — and none of that goes away; what was missing is the layer in front of
it. The failure mode it left open is the worst kind: the file parses, it reads
correctly to a human, and the setting does nothing.

```yaml
cron:
  jobs:
    - name: nightly-sweep
      enabled: "false"     # quoted
```

`scheduler.ts` asks `job.enabled !== false`, and `"false" !== false`, so the job
stayed scheduled. An agent had been asked to disable it, wrote exactly that, and
reported "Done". It ran four more times over the next six hours while the log
said "Skipping disabled job" for the four jobs whose flags were real booleans.
The finding now names the inversion: *"`enabled` must be a boolean, got the
string "false". The quotes make it text. A non-empty string is truthy, so this
currently reads as `true`. Write `false` without them."*

Reported at startup alongside the existing warnings, and — through
`findInertConfig` (renamed from `findUnknownKeys`, which stays as a deprecated
alias) — enough to **refuse a runtime write** that would introduce one. Refusing
is the half that matters: a startup warning is a warning nobody reads six hours
later, while a rejected write answers the agent that got it wrong, still holding
the pen. As before, findings are diffed against a pre-write snapshot, so a
pre-existing one never blocks an unrelated write.

The stronger driver was drift. `AgentDefinition`'s field list existed in three
hand-maintained copies — the interface, `KNOWN_AGENT_KEYS`, and
`AGENT_DEFINITION_FIELDS` — kept in step by a docstring asking you to. When they
were not: `fileBoundary` never reached `toolContextExtras`, so three agents
holding `write` and `edit` ran with a declared filesystem confinement that did
nothing, and thirteen agents set `injectMemory: true` and never got a single
injected memory. All three now derive from one zod schema, and a
`Identical<z.infer<typeof Schema>, AgentDefinition>` assertion fails the build if
the schema and the interface disagree by so much as an optional field. The
interface is kept rather than inferred, because inferring it would delete every
doc comment on it — the only place the *why* of a field is recorded.

Scope: `AgentDefinition` and `CronJobConfig` are checked field by field.
`tools.*`, `channels.*` and `mcp.servers.*` are open bags holding plugin config
that core must never know the shape of, so only `enabled` is judged there — the
one field they all share, and one that enables what it claims to disable when
it arrives quoted.

Also fixes a privileged built-in that fell out of the old hand-written checks:
`parseAgentData` rejected any `sandbox` other than `host`/`docker`/`podman`, so
an agent naming a plugin-registered kind failed to load at all. Sandbox kinds
come from an open registry and `createSandbox` already validates against the
live one, with a "Known: …" message, at the point of use.

Adds `zod` as a dependency of `@tailored-ai/core`.
