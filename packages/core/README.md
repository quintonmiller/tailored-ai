# @tailored-ai/core

Lightweight, modular AI agent framework optimized for local LLMs (vLLM,
Ollama, LM Studio) — with first-class support for OpenAI- and
Anthropic-hosted models too.

The core library: a runtime, hot-reloadable config, a tool registry, a
small set of built-in tools (read/write/exec, web fetch/search, memory,
tasks), a streaming agent loop, SQLite-backed sessions, providers, channels
(Discord, web), cron, and hooks.

Use this package when you want to **embed** an agent into your own Node
service. For an end-user CLI, install [`@tailored-ai/cli`](../cli) instead.

```bash
npm install @tailored-ai/core better-sqlite3
```

## Quick start

```ts
import Database from "better-sqlite3";
import {
  AgentRuntime,
  createProvider,
  loadConfig,
  runAgentLoop,
} from "@tailored-ai/core";

const config = await loadConfig("./config.yaml");
const db = new Database("./agent.db");
const provider = createProvider(config);

const runtime = new AgentRuntime({ config, db, provider });
const loopOptions = runtime.buildLoopOptions({ agent: "default" });

await runAgentLoop({
  ...loopOptions,
  messages: [{ role: "user", content: "Hi" }],
});
```

A minimal `config.yaml` (full reference: `config.example.yaml` in the
[repo root](https://github.com/quintonmiller/tailored-ai/blob/main/config.example.yaml)):

```yaml
provider:
  type: ollama          # or: openai, anthropic, vllm
  model: llama3.2
agents:
  default:
    instructions: "You are a helpful assistant."
    tools: [read, write, web_fetch]
```

## What's in the box

| Area | Modules |
|---|---|
| Runtime + hot reload | `AgentRuntime`, `loadConfig`, `validateConfig` |
| Agent loop | `runAgentLoop`, `resolveAgent`, history compaction, retry, timing |
| Tools | `read`, `write`, `exec`, `web_fetch`, `web_search`, `memory`, `tasks`, `delegate`, `claude_code`, `browser`, plus a `custom` tool loader |
| Channels | Discord (`DiscordChannel`), HTTP/SSE (via `@tailored-ai/server`) |
| Providers | `ollama`, `openai`, `anthropic`, `vllm`/OpenAI-compatible |
| Sandboxes | host, docker, podman — `createSandbox`, `globalSandboxRegistry` |
| Worktrees | `createWorktree({ strategy: "head" \| "branch" \| "merge-to-head" })` |
| Tasks | pluggable backends: native, GitHub Issues, beans, beads |
| Memory | tiered recall with embeddings + promotion |
| Cron | named jobs with prompt expansion (`{{next_task}}`, etc.) |

## Optional peer dependencies

Some tools require extra packages installed at the host:

| Peer | Used by | Install when |
|---|---|---|
| `playwright` | `browser` tool, `browser-mediator` | You enable headless-browser tools |
| `md-to-pdf` | `md_to_pdf` tool | You generate PDFs from Markdown |
| `vitest` | `@tailored-ai/core/testing` | You consume the contract-test helpers from a vitest suite |

The tools `import()` these lazily and fail with a clear "run `npm install …`"
message if missing.

## Test helpers

The `@tailored-ai/core/testing` subpath exposes `runChannelContractSuite` —
plug a small harness in and the suite drives your `Channel` through the
contract assertions (id/type, connect/disconnect, send round-trip,
onMessage observer, plugin registration). `@tailored-ai/channel-slack` is
the first adopter; mirror its `src/__tests__/channel.test.ts` when writing
a new channel.

## Design philosophy

- **Short system prompts.** Local models degrade past ~500 tokens.
- **Few tools per request.** Local models struggle with large tool menus.
- **No conditional response tokens.** "Reply NO_REPLY if …" patterns
  misfire on small models.
- **Simple agent loop.** chat → tool calls → chat → stop. No state machines.
- **Hot-reloadable.** Config, tools, and provider are mutable at runtime.

## Docs

Architecture, agent loop internals, agents and hooks, tasks, memory tiers,
sandboxes, workflows, projects, skills, browser mediator, trusted actions
— all under [`docs/`](https://github.com/quintonmiller/tailored-ai/tree/main/docs)
in the monorepo.

## License

MIT.
