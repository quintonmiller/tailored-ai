# MCP client support

TAI consumes [Model Context Protocol](https://modelcontextprotocol.io) servers natively: declare servers in config, their tools are discovered at startup and registered into the normal tool registry, and agents select them like any other tool. MCP is a protocol-level capability — like `openai_compatible` for providers — so it lives in core (`packages/core/src/mcp/`), not a plugin. Tracked in #99.

## Configuration

```yaml
mcp:
  servers:
    github:                       # serverId — becomes the tool-name prefix
      command: npx                # stdio transport: TAI spawns the process
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
      tools: [search_issues, get_issue]   # allowlist; omit to expose all
    internal:
      url: https://mcp.example.com/mcp    # streamable-HTTP transport
      headers:
        Authorization: Bearer ${MCP_TOKEN}
      timeoutMs: 30000
```

Exactly one of `command` (stdio) / `url` (streamable HTTP) per server — `validateConfig` warns and the entry is skipped otherwise. Entries are enabled unless `enabled: false`. The fields match the `mcpServers` JSON shape other MCP hosts use, so server configs copy-paste in. `${VAR}` interpolation applies as everywhere in config.yaml. For stdio servers, `env` is merged over the SDK's safe default environment (PATH survives).

## Tool naming and agent selection

Discovered tools register as `mcp_<serverId>_<toolName>` (sanitized to `[a-zA-Z0-9_-]`, capped at 64 chars), with the server's `inputSchema` passed through as the tool's parameters. Agents reference them like any tool:

```yaml
agents:
  triage:
    tools: [read, mcp_github_search_issues]
```

Two local-model guardrails:

- **Keep the exposed set small.** A 30-tool MCP server wholesale will sink tool selection on local models (~5 tools per request is the ceiling — see CLAUDE.md). Use the per-server `tools:` allowlist and per-agent `tools:` lists.
- An agent's `mcp_*` reference that isn't (yet) discovered is **skipped with a warning, not an error** — servers connect asynchronously and can be down. The loop re-resolves tools every iteration, so the tool joins the agent's set as soon as discovery lands, without a restart.

## Lifecycle

`McpManager` (exported from core) mirrors `ChannelLifecycleManager`: it reconciles the running server set against config — starts new servers, stops removed ones, restarts changed ones (config-signature comparison) — and syncs each connection's tools into the runtime's tool registry. The CLI wires it in both entry modes:

- startup: `await mcpManager.reconcile(runtime)` (single-message runs included)
- hot reload: `runtime.onReload(...)` reconciles again — this also re-registers tools into the fresh registry that `runtime.reload()` swapped in
- shutdown: `stopAll()` closes connections (and kills stdio children)

A server that fails to connect is logged and skipped; the next reconcile retries it. Servers that emit `notifications/tools/list_changed` get their tool set re-discovered live. Registered tools carry origin `mcp:<serverId>/<toolName>` (`scheme: "mcp"`), visible in `listWithManifests()` / the resources UI.

Library consumers (not using the CLI) wire the same three calls; `McpHost` is the narrow interface the manager needs (`getConfig` + `getToolRegistry`).

## Observability (#249)

Success is no longer as silent as failure. Each lifecycle transition logs one line so "no log lines" stops being ambiguous:

- connect: `[mcp:github] connected (3 tools: mcp_github_search, ...)`
- tool list change: `[mcp:github] tools updated (4 tools: ...)`
- teardown: `[mcp:github] disconnected (removed from config)` / `(shutdown)`, or `config changed — reconnecting` on a restart

The startup banner gains an `MCP: github (3), linear (2)` line (printed only when servers are configured) — MCP servers connect asynchronously and aren't in the one-shot `Tools:` line. `McpManager.list()` returns `{ serverId, tools, connectedAt }` per connected server, surfaced at `GET /api/mcp` (wired via the server's `mcpStatus` option). `tai doctor` (#114) is the remaining consumer once that command exists.

## Dependency

`@modelcontextprotocol/sdk` is an optional dependency of core, dynamically imported on first connect (same pattern as pdf-parse/playwright). npm installs optional deps by default; if it's absent, connecting fails with an install hint and the rest of the runtime is unaffected. No SDK types appear in core's public API — `src/mcp/client.ts` uses structural types so core compiles without the package.

## Current limits

- Tools only — MCP resources, prompts, sampling, and elicitation are not consumed yet.
- Transports: stdio + streamable HTTP. The deprecated HTTP+SSE transport is not supported.
- Tool results are flattened to text; image/audio blocks become `[image content (...)]` markers (the loop's tool results are text-only today).
- The inverse direction — exposing TAI itself as an MCP server — is #178.

Tests: `mcp-manager.test.ts` (reconcile semantics, fake connections), `mcp-client.test.ts` (real SDK over in-memory transport), `mcp-stdio.test.ts` (real spawned fixture server, `__tests__/fixtures/mcp-stdio-server.mjs`).
