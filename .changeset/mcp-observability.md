---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

MCP observability (#249). Connected MCP servers were silent — "no log lines" was indistinguishable from "never ran", and the #248 drop-on-reload bug surfaced nothing. Now `McpManager` logs the happy path: one line per server on connect (`[mcp:github] connected (3 tools: ...)`), on tool-list change, and on teardown/restart. The CLI startup banner gains an `MCP: github (3), ...` line (only when servers are configured), and `McpManager.list()` now reports `connectedAt`. New `GET /api/mcp` route (wired via the server's `mcpStatus` option) exposes per-server id, tool names, tool count, and ISO connected-at for the UI / `tai doctor`.
