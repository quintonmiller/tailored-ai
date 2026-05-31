#!/usr/bin/env bash
# tai-executor-test-purchase.sh — full dry-run purchase, headed.
#
# Walks every step the real adapter does EXCEPT clicking "Place
# order". Designed for manual inspection — the browser stays open
# at the final review page until you Ctrl+C.
#
# Safety guards exercised:
#   1. Cart must be empty before adding the item (aborts if not).
#   2. Checkout total must be within ±tolerance% of the product-page
#      price. Catches surprise fees, wrong quantity, etc.
#
# After the dry-run, the item IS in your cart. Remove it manually
# from Amazon if you don't want to leave it there.
#
# Usage:
#   bash scripts/tai-executor-test-purchase.sh <amazon-url> [tolerance%]
#
# Example:
#   bash scripts/tai-executor-test-purchase.sh \
#     "https://www.amazon.com/dp/B0CSFQQVVT" 15

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC_DIR="$REPO_DIR/docker/trusted-actions"
COMPOSE="docker compose -f $EXEC_DIR/docker-compose.yml"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <amazon-url> [tolerance%]" >&2
  echo "" >&2
  echo "Example:" >&2
  echo "  $0 'https://www.amazon.com/dp/B0CSFQQVVT' 15" >&2
  exit 1
fi

URL="$1"
TOLERANCE="${2:-15}"

if [ ! -f "$EXEC_DIR/secrets/amazon_session.json" ]; then
  echo "✗ no Amazon session at $EXEC_DIR/secrets/amazon_session.json" >&2
  echo "  Run \`bash scripts/tai-executor-setup-amazon.sh\` first." >&2
  exit 1
fi

if [ -z "${DISPLAY:-}" ]; then
  echo "✗ DISPLAY is unset. Need WSLg / X-forward for headed Chromium." >&2
  echo "  Try: export DISPLAY=:0" >&2
  exit 1
fi

if ! docker image inspect tai-executor:latest >/dev/null 2>&1; then
  echo "▸ image not built — building"
  $COMPOSE build executor
fi

if command -v xhost >/dev/null 2>&1; then
  xhost +local: >/dev/null 2>&1 || true
fi

echo "▸ launching dry-run purchase (browser will appear)"
echo "  Target:    $URL"
echo "  Tolerance: ±${TOLERANCE}%"
echo ""
echo "  The browser will stay open at the final review page."
echo "  Inspect it, then press Ctrl+C in THIS terminal to close."
echo ""

EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --place-order) EXTRA_ARGS+=("--place-order") ;;
    --clear-cart)  EXTRA_ARGS+=("--clear-cart") ;;
    --headless)    EXTRA_ARGS+=("--headless") ;;
  esac
done

$COMPOSE --profile test run --rm \
  -e DISPLAY="$DISPLAY" \
  executor-test-purchase "$URL" --tolerance "$TOLERANCE" "${EXTRA_ARGS[@]}"
