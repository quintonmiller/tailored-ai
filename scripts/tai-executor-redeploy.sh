#!/usr/bin/env bash
# tai-executor-redeploy.sh — rebuild + restart the trusted-actions executor
# (and the PWA baked into its image).
#
# When you change anything under packages/trusted-actions/ — server routes,
# PWA HTML/JS/CSS, executor code — run this to get the changes live on the
# phone. The Dockerfile runs `pnpm --filter @tailored-ai/trusted-actions
# build` during image build, which both compiles the TS server and runs
# scripts/build-pwa.cjs (which stamps a fresh BUILD_ID into the PWA assets).
#
# Day-to-day this is just two docker-compose calls. The script wraps them
# with: optional .env env-var wiring, health check, BUILD_ID confirmation,
# and friendly output so you know it worked.
#
# Usage:
#   bash scripts/tai-executor-redeploy.sh
#
# Optional env (writes into docker/trusted-actions/.env if provided —
# safe to omit; already-present values are kept):
#   TAI_API_URL=http://host.docker.internal:3000 \
#   TAI_API_TOKEN=<server.authToken> \
#     bash scripts/tai-executor-redeploy.sh
#
# Flags:
#   --no-cache    pass --no-cache to docker compose build (slower; use if
#                 the image looks stale despite source changes — pnpm-lock
#                 churn etc.)
#   --logs        tail logs after the restart finishes (Ctrl+C to detach)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC_DIR="$REPO_DIR/docker/trusted-actions"
ENV_FILE="$EXEC_DIR/.env"
COMPOSE="docker compose -f $EXEC_DIR/docker-compose.yml"

NO_CACHE=""
TAIL_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    --logs) TAIL_LOGS=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "──────────────────────────────────────────────────────────────"
echo "tai-executor redeploy"
echo "──────────────────────────────────────────────────────────────"

# ── 1. Sanity ────────────────────────────────────────────────────────
if ! command -v docker >/dev/null; then
  echo "✗ docker not found in PATH" >&2; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ docker daemon not running" >&2; exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE missing — run scripts/setup-tai-executor.sh first" >&2
  exit 1
fi

# ── 2. Optional .env wiring for PWA Decisions card ───────────────────
# Idempotent: only writes a key if it's not already present in .env.
upsert_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    echo "  ▸ $key already set in .env — keeping existing value"
  else
    {
      echo ""
      echo "# Added by tai-executor-redeploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "${key}=${val}"
    } >> "$ENV_FILE"
    echo "  ✓ $key appended to .env"
  fi
}

if [ -n "${TAI_API_URL:-}" ] || [ -n "${TAI_API_TOKEN:-}" ]; then
  echo "▸ wiring TAI proxy env vars (Decisions card)"
  [ -n "${TAI_API_URL:-}" ] && upsert_env TAI_API_URL "$TAI_API_URL"
  [ -n "${TAI_API_TOKEN:-}" ] && upsert_env TAI_API_TOKEN "$TAI_API_TOKEN"
fi

# Report current state of the proxy config so you know whether the PWA
# Decisions card will be live after this redeploy.
if grep -qE '^TAI_API_URL=' "$ENV_FILE" && grep -qE '^TAI_API_TOKEN=' "$ENV_FILE"; then
  echo "▸ PWA Decisions card: configured (TAI_API_URL + TAI_API_TOKEN present)"
else
  echo "▸ PWA Decisions card: NOT configured — the card will hide itself."
  echo "  To enable: TAI_API_URL=… TAI_API_TOKEN=… bash $0"
fi

# ── 3. Rebuild the image (PWA + server TS get re-stamped here) ───────
echo "▸ building executor image $NO_CACHE"
# Build context is repo root per docker-compose.yml; the Dockerfile runs
# pnpm build which runs scripts/build-pwa.cjs and stamps a new BUILD_ID.
if ! $COMPOSE build $NO_CACHE executor; then
  echo "✗ docker build failed — see error above." >&2
  exit 1
fi

# ── 4. Recreate the container ────────────────────────────────────────
echo "▸ recreating container"
$COMPOSE up -d --force-recreate executor

# ── 5. Wait for /health ──────────────────────────────────────────────
echo "▸ waiting for /health to respond…"
for i in $(seq 1 20); do
  if curl -sf http://localhost:3100/health >/dev/null 2>&1; then
    echo "  ✓ executor responding at http://localhost:3100"
    break
  fi
  if [ "$i" = "20" ]; then
    echo "  ✗ timed out — see logs:" >&2
    echo "      $COMPOSE logs --tail=80" >&2
    exit 1
  fi
  sleep 2
done

# ── 6. Confirm fresh BUILD_ID stamped into the PWA index ─────────────
# The script-tag near the bottom of index.html carries the build ID so
# this is the cheapest way to verify the new bundle is being served.
build_id=$(curl -sf http://localhost:3100/index.html 2>/dev/null \
  | grep -oE 'window.__APP_BUILD__ = "[0-9]+"' \
  | grep -oE '[0-9]+' || true)
if [ -n "$build_id" ]; then
  echo "▸ PWA build id: $build_id"
else
  echo "▸ PWA build id: (couldn't read — check $COMPOSE logs)"
fi

# ── 7. Done ──────────────────────────────────────────────────────────
cat <<EOF

──────────────────────────────────────────────────────────────
Executor redeployed.

On the phone:
  - Pull-to-refresh the installed PWA (or close it from the app
    switcher and reopen) so the service worker picks up the new
    BUILD_ID. iOS sometimes caches the SW for ~24h on its own; if
    things still look stale, "Clear History and Website Data" in
    Safari for the PWA origin forces it.

──────────────────────────────────────────────────────────────
EOF

if [ "$TAIL_LOGS" = "1" ]; then
  exec $COMPOSE logs -f executor
fi
