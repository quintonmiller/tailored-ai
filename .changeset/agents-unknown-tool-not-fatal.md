---
"@tailored-ai/core": patch
---

agents: a bad tool name no longer takes the agent offline, and meta tools resolve

`resolveAgent` threw on any unrecognised name in an agent's `tools:` list. Two
consequences, both found in a log nobody was reading:

- `runtime.getTools()` returns the tool registry, but `buildLoopOptions` appends
  meta tools (`admin`, `delegate`, `memory`, …) *after* resolving — so naming one
  in `tools:` was fatal even though the agent holds it at run time. Every
  `resolveAgent` call site now resolves against `getResolvableTools()`: registry
  plus meta, which is what the agent will actually have.
- A genuine typo (`trello`, or a stray `[`) is now skipped with a warning, once
  per process, the way skill and `mcp_*` refs already were. In a room, throwing
  meant the agent simply stopped answering, indistinguishable from having nothing
  to say. `admin.update_config` refuses the write instead, which is the moment
  someone is looking.
