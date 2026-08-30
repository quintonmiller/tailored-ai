# Trusted-actions runbook

Operational guide for the HITL purchase executor. Covers setup, day-to-day
ops, the dry-run probe, troubleshooting (every issue we hit during
bring-up), and disaster recovery.

For the architecture + threat model see:
- [`docs/trusted-actions.md`](./trusted-actions.md) — what the executor is + how it works
- [`docs/trusted-actions-threats.md`](./trusted-actions-threats.md) — threat model + pre-prod sign-off

## What you need on the host

- Docker (with `docker compose`) — the executor runs as a container, no host-side Node/pnpm/Playwright needed
- A user account in the `docker` group (so `docker` runs without sudo)
- `openssl` (for generating secrets — present on every modern Linux)
- A desktop display for the one-time Amazon login (WSLg on Win11, Linux desktop, or `ssh -X`)
- An Amazon account with a default shipping address + a virtual card (Privacy.com or similar) already set as the default payment method

## Initial setup

Three commands, in this order:

```bash
# 1. Generate secrets, build the image, start the container
bash scripts/setup-tai-executor.sh

# 2. One-time Amazon login (opens headed Chromium on your desktop)
bash scripts/tai-executor-setup-amazon.sh

# 3. Dry-run probe — confirms the session is alive
bash scripts/tai-executor-probe.sh "https://www.amazon.com/dp/B0XYZ..."
```

Then paste the printed `sharedSecret` into TAI's `~/.tailored-ai/config.yaml`:

```yaml
trustedActions:
  enabled: true
  url: http://localhost:3100
  sharedSecret: <the value from the setup output>
  pollIntervalMs: 5000
```

Restart TAI. The agent will now have `purchase_item`, `request_action`, `request_read`, and `check_action_status` tools. They are registered by `@tailored-ai/trusted-actions/plugin`, which the CLI auto-loads whenever `trustedActions.enabled` is set — no `plugins:` entry required.

### What setup-tai-executor.sh does

Idempotent. Re-runnable safely.

1. Confirms Docker is running
2. Creates `docker/trusted-actions/{secrets,data,screenshots}/` (mode 700/755)
3. Generates `docker/trusted-actions/.env` (mode 600):
   - Three 32-byte hex secrets via `openssl rand -hex 32` (passphrase, shared_secret, approval_hmac_key)
   - Default spending caps ($100/req, $500/day, $2000/month)
   - `EXECUTOR_UID`/`EXECUTOR_GID` set to current user (so bind mounts work without chown)
4. `docker compose build executor` — multi-stage Dockerfile builds `@tailored-ai/trusted-actions` + its `@tailored-ai/core` workspace dep inside the container
5. `docker compose up -d executor`
6. Polls `/health` until 200
7. Prints the `shared_secret` for you to paste into TAI's config

### What setup-amazon.sh does

1. Confirms `.env` exists + image is built
2. Allows X access for the container (`xhost +local:`)
3. `docker compose --profile setup run --rm executor-setup-amazon` — opens headed Chromium pointed at `amazon.com`
4. Polls for the `at-main` cookie (the access token, set only after sign-in) AND nav text not saying "sign in"
5. When both true: serializes session storage + cookies, encrypts via AES-256-GCM with the passphrase, writes `docker/trusted-actions/secrets/amazon_session.json`
6. Caches default shipping address (used to detect address-swap attacks)
7. Chmod 600 on the saved file

## Day-to-day operations

```bash
# Status
docker compose -f docker/trusted-actions/docker-compose.yml ps
curl -s http://localhost:3100/health | jq

# Logs (tail)
docker compose -f docker/trusted-actions/docker-compose.yml logs -f

# Restart
docker compose -f docker/trusted-actions/docker-compose.yml restart

# Stop
docker compose -f docker/trusted-actions/docker-compose.yml down

# Start (after stop)
docker compose -f docker/trusted-actions/docker-compose.yml up -d
```

The container has `restart: unless-stopped` so it survives Docker daemon restarts. After a host reboot, Docker brings it back automatically.

## Dry-run probe (does NOT place orders)

Before letting TAI enqueue real purchases, sanity-check the saved session:

```bash
# By URL
bash scripts/tai-executor-probe.sh "https://www.amazon.com/dp/B0XYZ..."

# By search query (top-1 result)
bash scripts/tai-executor-probe.sh "usb-c cable"
```

What it does:
1. Loads + decrypts the saved Amazon session
2. Launches headless Chromium with the session
3. Navigates to the product (or top search result) as a logged-in user
4. Scrapes title, price, image
5. Prints the result and exits

What it does NOT do:
- No cart modification
- No checkout flow
- No order placed
- No DB writes (it doesn't go through `/internal/enqueue`)

Good output:

```
▸ probing Amazon (read-only — no cart, no purchase) …

✅ Saved session works. Scrape result:
   Title:        Purchase: Anker USB-C to USB-A Cable, 6 ft
   Body:         Price: $8.99
   Est. cost:    $8.99
   Image URL:    https://m.media-amazon.com/images/I/...

No cart modification, no order placed. Probe complete.
```

If it fails:
- **"Saved session expired"** → re-run `bash scripts/tai-executor-setup-amazon.sh`
- **"Failed to scrape product"** → Amazon's selectors may have changed. Open a GitHub issue with the URL.
- **"browser closed"** → Chromium crashed inside the container. Check `docker compose logs`; usually a memory issue.

## PWA + phone approvals

The executor ships a PWA (HTML + service worker + manifest) served at `/`. When an action is enqueued, the executor sends a VAPID-signed Web Push to every subscribed device. Tapping the notification opens an approve/reject URL that's HMAC-bound to that specific action.

### One-time setup

```bash
# 1. Generate the executor's VAPID keypair (encrypted in age-store).
docker compose -f docker/trusted-actions/docker-compose.yml \
  exec executor node /app/dist/cli/bin.js setup vapid

# 2. Restart so the keys are loaded.
docker compose -f docker/trusted-actions/docker-compose.yml restart executor

# 3. Stand up the Cloudflare Tunnel (HTTPS is required for Web Push).
bash scripts/tai-executor-tunnel-setup.sh
```

That script prompts for two things:
1. A Cloudflare **Tunnel token** (one screen in the Zero Trust dashboard).
2. The public URL you want (e.g. `https://approvals.example.com`).

It saves both into `docker/trusted-actions/.env`, brings up the `tunnel` profile, and restarts the executor. The tunnel sidecar dials Cloudflare's edge from inside the docker network — no inbound port forwarding required.

### Install the PWA on your phone

1. Open the public URL on your phone (iOS Safari or Android Chrome).
2. **iOS**: tap the Share icon → "Add to Home Screen". *You must open it from the home screen icon* — Web Push doesn't work in the Safari tab on iOS.
3. **Android**: tap the install prompt, or Chrome menu → "Install app".
4. Open the installed app from the home screen.
5. Tap **Enable approvals on this device** → grant the notification permission. The PWA fetches the executor's VAPID public key, subscribes with the browser's push manager, and posts the subscription to `POST /push/subscribe` (which writes it to the `push_subscriptions` table, persistent across restarts).

### Verify end-to-end

From inside TAI, ask any agent to enqueue a purchase:

> Use `purchase_item` with query `usb-c cable`, max_price 30. Just report what the tool returned.

The executor:
1. Persists the action with status `pending_approval`.
2. Generates a fresh one-time approval token (HMAC).
3. Sends a VAPID-signed push to every row in `push_subscriptions` with the cleartext approve/reject URLs in the payload.
4. Returns `{action_id, pushed_to: <n>, expires_at}` to the agent.

Your phone shows the notification within ~2 seconds. Tap **Approve** → the service worker opens the deep link, the executor consumes the token, the runner kicks off the purchase. Tap **Reject** → the action is moved to `rejected` immediately.

### Rotating VAPID keys

`tai-executor setup vapid --force` regenerates the keypair. **Caveat**: every existing subscription becomes invalid (the browser signed up against the old public key) — users will re-subscribe on next visit, which the PWA does automatically. Use sparingly.

### Troubleshooting

- **No push received** → `docker compose logs executor | grep push` will show send statuses. Common reasons:
  - `pushed_to: 0` — no subscriptions in DB. Open the PWA on phone + tap Enable.
  - `gone=true` — old subscription, auto-deleted on next attempt.
  - `403 with body "VapidPkHashMismatch"` — VAPID keys rotated but the browser still has the old subscription; tap Disable → Enable in the PWA.
- **"VAPID not configured" in logs** → forgot step 1 above (`setup vapid`).
- **Service worker not registering** → only works over HTTPS or `http://localhost`. The Cloudflare Tunnel handles the HTTPS for non-localhost.
- **iOS: Enable button does nothing** → iOS only supports Web Push for *installed* PWAs (16.4+). Add to home screen and open from there.

## Spending caps

In `docker/trusted-actions/.env`:

```bash
TA_CAP_PER_REQUEST=100      # max $ per single purchase
TA_CAP_PER_DAY=500          # max $ across all completed purchases in 24h
TA_CAP_PER_MONTH=2000       # max $ across all completed purchases in 30d
```

Set any to `unlimited` to disable that cap (not recommended; keep at least `max_per_request` set).

Enforcement: checked at enqueue time (rejects with 402 + reason). Daily/monthly sums only count `status='completed'` actions — failed and pending don't count.

Edit the .env then restart: `docker compose -f docker/trusted-actions/docker-compose.yml restart`.

## Audit log

The executor keeps a hash-chained audit log in its own SQLite DB. Every state transition writes an entry:
- `enqueue` (when TAI submits a new action)
- `enqueue.cap_exceeded` (when caps rejected it)
- `approve` / `reject` / `cancel` (user decisions)
- `execute_begin` / `execute_end` (runner picked it up)

```bash
# Verify chain integrity
docker exec tai-executor node /app/dist/cli/bin.js audit verify
# → ✅ Audit chain OK    (or first broken entry id)

# Dump recent entries
sqlite3 docker/trusted-actions/data/executor.db \
  "SELECT id, timestamp, actor, action FROM audit_log ORDER BY id DESC LIMIT 20"
```

If chain verification fails: STOP using the executor. Either the DB has been tampered with or there's a bug. Don't approve any new purchases until you understand what happened.

## Backups

The executor's state is in `docker/trusted-actions/`:
- `data/executor.db` — actions, approvals, audit log, push subscriptions
- `secrets/amazon_session.json` — encrypted Amazon session
- `secrets/amazon_password.json` — encrypted Amazon password (optional; only present if you ran `setup amazon-password`)
- `.env` — secrets (passphrase, shared_secret, approval_hmac_key)

Back these up together:

```bash
tar czf tai-executor-backup-$(date +%Y%m%d).tar.gz \
  -C docker/trusted-actions \
  data secrets .env
```

The backup can be restored to any host running the same Docker image — just extract and `docker compose up -d`.

> **Losing the passphrase** = losing the encrypted Amazon session permanently. The DB and audit chain are still readable, but you'll need to re-login via `setup-amazon.sh`.

## Amazon re-auth (`setup amazon-password`)

Amazon enforces `pape.max_auth_age=900` at checkout — a saved session that's more than ~15 minutes old gets redirected to `/ap/signin`. Without a stored password the action stalls in `running` and times out.

Store the password once (encrypted with the same passphrase as `amazon_session`):

```bash
docker compose -f docker/trusted-actions/docker-compose.yml \
  run --rm executor tai-executor setup amazon-password
```

You'll be prompted on stdin (no echo). Rotate with `--force`.

The adapter automatically reauths whenever a checkout step lands on `/ap/signin`. It does NOT handle:

- **2FA** — fails the action with `ReauthError(reason="two_factor")` and a screenshot at `secrets/screenshots/reauth_two_factor_*.png`. You must re-run `setup amazon` interactively.
- **Captcha** — same: fails with `ReauthError(reason="captcha")` and a screenshot.

Each reauth attempt writes audit entries `auth.reauth.required` (with the URL) and either `auth.reauth.completed` or `auth.reauth.failed { reason }`. Verify the chain with `tai-executor audit verify` as usual.

## Troubleshooting

Every issue we hit during bring-up + the fix.

### "Command failed: pnpm dlx playwright install chromium" / pnpm not found

Old version of this runbook tried to install Playwright as a separate `tai-executor` unix user. We don't do that anymore — everything runs in Docker. If you see this, you're following stale instructions. The current setup script doesn't require pnpm on the host.

### "pull access denied for tai-executor"

Compose tried to pull `tai-executor:latest` from a registry instead of building it locally. The compose file's `executor-setup-amazon` (or `executor-probe`) service used to lack a `build:` block. Fixed in commit `5c65715`. If you hit this, you're on an old checkout — `git pull`.

### "Cannot find package 'hono' imported from /app/dist/server.js"

`pnpm deploy` didn't materialize `node_modules`. Fixed by switching to a multi-stage Dockerfile that builds everything inside the container (commit `1af6928`). If you hit this, rebuild the image: `docker compose -f docker/trusted-actions/docker-compose.yml build --no-cache executor`.

### "ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE"

pnpm 10 requires `--legacy` for deploy from non-injected workspaces. Fixed in commit `f60d06e`. Rebuild.

### "Executable doesn't exist at /ms-playwright/chromium-X/..."

The Playwright npm package version doesn't match the Docker base image. We pin both to `1.58.2`. If pnpm pulled a newer Playwright via a transitive dep update, bump the Dockerfile's base image tag to match.

### "make: not found" / better-sqlite3 build fails

The Playwright base image is dev-tools-free. Fixed by `apt install build-essential python3` in the builder stage (commit `04a8a0b`). If hit, rebuild.

### "EACCES: permission denied" writing to /home/executor/.tai-executor/secrets/

Container running as a uid that doesn't own the host bind-mount dir. Fixed by `user: "${EXECUTOR_UID:-1000}:${EXECUTOR_GID:-1000}"` in compose (commit `3fe11bb`). If hit:

```bash
# Quick fix — backfill the uid/gid into .env then restart
grep -q "^EXECUTOR_UID=" docker/trusted-actions/.env || {
  echo "EXECUTOR_UID=$(id -u)" >> docker/trusted-actions/.env
  echo "EXECUTOR_GID=$(id -g)" >> docker/trusted-actions/.env
}
docker compose -f docker/trusted-actions/docker-compose.yml up -d --force-recreate executor
```

### "Setup CLI says ✅ but session doesn't actually work"

False positive — old login detection trusted `session-id` cookie (which Amazon sets for anonymous visitors too) and `#nav-account-list` (which exists when logged out). Fixed in commit `b876c7f` to look for `at-main` access token + nav text not saying "sign in". If you have a saved `amazon_session.json` from before this fix, delete it and re-run setup-amazon.

```bash
rm docker/trusted-actions/secrets/amazon_session.json
bash scripts/tai-executor-setup-amazon.sh
```

### "Verification failed — session may be incomplete" (but session WAS saved)

The CLI's post-save check navigates to `/orders` and pattern-matches the URL. Amazon often shows a "verify your account" interstitial after a fresh login that doesn't match the heuristic — but the session itself is fine. Use the dry-run probe to confirm:

```bash
bash scripts/tai-executor-probe.sh "https://www.amazon.com/dp/<known-good-product>"
```

If that succeeds, the session is good. Ignore the verification warning.

### "DISPLAY is unset" during Amazon setup

Chromium needs a display server for the headed login.
- **WSL2 on Win11+**: should be set by WSLg automatically. `export DISPLAY=:0` if missing.
- **WSL2 on Win10**: WSLg isn't available; you'll need VcXsrv or X410.
- **SSH**: `ssh -X user@host` then `echo $DISPLAY` should show something like `localhost:10.0`.

### "Amazon detected automation" during purchase

Stealth mitigations sometimes break. Mitigations in adapter:
- Sticky user-agent + viewport matching the original login session
- Random delays between actions (200-800ms)
- `playwright-stealth` plugin

If Amazon flags the session, screenshots land in `docker/trusted-actions/screenshots/`. Worst case: re-login + try again with a different IP/time of day.

### Executor health says ok but no actions register

Check whether the adapter was actually registered:

```bash
curl -s http://localhost:3100/health | jq
# → {"status":"ok","actions":["purchase.amazon"]}
```

If `actions` is empty, the `serve` subcommand didn't call `register("purchase.amazon", new AmazonPurchaseAdapter())`. This shouldn't happen in shipped code — file an issue.

### Container can't reach internet (Amazon scrape times out)

```bash
docker exec tai-executor wget -qO- https://www.amazon.com/ | head -c 200
```

If that fails, your Docker network config is restricted. Check `docker network ls` and `~/.docker/daemon.json`. Corporate VPNs / firewalls are the usual culprit.

## Updating the executor after code changes

```bash
# Pull / make changes
git pull

# Rebuild image
docker compose -f docker/trusted-actions/docker-compose.yml build executor

# Restart container
docker compose -f docker/trusted-actions/docker-compose.yml up -d executor
```

The image is self-contained; no host-side build step. The first rebuild after a `git pull` is the slow one (~30s); subsequent rebuilds are fast thanks to Docker layer caching.

## Tearing down

If you need to nuke the executor entirely:

```bash
docker compose -f docker/trusted-actions/docker-compose.yml down -v
rm -rf docker/trusted-actions/{data,secrets,screenshots,.env}
docker rmi tai-executor:latest
```

This destroys: saved session, audit log, SQLite DB, all secrets. The Docker image, container, and bind-mount state are all removed. To rebuild from scratch: run `setup-tai-executor.sh` again.

## File reference

```
docker/trusted-actions/
├── Dockerfile               # multi-stage build (Playwright base → runtime)
├── docker-compose.yml       # three services: executor, executor-setup-amazon, executor-probe
├── .env                     # GENERATED. mode 600. gitignored.
├── data/                    # GENERATED. SQLite DB. mode 700.
├── secrets/                 # GENERATED. amazon_session.json. mode 700.
└── screenshots/             # GENERATED. Playwright failure captures.

scripts/
├── setup-tai-executor.sh        # initial setup (idempotent)
├── tai-executor-setup-amazon.sh # one-time Amazon login
└── tai-executor-probe.sh        # dry-run sanity check

packages/trusted-actions/
├── package.json             # @tailored-ai/trusted-actions
├── src/
│   ├── cli/bin.ts           # serve / setup amazon / probe amazon / audit verify
│   ├── server.ts            # Hono app: /health, /actions, /approve/:token, ...
│   ├── adapters/
│   │   └── purchase-amazon.ts   # Playwright Amazon flow
│   ├── approval/            # token crypto, push notifications
│   ├── audit/log.ts         # hash-chained audit
│   ├── caps/enforcer.ts     # spending caps
│   ├── db/                  # schema + migrations
│   └── secrets/age-store.ts # AES-256-GCM encrypted blob store
```
