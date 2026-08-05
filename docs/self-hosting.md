# Self-hosting TAI

Running TAI on a machine that isn't your laptop: a home server, a VPS, a
cloud VM. The supported shape is **one container, one volume**.

For the local-development path (`npm install -g @tailored-ai/cli`, `tai init`),
see the [README](../README.md). This doc is about unattended deployments.

## The shape, and why

State is SQLite (`agent.db` in `TAI_HOME`). SQLite takes one writer, so there
is no second replica to run and no load balancer to put in front. Everything
instance-scoped — `config.yaml`, `.env`, the database, `data/`, and the plugin
home that `tai plugin install` writes to — lives under one directory named by
`TAI_HOME`. That directory is the volume, and backing it up backs up the
instance.

Scale by giving the box more (a faster model endpoint, more RAM), not by
adding containers. Two containers on one volume will corrupt the database.

## Quick start

Run the published image. No clone, no build:

```bash
docker run -d --name tai \
  -p 127.0.0.1:3000:3000 \
  -v tai-data:/data \
  --add-host host.docker.internal:host-gateway \
  -e TAI_MODEL=llama3.2 \
  -e TAI_BASE_URL=http://host.docker.internal:11434/v1 \
  ghcr.io/quintonmiller/tai:latest

docker logs -f tai            # first boot prints the generated API token
```

Images are multi-arch (amd64 and arm64), so the same tag runs on a Raspberry
Pi, a Graviton instance, or an x86 server. `:latest` is the released tag;
`:edge` tracks the tip of `main`.

With compose, which wires the volume, port publish, and healthcheck for you:

```bash
git clone https://github.com/quintonmiller/tailored-ai
cd tailored-ai/docker/tai
cp .env.example .env          # set TAI_MODEL and TAI_BASE_URL
docker compose up -d          # builds from source
docker compose logs -f
```

Set `TAI_IMAGE=ghcr.io/quintonmiller/tai:latest` in that `.env` to pull the
published image instead of building.

The dashboard is on `http://127.0.0.1:3000` on the host. Read
[Exposing it](#exposing-it) before changing that.

To build the image yourself rather than pull it:

```bash
docker build -t tai:local -f docker/tai/Dockerfile .
```

`--add-host host.docker.internal:host-gateway` is what lets the container reach
a model server running on the host. Docker Desktop resolves that name already;
on Linux it does not, and without the flag the first message fails on DNS
rather than at startup.

## First boot

The entrypoint writes `config.yaml` if `TAI_HOME` has none, then starts the
server. On every later boot the file already exists and is left alone — which
is why editing `config.yaml` in the volume sticks, and why changing an env var
after first boot does *not* move a setting the file already holds.

Only `TAI_MODEL` is required. There is no default: a guessed model produces a
container that starts, passes its healthcheck, and then fails on the first
message with a provider-side 404, which reads like a TAI bug.

| Variable | Default | Notes |
|---|---|---|
| `TAI_MODEL` | — | **Required.** Model name your provider serves. |
| `TAI_BASE_URL` | `http://localhost:11434/v1` | OpenAI-wire endpoint. |
| `TAI_PROVIDER` | `openai_compatible` | Any registered provider id. |
| `TAI_API_KEY` | — | Written to `.env`, referenced from config as `${…}`. |
| `TAI_SERVER_HOST` | `0.0.0.0` in the image | Bind inside the container. |
| `TAI_SERVER_PORT` | `3000` | |
| `TAI_AUTH_TOKEN` | generated | Bearer token for `/api/*`. |
| `TAI_HOME` | `/data` in the image | The volume. |

Same variables work outside Docker — every one is a fallback for a
`tai init --non-interactive` flag:

```bash
tai init --non-interactive --model llama3.2 --base-url http://localhost:11434/v1
tai init --help      # full option list
```

That command is the supported way to set up TAI without a terminal. The
interactive wizard needs a TTY and cannot complete over SSH-with-no-tty, in
cloud-init, or in a container build.

### Bringing your own config

Skip generation entirely by mounting a config you already have:

```bash
docker run -v /srv/tai:/data ... tai:local
# with /srv/tai/config.yaml already in place
```

Anything the file does not set falls back to TAI's defaults, not to the
environment variables above.

## Exposing it

**Read this before publishing the port anywhere but loopback.** The API serves
chat history, memory, tasks, and tool output. There is no per-user model: whoever
reaches it is the owner.

The image binds `0.0.0.0` *inside the container* — it has to, because a
container's loopback is reachable only from inside that container, so
publishing a port to a 127.0.0.1-bound process forwards to nothing. Exposure is
decided by how you publish the port, not by that bind.

Because the bind is open, first boot mints an API token and every `/api/*`
request must carry it:

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/health
```

### For a browser, use `server.proxyAuth`

A bearer token works for scripts and channels, but the bundled dashboard cannot
use one. A token has to ride on an `Authorization` header, and `EventSource`
cannot send headers, so the SSE streams the dashboard depends on (chat, the
event feed) are unreachable to a token-only client.

`server.proxyAuth` is the browser-facing credential. It accepts a session
cookie, which SSE does carry:

```yaml
server:
  host: 0.0.0.0
  proxyAuth:
    enabled: true
    password: ${TAI_DASHBOARD_PASSWORD}
```

Restart, open the dashboard, and you get a login form. A correct password mints
an HttpOnly, SameSite=Lax session cookie that lasts a week. `Secure` is added
when the request arrived over TLS (either directly or via `x-forwarded-proto`
from a proxy).

The password also works as a bearer, so one credential covers both:

```bash
curl -H "Authorization: Bearer $PASSWORD" https://tai.example.com/api/health
```

Set `authToken` alongside it if you want scripts on a separate secret. Both are
accepted when `proxyAuth` is on.

Rotating the password invalidates every issued session, because the session
HMAC is keyed by the password itself. Failed logins are throttled per client IP
(10 per 15 minutes), read from `x-forwarded-for` so one attacker cannot lock
out everyone behind the same proxy.

Enabling `proxyAuth` with an empty password fails every request closed with a
500 rather than falling open, and TAI warns about it at startup.

### Choosing an exposure

| Option | Dashboard | Setup |
|---|---|---|
| **`proxyAuth` + TLS** | works | a password in config, a proxy terminating TLS |
| **Loopback + SSH tunnel** | works | `ssh -L 3000:127.0.0.1:3000 user@host`, no config |
| **Authenticating reverse proxy** | works | Caddy/nginx basic-auth, Cloudflare Access, Tailscale Serve |
| **`authToken` only** | API only | scripts and channels work, browsers do not |

Do not publish the port with no credential at all. That serves the whole
dashboard, unauthenticated, to anyone who finds the IP.

Put TLS in front of `proxyAuth` before exposing it to the internet. The
password crosses the wire on login, and the session cookie on every request
after that.

### Reverse proxy sketch

Caddy terminating TLS in front of `proxyAuth`:

```caddyfile
tai.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy sets `x-forwarded-proto: https`, so the session cookie is issued with
`Secure`. If you would rather the proxy own authentication entirely, add
`basic_auth` and leave `proxyAuth` off:

```caddyfile
tai.example.com {
    basic_auth {
        you $2a$14$...          # caddy hash-password
    }
    reverse_proxy 127.0.0.1:3000
}
```

Keep the container published to `127.0.0.1:3000` either way, so the proxy is
the only path in. With the proxy authenticating, drop TAI's own credential
(`--no-auth-token` at init, or clear `server.authToken`) so requests pass
through: the proxy is what guards the door, and two login prompts for one
dashboard help nobody.

## Day-to-day

```bash
docker compose logs -f                      # tail
docker compose exec tai tai edit            # TUI config editor (needs a TTY)
docker compose exec tai tai --list-agents
docker compose exec tai tai plugin install @tailored-ai/provider-anthropic
docker compose restart                      # after editing config.yaml by hand
```

Config changes are watched and hot-reloaded, but reload has been unreliable in
practice; check `generation` in `/api/health` to confirm a reload landed, and
restart if it did not move.

### Backups

Stop the container first. SQLite in WAL mode leaves `agent.db-wal` and
`agent.db-shm` beside the database, and copying a live set can capture a torn
state.

```bash
docker compose stop
docker run --rm -v tai_tai-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/tai-backup-$(date +%F).tar.gz -C /data .
docker compose start
```

Restore by extracting into an empty volume before first start.

### Upgrades

```bash
git pull && docker compose build && docker compose up -d
```

The volume is untouched. Database migrations run at startup. Take a backup
first — there is no downgrade path once migrations have run.

## What the container can and cannot do

The agent's `exec` tool runs **inside the container**, which is a stronger
boundary than the laptop default, where it runs against your real home
directory. Keep `tools.exec.allowedCommands` tight anyway.

`sandbox: docker` (per-agent container isolation) does **not** work in this
image — that needs a Docker socket, and mounting one hands the agent root on
the host. Use the default `host` sandbox and rely on the container itself.

Not included: no Playwright (neither the driver nor the browsers — the
browser-mediator tools need the `trusted-actions` image), no `md-to-pdf`, and
no model server. TAI talks to a model over HTTP.

The `browser` and `md_to_pdf` tools are still registered and still listed to
the agent. They import their engine lazily, so calling one returns the install
instruction rather than failing at startup:

```
playwright is not installed. Run `npm install playwright && npx playwright
install chromium` to enable the browser tool.
```

Kept, because each backs a feature that works out of the box:
`@modelcontextprotocol/sdk` (5 MB, [MCP](./mcp.md)), `pdf-parse` and
`tesseract.js` (58 MB together, the `extract_document` tool's PDF and OCR
paths). Those two are most of what remains — both vendor several prebuilt
engines upstream.

### Keeping it that way

The image is ~670 MB, of which ~160 MB is TAI and its dependencies. It was
880 MB until [#375](https://github.com/quintonmiller/tailored-ai/issues/375):
`pnpm deploy --prod` drops `devDependencies` but keeps `peerDependencies`
marked `optional`, so vitest (with vite, rollup, esbuild and lightningcss),
`md-to-pdf` (with `typescript` and a second browser driver) and Playwright all
shipped to every self-hoster, none of them reachable from the entrypoint.

Three things hold the line, and a change that trips one is usually a
dependency that wants a second look rather than a guard that wants raising:

| | |
|---|---|
| `pnpm run guard:runtime-deps` | fails CI if a first-party package declares a build tool or browser driver under `dependencies` |
| `scripts/prune-dev-peers.mjs` | drops optional peers that are also devDependencies of a first-party package, then collects what that orphans |
| size ceiling in `docker-image.yml` | fails the publish if the built image exceeds it |

## Deploying to a cloud provider

`tai deploy` drives this. TAI ships a `docker` target for the local machine;
cloud providers are plugins that register through the same seam — see
[deploy-targets.md](./deploy-targets.md) for the contract and how to write one.

```bash
tai deploy list
tai deploy plan docker      # describe what `up` would do, change nothing
tai deploy up docker
```

A single VM with a persistent disk is the right target: EC2 or Lightsail on
AWS, Compute Engine on GCP, a Droplet, a Hetzner box. Install Docker, clone,
`docker compose up -d`, put Caddy in front.

Serverless container platforms (Fargate, Cloud Run, App Runner) are a poor fit
and worth understanding before trying: they assume a stateless replaceable
container, and SQLite on a network filesystem (EFS, Filestore) breaks WAL
locking. Scale-to-zero also stops cron and autopilot, which is most of what a
personal agent does when you are not looking at it.

Sizing: 1 vCPU / 1 GB runs TAI itself comfortably. Anything more is for a
co-located model server.

## Follow-ups

Known gaps, tracked here so they are not rediscovered:

- **`sandbox: docker` is unavailable in the container.** Per-agent container
  isolation needs a Docker socket, and mounting one hands the agent root on the
  host. A rootless or socket-proxied path would close this.
