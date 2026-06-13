---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Native MCP client support: declare Model Context Protocol servers under `mcp.servers` in config.yaml (stdio via `command` or streamable HTTP via `url`) and their tools are discovered and registered into the tool registry as `mcp_<server>_<tool>`, selectable per agent like any other tool. Servers reconcile on hot reload (start/stop/restart on config change), failed connections retry on the next reconcile, and `tools/list_changed` notifications re-discover live. The `@modelcontextprotocol/sdk` dependency is optional and loaded on first use.
