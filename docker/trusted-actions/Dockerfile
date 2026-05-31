# trusted-actions executor — multi-stage build, all inside the container.
#
# Why multi-stage: the executor depends on the workspace package
# @tailored-ai/core. `pnpm deploy` from the host doesn't reliably
# materialize workspace deps + node_modules in one shot, so we just
# build the whole thing inside Docker where pnpm + node have a
# predictable environment.
#
# Build context is the REPO ROOT (set via docker-compose context).
#
# Build:
#   cd <repo-root>
#   docker build -t tai-executor:latest -f docker/trusted-actions/Dockerfile .
#
# Or just `docker compose -f docker/trusted-actions/docker-compose.yml build`.

# ── Stage 1: dependencies + build ───────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS builder

# better-sqlite3 has no prebuilt binary for Node 24 yet, so it compiles
# from source. Need make/g++/python for node-gyp.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*

# Pin pnpm to match the workspace's packageManager directive
RUN corepack disable && npm install -g pnpm@10.27.0

WORKDIR /repo

# 1. Workspace metadata + package manifests (for cached dep install)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/trusted-actions/package.json packages/trusted-actions/

# 2. Install only what trusted-actions transitively needs.
RUN pnpm install --filter @tailored-ai/trusted-actions... --frozen-lockfile

# 3. Copy source + build
COPY packages/core packages/core
COPY packages/trusted-actions packages/trusted-actions
RUN pnpm --filter @tailored-ai/core build
RUN pnpm --filter @tailored-ai/trusted-actions build

# 4. Assemble a self-contained deploy at /deploy.
# --legacy is required since pnpm 10 unless inject-workspace-packages
# is set; we use workspace deps without injection, so legacy mode is
# what we want.
RUN pnpm --filter @tailored-ai/trusted-actions deploy --prod --legacy /deploy

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# No fixed USER — the container runs as the HOST user's uid (set via
# `user:` in docker-compose) so bind-mounted dirs on the host don't
# need chown. This avoids the uid 10001 vs host 1000 mismatch we hit
# in the first iteration.
#
# Make app + browser dirs world-readable (already are) and create the
# expected /home/executor structure with mode 777 so the runtime user
# (whatever uid) can write to bind-mounted subdirs even before the
# host overlay kicks in.

WORKDIR /app

COPY --from=builder /deploy /app

# Pre-create the dirs the runtime expects, mode 777 so any uid can use
# them. (Bind mounts at /data, /home/executor/.tai-executor/secrets,
# /home/executor/screenshots will overlay these at run time.)
RUN mkdir -p /data \
             /home/executor/.tai-executor/secrets \
             /home/executor/screenshots \
 && chmod -R 777 /data /home/executor /ms-playwright \
 && chmod -R a+rX /app

ENV NODE_ENV=production
ENV TA_PORT=3100
ENV TA_DB_PATH=/data/executor.db
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HOME=/home/executor

EXPOSE 3100

CMD ["node", "/app/dist/cli/bin.js", "serve"]
