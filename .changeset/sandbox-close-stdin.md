---
"@tailored-ai/core": patch
---

The host and container sandboxes close a command's stdin too.

The previous fix closed stdin in `ExecTool`'s own `execFile` call, which is not
the path a running agent takes: `buildLoopOptions` gives every agent a sandbox —
defaulting to `host` — so `ExecTool.execute` returns at its `context.sandbox`
branch before reaching that code. The fix verified green in isolation while the
live deployment went on hanging for the full timeout on every affected command.

`HostSandbox.exec` and the container runner had the identical unclosed-pipe
problem. Both now end the stream, so a CLI that reads stdin when it is not a TTY
returns immediately instead of blocking until it is killed with empty output.

Measured on the Notion CLI through a real agent: `ntn api v1/users/me` went from
a 27-second failure to 235ms.
