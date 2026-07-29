---
"@tailored-ai/core": patch
---

security: close the config-to-host-shell path (#279, #280)

`admin` is a meta tool appended to every agent, so whatever its config allowlist
permits, every agent can do. That allowlist included `custom_tools.`, and
`CustomTool.execute` discarded its `ToolContext` — the parameter was literally
named `_context` — ending at `bash -c` on the host with no boundary check and no
sandbox routing.

So an agent could write itself a shell-backed tool and call it in the same run
(tools re-resolve every round). For an agent with `sandbox: docker` that was a
complete container escape, and it was also a write path into the context
directory injected into every agent's prompt. No adversarial intent required:
one agent asked, in a room, whether it should point a tool at the host's binary
because its container lacked one. That would have worked, and nothing would have
reported it.

Three changes:

- **`custom_tools.`, `permissions.` and `context.` are no longer agent-writable
  config paths.** `permissions.` was the approval gate governing the write
  itself; `context.` redirects where prompt-injected files are read from. A
  human editing config.yaml can still set all three.
- **`CustomTool` honours its context**, applying the same parent-repo boundary
  check as `exec` and routing through the sandbox when one is attached. The
  load-bearing half is the sandbox: a sandboxed agent's custom-tool commands now
  run inside the container.
- **`create_tool` no longer adds the new tool to the calling agent's `tools:`
  list.** Creating a tool and being allowed to run it are separate decisions;
  self-granting collapsed them, so an agent without `exec` could obtain shell it
  was never granted. The tool is still created, and the result says plainly that
  the grant is a human's to make.
