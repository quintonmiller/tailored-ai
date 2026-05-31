#!/usr/bin/env bash
# setup-tai-executor.sh — stand up the trusted-actions executor in Docker.
#
# All build steps happen INSIDE Docker. No host-side pnpm/node needed
# beyond what's already in your dev setup.
#
# Usage:
#   bash scripts/setup-tai-executor.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC_DIR="$REPO_DIR/docker/trusted-actions"
COMPOSE="docker compose -f $EXEC_DIR/docker-compose.yml"

echo "──────────────────────────────────────────────────────────────"
echo "tai-executor setup (Docker)"
echo "──────────────────────────────────────────────────────────────"

# ── 1. Sanity checks ─────────────────────────────────────────────────
if ! command -v docker >/dev/null; then
  echo "✗ docker not found in PATH" >&2; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ docker daemon not running (try \`sudo systemctl start docker\`)" >&2; exit 1
fi

# ── 2. Directories + secrets ─────────────────────────────────────────
mkdir -p "$EXEC_DIR/secrets" "$EXEC_DIR/data" "$EXEC_DIR/screenshots"
chmod 700 "$EXEC_DIR/secrets" "$EXEC_DIR/data"

SECRETS_GENERATED=0
if [ ! -f "$EXEC_DIR/.env" ]; then
  echo "▸ generating secrets + .env"
  passphrase=$(openssl rand -hex 32)
  shared_secret=$(openssl rand -hex 32)
  approval_hmac_key=$(openssl rand -hex 32)
  cat > "$EXEC_DIR/.env" <<EOF
# ──────────────────────────────────────────────────────────────────
# tai-executor — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Do NOT commit this file. .gitignore should cover it.
# ──────────────────────────────────────────────────────────────────

# Crypto material
TAI_EXECUTOR_PASSPHRASE=$passphrase
TA_SHARED_SECRET=$shared_secret
APPROVAL_HMAC_KEY=$approval_hmac_key

# Network / runtime
TA_PORT=3100
TA_DB_PATH=/data/executor.db
# Edit to your hosted-proxy URL once it's stood up. Until then,
# approval URLs in push payloads only resolve from the same LAN.
TA_PUBLIC_BASE_URL=http://localhost:3100

# Spending caps — number or "unlimited"
TA_CAP_PER_REQUEST=100
TA_CAP_PER_DAY=500
TA_CAP_PER_MONTH=2000

# Playwright browsers (baked into the image)
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Run the container as the host user so bind-mounted dirs don't need
# chown. docker-compose reads these via \${EXECUTOR_UID}/\${EXECUTOR_GID}.
EXECUTOR_UID=$(id -u)
EXECUTOR_GID=$(id -g)
EOF
  chmod 600 "$EXEC_DIR/.env"
  SECRETS_GENERATED=1
  echo "  ✓ wrote $EXEC_DIR/.env (mode 600)"
else
  echo "▸ $EXEC_DIR/.env already exists — keeping it"
  # Backfill EXECUTOR_UID/GID if a pre-uid-fix .env is in place
  if ! grep -q '^EXECUTOR_UID=' "$EXEC_DIR/.env"; then
    echo "▸ adding EXECUTOR_UID/GID to existing .env"
    {
      echo ""
      echo "# Added by setup script — container runs as host user."
      echo "EXECUTOR_UID=$(id -u)"
      echo "EXECUTOR_GID=$(id -g)"
    } >> "$EXEC_DIR/.env"
  fi
fi

# ── 3. Build the image (all builds happen inside Docker) ─────────────
echo "▸ building Docker image (first build pulls Playwright base ~1GB and runs pnpm install — 2-5 min)"
if ! $COMPOSE build executor; then
  echo "✗ docker build failed — see error above." >&2
  exit 1
fi

# ── 4. Start it ──────────────────────────────────────────────────────
echo "▸ starting tai-executor container"
$COMPOSE up -d executor

echo "▸ waiting for /health to respond…"
for i in $(seq 1 20); do
  if curl -sf http://localhost:3100/health >/dev/null 2>&1; then
    echo "  ✓ executor responding at http://localhost:3100"
    break
  fi
  if [ "$i" = "20" ]; then
    echo "  ✗ timed out — check logs:" >&2
    echo "      $COMPOSE logs" >&2
    exit 1
  fi
  sleep 2
done

# ── 5. Print next steps ──────────────────────────────────────────────
shared_secret=$(grep ^TA_SHARED_SECRET "$EXEC_DIR/.env" | cut -d= -f2)
cat <<EOF

──────────────────────────────────────────────────────────────
Executor is up at http://localhost:3100.

Next steps:

  1. Paste this into TAI's config.yaml under trustedActions:
       trustedActions:
         enabled: true
         url: http://localhost:3100
         sharedSecret: $shared_secret
         pollIntervalMs: 5000

  2. Do the one-time Amazon login (opens Chromium):
       bash scripts/tai-executor-setup-amazon.sh

  3. Once a hosted-proxy tunnel is up, edit $EXEC_DIR/.env and
     set TA_PUBLIC_BASE_URL to the tunnel URL, then restart:
       $COMPOSE restart

Day-to-day:
  Start:    $COMPOSE up -d
  Stop:     $COMPOSE down
  Logs:     $COMPOSE logs -f
  Status:   curl -s http://localhost:3100/health | jq

──────────────────────────────────────────────────────────────
EOF

if [ "$SECRETS_GENERATED" = "1" ]; then
  echo "⚠  Don't lose the shared_secret above. The .env file has it but is gitignored."
fi
