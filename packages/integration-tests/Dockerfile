# Integration-test image for the tai CLI.
#
# Build context: repo root (so the COPY can see every workspace package).
# Build with: docker build -f packages/integration-tests/Dockerfile -t tai-e2e .
#
# Two stages:
#   1. builder — installs all workspace deps, builds every package, then packs
#      the runtime tarballs we need (cli + its transitive workspace deps).
#   2. runtime — clean Node image with no workspace state. Installs the packed
#      tarballs globally so `tai` is on PATH exactly like a real install would
#      put it, then runs the scenarios from /scenarios.
#
# The runtime stage never sees the repo. That's the point: anything that
# silently relies on workspace layout (env vars, sibling node_modules,
# tsconfig paths, etc.) will fail here and we want it to.

# ---------- builder ----------
FROM node:20-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

# Python + build-essential for better-sqlite3 native build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Copy lockfile + workspace manifest first so the install layer caches well.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./

# Workspace package.json files — listed explicitly to keep the layer cache
# usable. New packages need a line here, but that's a feature not a bug:
# changes to package.json bust the install cache, src changes don't.
COPY packages/browser-mediator/package.json packages/browser-mediator/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/google-tools/package.json packages/google-tools/
COPY packages/server/package.json packages/server/
COPY packages/site/package.json packages/site/
COPY packages/trusted-actions/package.json packages/trusted-actions/
COPY packages/ui/package.json packages/ui/

# Place a stub integration-tests manifest so pnpm install sees a complete
# workspace. The real one is small and won't be needed for the build.
COPY packages/integration-tests/package.json packages/integration-tests/

RUN pnpm install --frozen-lockfile

# Now the source. Only the packages the runtime needs — keeps context small
# and forces us to fail loudly if something reaches sideways into the repo.
COPY packages/browser-mediator packages/browser-mediator
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/google-tools packages/google-tools
COPY packages/ui packages/ui
COPY packages/cli packages/cli

# Build only the publishable runtime packages. browser-mediator → core →
# server + google-tools + ui → cli (the CLI bundles the built UI assets).
RUN pnpm --filter @tailored-ai/browser-mediator run build \
  && pnpm --filter @tailored-ai/core run build \
  && pnpm --filter @tailored-ai/server run build \
  && pnpm --filter @tailored-ai/google-tools run build \
  && pnpm --filter @tailored-ai/ui run build \
  && pnpm --filter @tailored-ai/cli run build

# Pack each runtime package into a tarball. pnpm rewrites workspace:* deps
# to the published version range during pack so the tarballs install with
# plain npm in the next stage.
RUN mkdir -p /tarballs \
  && for pkg in browser-mediator core server google-tools cli; do \
       (cd packages/$pkg && pnpm pack --pack-destination /tarballs) ; \
     done

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime

# better-sqlite3 ships prebuilds for linux x64/arm64 + node 20, so the
# runtime stage doesn't need a C toolchain. If a prebuild is ever missing
# we'll see a clear `node-gyp` error on install rather than silent breakage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /tarballs/ /tmp/tarballs/

# Install all five tarballs together so npm wires the workspace deps to the
# co-installed packages instead of trying to fetch them from the registry.
RUN npm install -g /tmp/tarballs/*.tgz \
  && rm -rf /tmp/tarballs \
  && tai --help >/dev/null

# Sandbox the test environment fully under /work. TAI_HOME is the only var
# tai needs to find its config + data; HOME is irrelevant.
ENV TAI_HOME=/work/.tai \
    NODE_ENV=test \
    MOCK_PROVIDER_PORT=18080

WORKDIR /work

COPY packages/integration-tests/fixtures /fixtures
COPY packages/integration-tests/scenarios /scenarios
COPY packages/integration-tests/docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /scenarios/*.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["all"]
