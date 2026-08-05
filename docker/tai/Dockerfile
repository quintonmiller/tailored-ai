# Tailored AI — the agent runtime itself.
#
# This is the image you run to self-host TAI: HTTP API + bundled web UI +
# channels + cron/autopilot, all from one long-lived process. (The other two
# images in docker/ are supporting cast — `coder` is a sandbox the agent
# execs into, `trusted-actions` is the HITL purchase executor.)
#
# Build context is the REPO ROOT, because the CLI is the tip of a workspace
# that reaches back through server -> core -> browser-mediator, plus the UI.
#
# Build:
#   docker build -t tai:local -f docker/tai/Dockerfile .
#
# Run (loopback-published, no token needed):
#   docker run --rm -p 127.0.0.1:3000:3000 -v tai-data:/data \
#     -e TAI_MODEL=llama3.2 -e TAI_BASE_URL=http://host.docker.internal:11434/v1 \
#     --add-host host.docker.internal:host-gateway tai:local
#
# Or use docker/tai/docker-compose.yml, which wires the volume, the port
# publish, and the healthcheck for you.

ARG NODE_VERSION=22

# ── Stage 1: build the workspace ────────────────────────────────────────────
# Full bookworm (not slim) for better-sqlite3's node-gyp path: it has no
# prebuild for every Node/arch combination, and falling back to a source
# compile needs python3 + a toolchain. The runtime stage is slim; only the
# resulting .node binary crosses over, and both stages are the same
# debian/glibc base so it loads there.
FROM node:${NODE_VERSION}-bookworm AS builder

# Pin pnpm to the workspace's packageManager. Corepack is disabled for the
# same reason as docker/coder/Dockerfile: it auto-fetches whatever version
# the project declares and has needed a newer Node than the image ships.
RUN corepack disable && npm install -g pnpm@10.27.0

WORKDIR /repo

# 1. Workspace metadata + the manifests of everything on the CLI's dependency
#    path. Copied before the sources so an edit to a .ts file doesn't
#    invalidate the (slow) dependency install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages/browser-mediator/package.json packages/browser-mediator/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
COPY packages/cli/package.json packages/cli/

# 2. Install. `--filter @tailored-ai/cli...` pulls the CLI's transitive
#    workspace deps; the UI is not one of them (the CLI serves its built
#    output as static files, it does not import it) so it is named separately.
RUN pnpm install --filter @tailored-ai/cli... --filter @tailored-ai/ui --frozen-lockfile

# 3. Sources, then build in dependency order. `pnpm -r run build` would also
#    work but topologically sorts the whole workspace including packages this
#    image has no need for (site, integration-tests, the plugin packages).
COPY packages/browser-mediator packages/browser-mediator
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/ui packages/ui
COPY packages/cli packages/cli
RUN pnpm --filter @tailored-ai/browser-mediator build \
 && pnpm --filter @tailored-ai/core build \
 && pnpm --filter @tailored-ai/server build \
 && pnpm --filter @tailored-ai/ui build \
 && pnpm --filter @tailored-ai/cli build

# 4. Assemble a self-contained tree at /deploy. `--legacy` is required on
#    pnpm 10 for workspace deps without injection (same as the
#    trusted-actions image). `--prod` drops devDependencies.
RUN pnpm --filter @tailored-ai/cli deploy --prod --legacy /deploy

# The optional @tailored-ai/trusted-actions dep is not built here, so its
# bin symlink dangles. Left in place deliberately: `tai` never resolves it
# unless trustedActions.enabled is set, and pruning it would diverge this
# image from the published npm package's layout.

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim

# - ca-certificates: TLS roots for provider APIs, web_fetch, git over https
# - git: the agent's worktree helpers and repo backend shell out to it
# - tini: PID 1 that reaps children and forwards SIGTERM, so `docker stop`
#   ends the run in seconds instead of waiting out the 10s kill timeout
# - curl: the healthcheck, and the first thing anyone reaches for when
#   debugging "is the API up" from inside the container
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini curl \
 && rm -rf /var/lib/apt/lists/*

# Everything instance-scoped lives under TAI_HOME: config.yaml, .env,
# agent.db (+ -wal/-shm), data/, and the plugin home that `tai plugin
# install` npm-installs into. One variable, one volume — that is the whole
# persistence story, and it is why this image needs no bespoke path config.
ENV TAI_HOME=/data \
    NODE_ENV=production \
    TAI_SERVER_HOST=0.0.0.0 \
    TAI_SERVER_PORT=3000

# --chown on the COPY rather than a later `RUN chown -R`: the recursive
# version rewrites every file in node_modules into a new layer, which cost
# ~90s of build time and roughly doubled the image size.
COPY --from=builder --chown=node:node /deploy /app
COPY docker/tai/entrypoint.sh /usr/local/bin/tai-entrypoint
COPY docker/tai/healthcheck.sh /usr/local/bin/tai-healthcheck
RUN chmod +x /usr/local/bin/tai-entrypoint /usr/local/bin/tai-healthcheck \
 && ln -s /app/dist/index.js /usr/local/bin/tai \
 && chmod +x /app/dist/index.js

# Run as the unprivileged `node` user (uid 1000, already in the base image).
# `docker run --user` overrides it when a bind mount's owner disagrees; a
# named volume — what the compose file uses — is chowned to match on
# creation and needs no override.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /data
VOLUME ["/data"]

EXPOSE 3000

# Bound to 0.0.0.0 inside the container because a container's loopback is
# reachable only from inside that container — publishing a port to a
# 127.0.0.1-bound process forwards to nothing. Exposure is controlled at the
# publish level (`-p 127.0.0.1:3000:3000`), not here. The entrypoint mints an
# API token to go with the open bind; see docs/self-hosting.md.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["/usr/local/bin/tai-healthcheck"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tai-entrypoint"]
CMD ["tai"]
