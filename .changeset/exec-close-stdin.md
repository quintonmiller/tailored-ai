---
"@tailored-ai/core": patch
---

`exec` closes the command's stdin instead of leaving an open pipe.

`execFile` hands the child a stdin pipe that is never written to and never
closed, so any CLI that reads stdin when it is not a TTY blocks until the tool's
timeout kills it. The kill discards the buffers, so what reaches the agent is
empty stdout, empty stderr and a bare `Command failed` — which reads as "that
binary isn't installed" rather than "it is waiting for input".

Found with the Notion CLI: `ntn api v1/users/me` returned fine, while
`ntn api v1/users/me | jq -r .name` hung for the full 30 seconds, and the model
concluded — reasonably, and wrongly — that `ntn` was missing.

`stdio` is not honoured by `execFile`, which owns the pipes in order to buffer
them, so the stream is closed on the returned child instead.
