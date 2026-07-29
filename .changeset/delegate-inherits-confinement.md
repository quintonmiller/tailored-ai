---
"@tailored-ai/core": patch
---

delegate: sub-agents inherit the confinement their agent declares

`delegate` hand-built its `AgentLoopOptions` instead of going through
`runtime.buildLoopOptions`, carrying 13 of the ~25 fields the real one sets —
and none of the confinement ones. A delegated sub-agent inherited no sandbox,
no `workingDirectoryBoundary`, and no agent name.

`delegate` is a meta tool appended to every agent regardless of its `tools:`
list, so this was reachable from anywhere: `delegate(agent="coder", …)` ran
coder's `write`/`exec` on the host with its `sandbox: docker` silently inert.
Same hole as the `CustomTool` one, by a different route.

It now takes the runtime and uses the same path every other dispatch does, so a
sub-agent gets the sandbox, boundary, attribution, cwd and shutdown signal a
top-level turn for that agent would get.

`buildLoopOptions` gains `includeMetaTools` (default true). `delegate` passes
false, keeping the sub-agent's tool set exactly its own `tools:` list as
before — a containment fix should not hand a sub-agent `admin` or a second
`delegate` on the way past. A meta tool the agent names in its own `tools:` is
unaffected.

**Behaviour change worth knowing:** delegating to an agent that declares a
sandbox now actually starts it. Where that previously ran on the host and
"worked", it will now fail if the container cannot start — which is the point,
but it is a failure where there was none.
