# @tailored-ai/server

HTTP API server for [Tailored AI](../core/). Hono-based routes for
sessions, agents, workflows, tasks, memory, and resources, plus SSE for
streaming responses and webhook endpoints for cron / external triggers.
Optionally serves a static UI build alongside the API.

This is the HTTP surface that the [`tai` CLI](../cli/) and the
[`@tailored-ai/ui`](../ui/) frontend both talk to. You can embed it in
your own Node process to expose your agent over HTTP.

```bash
npm install @tailored-ai/server @tailored-ai/core
```

## Quick start

```ts
import Database from "better-sqlite3";
import {
  AgentRuntime,
  createProvider,
  loadConfig,
} from "@tailored-ai/core";
import { startServer } from "@tailored-ai/server";

const config = await loadConfig("./config.yaml");
const db = new Database("./agent.db");
const provider = createProvider(config);
const runtime = new AgentRuntime({ config, db, provider });

await startServer({ runtime, port: 3000 });
// GET  /api/agents
// POST /api/sessions/:id/messages   (SSE stream)
// POST /api/workflows/:name/run
// GET  /                            (UI, if uiDist provided)
```

To serve the bundled UI, pass `uiDist` pointing at a built SPA directory
(the CLI does this automatically with the UI bundle it ships).

## What's exposed

- `/api/agents`, `/api/sessions`, `/api/messages` — chat surface
- `/api/workflows/...` — workflow CRUD + run endpoints
- `/api/tasks`, `/api/projects` — task and project management
- `/api/memory/...` — memory recall, search, promotion
- `/webhooks/...` — external triggers (Stripe, GitHub, custom)
- `/sse/...` — streaming response channel

See `src/index.ts` for the full route table.

## Docs

[`docs/architecture.md`](https://github.com/quintonmiller/tailored-ai/blob/main/docs/architecture.md)
covers the integration model and how the server hangs off `AgentRuntime`.

## License

MIT.
