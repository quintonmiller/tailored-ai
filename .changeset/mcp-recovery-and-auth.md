---
"@tailored-ai/core": patch
---

mcp: reconnect a dropped server, and name a rejected credential as one

Nothing registered an `onclose`. When a stdio child exited or an HTTP endpoint
stopped answering, the connection stayed in the manager's active set with an
unchanged config signature — and reconcile skips anything whose signature
matches, so it was **never restarted**. The server stayed dead until a config
change or a process restart, its tools stayed registered, and every call
returned `MCP call failed` to the agent, which cannot tell that from a bad
request.

A dropped connection now unregisters its tools and schedules a reconnect, with
an escalating delay so a flapping server does not spin. The delay resets only
after a connection has proved stable for a minute — resetting on "it connected"
would let a connect-then-drop server retry every second forever.

Connect failures are classified. A rejected credential is logged as
`AUTH FAILED`, names the config key to look at, and says plainly that retrying
will not fix it — because the fix is a person minting a new token, and Notion
PATs expire within a year. Everything else is reported as retryable. `401`,
`403`, `invalid_token`, `invalid api key`, `authentication failed` and
`expired token` are recognised; `ECONNREFUSED`, `socket hang up`, timeouts and
`500` are deliberately not.

Backoff applies **only to self-driven retries**. An explicit `reconcile()` —
startup, config reload — always attempts every failed server, because the human
triggering it may have just fixed the credential, and "fix the token, reload,
nothing happens" is worse than the hammering the backoff prevents.

Adds `McpManager.status()` reporting per-server connected state, tool count,
retry window and whether the last failure was an auth failure — the data an
integration-health surface needs (#207).
