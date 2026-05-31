#!/usr/bin/env bash
# tai-executor-tunnel-setup.sh — wire a Cloudflare Tunnel to the executor.
#
# Web Push + service workers REQUIRE HTTPS, so the executor needs a
# public HTTPS URL. This script walks you through the token-based
# Cloudflare Tunnel flow (no inbound port forwarding required).
#
# Prereqs:
#   * A Cloudflare account with a domain you control.
#   * (The script will help with everything else.)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC_DIR="$REPO_DIR/docker/trusted-actions"
ENV_FILE="$EXEC_DIR/.env"
COMPOSE="docker compose -f $EXEC_DIR/docker-compose.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ no executor .env at $ENV_FILE — run scripts/setup-tai-executor.sh first." >&2
  exit 1
fi

cat <<'EOF'

══════════════════════════════════════════════════════════════
TAI Executor — Cloudflare Tunnel setup
══════════════════════════════════════════════════════════════

This wires up HTTPS access to the executor so the PWA + Web Push
can reach it. You'll need ~5 minutes and a Cloudflare account.

STEP 1 — Create a remotely-managed tunnel
─────────────────────────────────────────
  1a. Open: https://one.dash.cloudflare.com/
  1b. Sidebar → Networks → Tunnels → "Create a tunnel"
  1c. Pick "Cloudflared", click Next.
  1d. Name it "tai-executor" (or anything). Click "Save tunnel".
  1e. On the "Install and run a connector" screen you'll see a
      docker command with --token <LONG_STRING>. Copy that token.
      (Don't run the docker command — we'll wire it into compose.)

EOF

read -r -p "Paste the tunnel token here (or press Enter to abort): " TUNNEL_TOKEN
if [ -z "${TUNNEL_TOKEN:-}" ]; then
  echo "✗ aborted." >&2
  exit 1
fi

# Persist into .env. Strip any quotes, in case the user pasted them.
TUNNEL_TOKEN="${TUNNEL_TOKEN//\"/}"
TUNNEL_TOKEN="${TUNNEL_TOKEN//\'/}"

# Replace or append
if grep -q "^TUNNEL_TOKEN=" "$ENV_FILE"; then
  # shellcheck disable=SC2016
  sed -i "s|^TUNNEL_TOKEN=.*|TUNNEL_TOKEN=$TUNNEL_TOKEN|" "$ENV_FILE"
else
  echo "TUNNEL_TOKEN=$TUNNEL_TOKEN" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
echo "✓ saved TUNNEL_TOKEN to $ENV_FILE"

# Bring up cloudflared NOW so Cloudflare detects an active connector —
# the dashboard's "Continue" button stays disabled until a connector
# registers with the tunnel.
echo ""
echo "▸ starting cloudflared sidecar so the dashboard can detect the connector…"
$COMPOSE --profile tunnel up -d tunnel
sleep 4
if $COMPOSE logs tunnel 2>&1 | grep -q "Registered tunnel connection"; then
  echo "✓ connector registered with Cloudflare's edge"
else
  echo "⚠ connector not yet confirmed in logs — give it another ~10s."
  echo "  Check:  $COMPOSE logs tunnel"
fi

cat <<'EOF'

STEP 2 — Add a public hostname to the tunnel
─────────────────────────────────────────────
Back in the Cloudflare dashboard:

  2a. The "Continue" button should now be active (one connector
      registered). Click Continue.
  2b. "Add a public hostname" pane.
  2c. Subdomain: pick something (e.g. "approvals")
  2d. Domain:    pick one you own in Cloudflare.
  2e. Service:
       Type = HTTP
       URL  = executor:3100
      (The hostname `executor` is the docker-compose service name —
      our cloudflared sidecar is on the same docker network as the
      executor.)
  2f. Click Save.

Your public URL will be: https://<subdomain>.<domain>

EOF

read -r -p "Enter the full public URL (e.g. https://approvals.example.com): " PUBLIC_URL
if [ -z "${PUBLIC_URL:-}" ]; then
  echo "✗ aborted." >&2
  exit 1
fi

# Trim trailing slash
PUBLIC_URL="${PUBLIC_URL%/}"

if grep -q "^TA_PUBLIC_BASE_URL=" "$ENV_FILE"; then
  sed -i "s|^TA_PUBLIC_BASE_URL=.*|TA_PUBLIC_BASE_URL=$PUBLIC_URL|" "$ENV_FILE"
else
  echo "TA_PUBLIC_BASE_URL=$PUBLIC_URL" >> "$ENV_FILE"
fi
echo "✓ saved TA_PUBLIC_BASE_URL=$PUBLIC_URL"

# Optional VAPID contact email — Cloudflare logs include it when push
# fails, so it's polite to set.
if ! grep -q "^TA_VAPID_SUBJECT=" "$ENV_FILE"; then
  read -r -p "Operator contact email (used in VAPID subject; Enter to skip): " VAPID_EMAIL
  if [ -n "${VAPID_EMAIL:-}" ]; then
    echo "TA_VAPID_SUBJECT=mailto:$VAPID_EMAIL" >> "$ENV_FILE"
    echo "✓ saved TA_VAPID_SUBJECT=mailto:$VAPID_EMAIL"
  fi
fi

cat <<EOF

STEP 3 — Restart the executor with the new public base URL
───────────────────────────────────────────────────────────
Running now:

  $COMPOSE restart executor

EOF

$COMPOSE restart executor

echo ""
echo "Waiting for the tunnel to come up..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 2
  if curl -sf -m 5 "$PUBLIC_URL/health" >/dev/null 2>&1; then
    echo "✓ tunnel responding at $PUBLIC_URL/health"
    break
  fi
  if [ "$i" = "12" ]; then
    echo "⚠  tunnel didn't respond at $PUBLIC_URL within 24s." >&2
    echo "   Check logs:    $COMPOSE logs tunnel" >&2
    echo "   Dashboard:     https://one.dash.cloudflare.com/" >&2
    exit 1
  fi
done

cat <<EOF

──────────────────────────────────────────────────────────────
✅ Cloudflare Tunnel up. Executor is now reachable at:

     $PUBLIC_URL

Next:
  1. Open $PUBLIC_URL on your phone.
  2. (iOS) Tap Share → "Add to Home Screen", then open from the
     home screen icon. (Web Push only works for installed PWAs.)
  3. (Android) Tap the install prompt or Chrome's "Install app".
  4. Tap "Enable approvals on this device" → grant the
     notification permission.
  5. Enqueue a test action from a TAI agent; you should get a
     push notification within ~2 seconds.

Day-to-day:
  Logs:      $COMPOSE logs -f tunnel
  Restart:   $COMPOSE restart tunnel
  Stop:      $COMPOSE --profile tunnel down tunnel
──────────────────────────────────────────────────────────────
EOF
