# Trusted-actions: HITL purchase flow

Approval-gated execution of high-stakes operations (currently: Amazon
purchases). Separate process from TAI; holds credentials TAI never sees.
Push notification → user taps Approve → executor completes the action.

## Architecture

```
TAI agent ─[enqueue]──▶ trusted-actions executor ─[exec]─▶ Amazon (Playwright)
              ▲                  │
              │ (status only)    │ (push to phone — own VAPID keys)
              │                  ▼
              │           user phone ─[tap Approve]──▶ executor
              │
              └─ TAI cannot approve. Only user (via push token) can.
```

The cryptographic separation is the load-bearing property: the approval
token is generated inside the executor, never crosses to TAI, and the
phone sends approvals directly to the executor's HTTPS endpoint. Even
full TAI compromise can't auto-approve.

## What's in TAI today

The HITL purchase flow has these moving parts now landed on `main`:

| Part | Where | What |
|---|---|---|
| Executor server | `packages/trusted-actions/src/server.ts` | Hono server on `:3100`, all endpoints below |
| DB schema | `packages/trusted-actions/src/db/migrations.ts` | `actions`, `approvals`, `audit_log`, `push_subscriptions` |
| Approval crypto | `packages/trusted-actions/src/approval/{crypto,token-store}.ts` | 32-byte tokens, HMAC-SHA256 hash, one-time consume, expiry |
| Spending caps | `packages/trusted-actions/src/caps/enforcer.ts` | `per_request | per_day | per_month`, each `number | null` |
| Audit log | `packages/trusted-actions/src/audit/log.ts` | Hash-chained; tamper-detectable via `verifyAuditChain()` |
| Playwright adapter | `packages/trusted-actions/src/adapters/purchase-amazon.ts` | Stealth headless Chromium + checkout flow |
| TAI tools | `packages/trusted-actions/src/tools.ts` | `purchase_item`, `request_action`, `request_read`, `check_action_status` — registered by the same plugin entry as the routes |
| TAI-side routes | `packages/trusted-actions/src/plugin.ts` | `/api/trusted-actions/*` on the TAI server — registered through core's HTTP route seam (see below) |
| UI page | `packages/ui/src/pages/Actions.tsx` | Pending / Recent / All tabs, cancel button |

### What the package registers on the TAI side

Both halves of the TAI-side integration now ship here, registered by one plugin
entry (`@tailored-ai/trusted-actions/plugin`):

| | Seam | Registered as |
|---|---|---|
| Four agent tools | `ctx.tools` | `trusted_actions` tool factory |
| Four HTTP routes | `ctx.http` | `/api/trusted-actions/*` |

The tools lived in `@tailored-ai/core` until #616 and moved for the same reason
the routes did: they are client code for one executor — including a tool that
buys things on Amazon — which `CLAUDE.md` puts outside the kernel ("a feature
that serves one use case does not belong here, even a popular one"). Core now
ships no knowledge of this integration beyond the `trustedActions` config block
that both halves read.

**No config change is needed.** The CLI auto-loads this plugin whenever
`trustedActions.enabled` is set, so the tools appear exactly when they did
before. The factory keeps the same gate: nothing registers unless `url` and
`sharedSecret` are both present.

### TAI-side HTTP routes (registered by the package)

The `/api/trusted-actions/*` routes on the TAI server — the executor pass-throughs and the executor → TAI callback — used to live in `@tailored-ai/server`. They are product-specific, so they now ship in `@tailored-ai/trusted-actions` and register on the TAI server through core's plugin HTTP route seam (`ctx.http`, see [docs/architecture.md → Plugin HTTP Routes](./architecture.md#plugin-http-routes)).

- **Where**: `packages/trusted-actions/src/plugin.ts` exports a `default(ctx)` plugin (subpath `@tailored-ai/trusted-actions/plugin`). It builds four route descriptors and registers them via `ctx.http`.
- **Paths kept**: the routes are registered `absolute: true`, so they mount at their historical paths — the UI (`/api/trusted-actions/subscriptions`) and the executor (`/api/trusted-actions/callback`) keep working with no change.
  - `GET  /api/trusted-actions/subscriptions` — list push subscriptions (proxies the executor).
  - `POST /api/trusted-actions/subscriptions/:op` — `approve | reject | delete` a subscription.
  - `GET  /api/trusted-actions/history` — recent action history.
  - `POST /api/trusted-actions/callback` — executor → TAI terminal-status notification.
- **Auth**: the first three are `auth: "token"` (default) — behind the server's `server.authToken` bearer check, same as every `/api/*` route. The callback is `auth: "none"` — it is called by the executor service, not a browser, and authenticates with the `trustedActions.sharedSecret` itself (exactly the behavior it had in the server). The server's auth middleware exempts it by path.
- **Loading**: the CLI loads `@tailored-ai/trusted-actions/plugin` as a runtime-context plugin (it needs `ctx.runtime` for live config + the session DB) when `trustedActions.enabled` is set, even if the user hasn't listed it in `config.plugins`. It is an `optionalDependencies` of the CLI, so installing the CLI without the executor package still works — the routes only register when the package is present and the executor is enabled.

## Setup

The executor runs in **Docker** — same pattern as the coder/reviewer
sandboxes. Single-command bring-up; no unix user creation, no systemd
plumbing, no nvm-PATH games.

```bash
# 1. One-shot setup (generates secrets, builds image, starts container)
bash scripts/setup-tai-executor.sh

# 2. Headed Chromium for the one-time Amazon login
bash scripts/tai-executor-setup-amazon.sh

# 3. Paste the printed shared_secret into TAI's config.yaml:
#    trustedActions:
#      enabled: true
#      url: http://localhost:3100
#      sharedSecret: <printed value>
```

That's it for the local LAN test. For remote access (push from your
phone while away), stand up the hosted-proxy tunnel and set
`TA_PUBLIC_BASE_URL` in `docker/trusted-actions/.env`.

Day-to-day:
```bash
docker compose -f docker/trusted-actions/docker-compose.yml up -d
docker compose -f docker/trusted-actions/docker-compose.yml logs -f
docker compose -f docker/trusted-actions/docker-compose.yml down
```

## What's in the .env file

Generated by the setup script in `docker/trusted-actions/.env` (mode
600, gitignored):

```bash
# Crypto
TAI_EXECUTOR_PASSPHRASE=<openssl rand -hex 32>
TA_SHARED_SECRET=<openssl rand -hex 32>      # mirror into TAI's config
APPROVAL_HMAC_KEY=<openssl rand -hex 32>

# Runtime
TA_PORT=3100
TA_DB_PATH=/data/executor.db
TA_PUBLIC_BASE_URL=http://localhost:3100     # change to hosted-proxy URL
TA_APPROVAL_ASSIGNEE=                        # optional; who an approved
                                             # capability task is assigned to.
                                             # Unset leaves the assignee alone.

# Spending caps — number or "unlimited"
TA_CAP_PER_REQUEST=100
TA_CAP_PER_DAY=500
TA_CAP_PER_MONTH=2000

# Playwright browsers (baked into the image)
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
```

## End-to-end flow

1. **Agent decides**: `purchase_item({ query: "X", max_price: 25, why: "..." })`
2. **TAI tool** POSTs to executor `/internal/enqueue` with the shared secret
3. **Executor** validates input via the action adapter's `validate()`, fetches the `ApprovalCard` via `describeForApproval()`, checks caps, generates a token, stores its HMAC, sends push notifications via VAPID
4. **Phone** displays notification with **Approve** / **Reject** buttons (URLs carry the one-time token)
5. **User taps Approve** → `POST /approve/<token>` → executor verifies, marks approved, queues for execution
6. **Runner** picks up the approved action, calls `adapter.execute(input, ctx)`, writes result + audit
7. **Agent** polls via `check_action_status(action_id)` → sees `completed` + result (order ID, final price, ETA)

## Endpoints

### Public (the phone hits these)
- `POST /approve/:token` — consume token, mark approved
- `POST /reject/:token` — consume token, mark rejected
- `POST /actions/:id/cancel` — mark pending action as rejected (no token; UI fallback)
- `GET /actions?status=pending_approval&limit=50` — list for the `/actions` page

### Internal (TAI hits these, Bearer auth required)
- `POST /internal/enqueue` — agent enqueues a new action
- `GET /internal/actions/:id/status` — TAI polls status
- `POST /internal/push/subscribe` — register a VAPID subscription

### Public health
- `GET /health` — returns registered action types

## Security properties

See [`docs/trusted-actions-threats.md`](./trusted-actions-threats.md) for
the full threat model. The three load-bearing claims:

1. **TAI cannot approve.** Tokens live in the executor's process memory
   (during enqueue → push) and the executor's DB (as HMAC hashes). TAI
   never sees the cleartext.
2. **One-time use, time-bounded.** Token is consumed on first valid call;
   expires in 1h.
3. **Audit on every transition.** `audit_log` is hash-chained; tampering
   the chain is detectable via `verifyAuditChain()`.

## Pre-production checklist

- [ ] `bash scripts/setup-tai-executor.sh` — runs the executor in Docker
- [ ] `bash scripts/tai-executor-setup-amazon.sh` — one-time login
- [ ] Paste `TA_SHARED_SECRET` into TAI's `config.yaml` under `trustedActions.sharedSecret`
- [ ] Stand up hosted-proxy (`ptask_600d8e8e`) so push reaches phone off-LAN
- [ ] Edit `docker/trusted-actions/.env` → set `TA_PUBLIC_BASE_URL` to tunnel URL → restart
- [ ] Register phone push subscription via `/internal/push/subscribe`
- [ ] Make a $5 test purchase, verify order arrives, audit trail intact

## Open follow-ups (logged as future tasks)

- **TA2.2 endpoints** — most are landed; the remaining piece is wiring
  the runner to start at executor boot (currently must be started
  programmatically by the consumer)
- **TA6 hardening** — daily summary push, nightly DB backup, audit
  verifier on boot
- **Re-login flow** — when Amazon session expires, executor sends a push
  prompting user to run setup CLI
- **Per-action-type renderers in `/actions` UI** — currently the
  PurchaseAmazon card is rendered inline; for new action types we'd want
  a registry like `packages/ui/src/actions/registry.tsx`

## Why this design

If you find yourself thinking "why so many moving parts for buying
something on Amazon," the answer is: **a single line of code in TAI's
agent loop should never be able to spend your money.** Every layer here
exists to make that statement provably true under hostile conditions
(prompt injection, model malfunction, prompt-engineered exfiltration).
The credential-isolation + token-based approval pattern generalizes
beyond purchases — any future action that needs "this is high-stakes and
should require my tap" (SSH on home server, expensive API calls,
subscription cancellation, paying a bill) can register a new
`TrustedAction` adapter and inherit the whole approval + audit + caps
pipeline.
