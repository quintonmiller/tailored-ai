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

```bash
git clone https://github.com/quintonmiller/tailored-ai
cd tailored-ai/docker/tai
cp .env.example .env          # set TAI_MODEL and TAI_BASE_URL
docker compose up -d
docker compose logs -f        # first boot prints the generated API token
```

The dashboard is on `http://127.0.0.1:3000` on the host. Read
[Exposing it](#exposing-it) before changing that.

Without compose:

```bash
docker build -t tai:local -f docker/tai/Dockerfile .
docker run -d --name tai \
  -p 127.0.0.1:3000:3000 \
  -v tai-data:/data \
  --add-host host.docker.internal:host-gateway \
  -e TAI_MODEL=llama3.2 \
  -e TAI_BASE_URL=http://host.docker.internal:11434/v1 \
  tai:local
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

### The dashboard caveat

**The bundled web UI does not send the token.** Its fetch wrapper
(`packages/ui/src/api.ts`) sets no `Authorization` header, and `server.authToken`
gates every `/api/*` route including GETs. So with a token set, the dashboard
loads and then fails every request.

That leaves three honest options:

| Option | Dashboard | Setup |
|---|---|---|
| **Loopback + SSH tunnel** *(recommended)* | works | `ssh -L 3000:127.0.0.1:3000 user@host` |
| **Authenticating reverse proxy** | works | Caddy/nginx basic-auth, Cloudflare Access, Tailscale Serve, oauth2-proxy |
| **Publish directly with a token** | API only | scripts and channels work; browser does not |

Do not solve this by removing the token from a publicly-published port. That
serves the whole dashboard, unauthenticated, to anyone who finds the IP.

`server.proxyAuth` looks like the answer and is not: the middleware exists
(`packages/server/src/auth/proxy-auth.ts`) but is never mounted, and the
`/api/auth/login` endpoint its login page posts to does not exist. Setting it
authenticates nothing. TAI warns about this at startup. Wiring it up is the
change that would make remote dashboard access work directly.

### Reverse proxy sketch

Caddy, terminating TLS and doing the auth TAI can't yet do in the browser:

```caddyfile
tai.example.com {
    basic_auth {
        you $2a$14$...          # caddy hash-password
    }
    reverse_proxy 127.0.0.1:3000
}
```

Keep the container published to `127.0.0.1:3000` so the proxy is the only path
in. With the proxy authenticating, you may drop TAI's own token
(`--no-auth-token` at init, or clear `server.authToken`) so the dashboard's
requests pass — the proxy is what is guarding the door.

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

Not included: no Playwright browsers (the browser-mediator tools need the
`trusted-actions` image), and no model server — TAI talks to one over HTTP.

## Deploying to a cloud provider

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

- **Dashboard cannot authenticate remotely.** Mount the proxy-auth middleware
  and implement `/api/auth/login` / `/api/auth/logout`; the cookie it mints
  covers SSE, which a bearer header cannot. This is the highest-value fix for
  self-hosting.
- **Image is ~880 MB.** `typescript`, `rxjs` and a musl-only `lightningcss`
  binary land in a `--prod` deploy, so something declares a build tool as a
  runtime dependency. A dependency audit should cut this substantially.
- **No published image.** Builds are local; a GHCR publish on release would
  turn the quick start into `docker run ghcr.io/...`.
- **No multi-arch build.** The Dockerfile builds for the host architecture.
  arm64 (Raspberry Pi, Graviton, Apple silicon) needs a buildx matrix.
