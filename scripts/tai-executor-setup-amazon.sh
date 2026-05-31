#!/usr/bin/env bash
# tai-executor-setup-amazon.sh — one-time Amazon login for the executor.
#
# Opens headed Chromium inside the executor container. You log in
# normally (including 2FA); the container saves the encrypted session
# to ./secrets/amazon_session. After this the executor can place
# orders without ever seeing your Amazon password.
#
# Requires a display:
#   - WSLg on Windows 11 → just works
#   - Linux desktop      → just works
#   - SSH                → use `ssh -X` and trust the X auth
#
# Usage:
#   bash scripts/tai-executor-setup-amazon.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC_DIR="$REPO_DIR/docker/trusted-actions"
COMPOSE="docker compose -f $EXEC_DIR/docker-compose.yml"

# ── 1. Prereqs ──────────────────────────────────────────────────────
if [ ! -f "$EXEC_DIR/.env" ]; then
  echo "✗ $EXEC_DIR/.env not found — run \`bash scripts/setup-tai-executor.sh\` first" >&2
  exit 1
fi

if ! docker image inspect tai-executor:latest >/dev/null 2>&1; then
  echo "▸ image not built yet — building"
  $COMPOSE build executor
fi

# ── 2. Display setup ────────────────────────────────────────────────
if [ -z "${DISPLAY:-}" ]; then
  echo "✗ DISPLAY is unset. On WSL2 you need WSLg (Win11+). On SSH use \`ssh -X\`." >&2
  echo "  Try: export DISPLAY=:0   (WSLg)" >&2
  exit 1
fi

if command -v xhost >/dev/null 2>&1; then
  xhost +local: >/dev/null 2>&1 || true
fi

# ── 3. Run the headed login ─────────────────────────────────────────
echo "▸ launching headed Chromium inside executor container (DISPLAY=$DISPLAY)…"
echo "  When the window opens, log in to Amazon manually. The CLI will"
echo "  detect the session cookie and save it. Press Ctrl+C to cancel."
echo ""

$COMPOSE --profile setup run --rm \
  -e DISPLAY="$DISPLAY" \
  executor-setup-amazon

# ── 4. Verify ───────────────────────────────────────────────────────
echo ""
echo "▸ verifying saved session"
SESSION_FILE="$EXEC_DIR/secrets/amazon_session.json"
if [ -f "$SESSION_FILE" ]; then
  size=$(wc -c < "$SESSION_FILE")
  echo "  ✓ encrypted session saved at $SESSION_FILE ($size bytes)"
  chmod 600 "$SESSION_FILE" 2>/dev/null || true
  echo "  ✓ tightened to mode 600"
  echo ""
  echo "  Restart the executor so it picks up the new session:"
  echo "      $COMPOSE restart"
  echo ""
  echo "  Note: the CLI's 'orders page' verification can flag a false"
  echo "  positive on first run (Amazon often shows a 'verify your"
  echo "  account' interstitial post-login). The session itself is on"
  echo "  disk and encrypted — a test purchase will exercise it."
else
  echo "  ✗ no session file at $SESSION_FILE"
  echo "    The CLI may have timed out. Re-run this script to try again."
  exit 1
fi
