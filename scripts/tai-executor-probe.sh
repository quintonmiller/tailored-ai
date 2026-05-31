#!/usr/bin/env bash
# tai-executor-probe.sh — dry-run the Amazon adapter against a real product.
#
# Loads the saved Amazon session, navigates to the URL (or top-1 search
# result for a query), scrapes title/price/image, and exits. NO cart
# modification, NO checkout, NO purchase.
#
# Use this to confirm the saved session is alive before letting TAI
# enqueue real purchases.
#
# Usage:
#   bash scripts/tai-executor-probe.sh "https://www.amazon.com/dp/B0XYZ..."
#   bash scripts/tai-executor-probe.sh "usb-c cable"

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC_DIR="$REPO_DIR/docker/trusted-actions"
COMPOSE="docker compose -f $EXEC_DIR/docker-compose.yml"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <amazon-url-or-search-query>" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 'https://www.amazon.com/dp/B0XYZ...'" >&2
  echo "  $0 'usb-c cable'" >&2
  exit 1
fi

TARGET="$1"

if [ ! -f "$EXEC_DIR/secrets/amazon_session.json" ]; then
  echo "✗ no Amazon session found at $EXEC_DIR/secrets/amazon_session.json" >&2
  echo "  Run \`bash scripts/tai-executor-setup-amazon.sh\` first." >&2
  exit 1
fi

if ! docker image inspect tai-executor:latest >/dev/null 2>&1; then
  echo "▸ image not built — building"
  $COMPOSE build executor
fi

echo "▸ probing Amazon (read-only — no cart, no purchase) for: $TARGET"
echo ""

$COMPOSE --profile probe run --rm executor-probe "$TARGET"
