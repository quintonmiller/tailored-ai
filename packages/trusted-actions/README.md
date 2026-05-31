# @tailored-ai/trusted-actions

A human-in-the-loop gateway for **risky** actions taken by an LLM
agent — placing orders, submitting forms, sending money. Pairs with the
[`@tailored-ai/core`](../core/) agent runtime but is independently
usable.

The agent proposes an action via the `request_action` tool. The proposal
lands in this service. A human approves it via a Web Push notification
to their phone. Only then does a separate executor process — running
inside Docker, with no access to the LLM — replay the approved steps
through Playwright.

The LLM never sees credentials and never touches the browser directly.

```bash
npm install @tailored-ai/trusted-actions
```

## Components

| Piece | What it does |
|---|---|
| **Approval gateway** (`hono` server) | REST + SSE for pending actions, approve/reject flow |
| **Push notifier** (`web-push`) | VAPID web-push to approver's phone PWA |
| **Executor runner** | Replays approved steps in a hermetic Docker container |
| **Playwright adapters** | One per site — Amazon ships as the reference adapter |
| **PWA** | Tiny SPA the approver installs on their phone |
| `tai-executor` bin | CLI wrapper: serve, run, test-purchase, install-token |

## Quick start

Setup is done from the monorepo root via shell helpers:

```bash
bash scripts/setup-tai-executor.sh             # one-time docker + .env
bash scripts/tai-executor-setup-amazon.sh      # headed Amazon login
bash scripts/tai-executor-tunnel-setup.sh      # Cloudflare Tunnel (HTTPS for push)
bash scripts/tai-executor-install-token.sh     # PWA install URL
```

Then in your agent config:

```yaml
tools:
  request_action:
    enabled: true
    executor_url: https://your-executor.example.com
```

The agent calls `request_action` with a JSON intent; you get a push
notification; you tap "Approve"; the executor runs.

## Docs

- [`docs/trusted-actions.md`](https://github.com/quintonmiller/tailored-ai/blob/main/docs/trusted-actions.md) — overview
- [`docs/trusted-actions-runbook.md`](https://github.com/quintonmiller/tailored-ai/blob/main/docs/trusted-actions-runbook.md) — operations
- [`docs/trusted-actions-threats.md`](https://github.com/quintonmiller/tailored-ai/blob/main/docs/trusted-actions-threats.md) — threat model
- [`docs/trusted-actions-roadmap.md`](https://github.com/quintonmiller/tailored-ai/blob/main/docs/trusted-actions-roadmap.md) — roadmap

## License

MIT.
