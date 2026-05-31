#!/usr/bin/env bash
# tai-executor-install-token.sh — manage the PWA install token.
#
# Subcommands:
#   (no args)         generate + write a fresh install token, print the URL
#   --show            print the current install URL without rotating
#   --rotate          generate a new token; existing subscriptions
#                     keep working until you also wipe them
#   --wipe-subs       delete all rows from push_subscriptions
#                     (forces every device to re-subscribe with the new token)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXEC_DIR="$REPO_DIR/docker/trusted-actions"
ENV_FILE="$EXEC_DIR/.env"
DB_FILE="$EXEC_DIR/data/executor.db"
COMPOSE="docker compose -f $EXEC_DIR/docker-compose.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ no executor .env at $ENV_FILE — run scripts/setup-tai-executor.sh first." >&2
  exit 1
fi

current_token() {
  grep "^TA_INSTALL_TOKEN=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true
}

current_base_url() {
  grep "^TA_PUBLIC_BASE_URL=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true
}

write_token() {
  local token="$1"
  if grep -q "^TA_INSTALL_TOKEN=" "$ENV_FILE"; then
    sed -i "s|^TA_INSTALL_TOKEN=.*|TA_INSTALL_TOKEN=$token|" "$ENV_FILE"
  else
    echo "TA_INSTALL_TOKEN=$token" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}

print_install_url() {
  local token="$1"
  local base
  base="$(current_base_url)"
  if [ -z "$base" ]; then
    echo "  (TA_PUBLIC_BASE_URL not set — set up Cloudflare Tunnel first)"
    echo "  install URL would be: https://<your-public-host>/?install=$token"
  else
    echo ""
    echo "  Install URL (bookmark this on your phone, open it, then Add to Home Screen):"
    echo "    $base/?install=$token"
    echo ""
  fi
}

wipe_subscriptions() {
  if [ ! -f "$DB_FILE" ]; then
    echo "  (no DB at $DB_FILE — nothing to wipe)"
    return
  fi
  # Use the container's better-sqlite3 to avoid a host sqlite3 dep.
  if $COMPOSE ps --status running --services 2>/dev/null | grep -q "^executor$"; then
    $COMPOSE exec -T executor node -e "
      const Database = require('better-sqlite3');
      const db = new Database('/data/executor.db');
      const r = db.prepare('DELETE FROM push_subscriptions').run();
      console.log('  wiped', r.changes, 'subscription(s)');
    "
  else
    echo "  (executor not running — start it then re-run with --wipe-subs)" >&2
  fi
}

mode="generate"
case "${1:-}" in
  --show)       mode="show" ;;
  --rotate)     mode="rotate" ;;
  --wipe-subs)  mode="wipe" ;;
  "")           mode="generate" ;;
  *)            echo "Usage: $0 [--show|--rotate|--wipe-subs]" >&2; exit 1 ;;
esac

case "$mode" in
  show)
    token="$(current_token)"
    if [ -z "$token" ]; then
      echo "✗ no install token set yet — run \`bash $0\` to generate one." >&2
      exit 1
    fi
    print_install_url "$token"
    ;;

  generate)
    token="$(current_token)"
    if [ -n "$token" ]; then
      echo "▸ install token already present (use --rotate to replace it)."
      print_install_url "$token"
      exit 0
    fi
    token="$(openssl rand -hex 32)"
    write_token "$token"
    echo "✓ generated install token, wrote to $ENV_FILE (chmod 600)"
    echo "▸ restart the executor so it picks up the new env:"
    echo "    $COMPOSE restart executor"
    print_install_url "$token"
    ;;

  rotate)
    token="$(openssl rand -hex 32)"
    write_token "$token"
    echo "✓ rotated install token"
    echo ""
    echo "Existing subscribed devices keep working. To force every"
    echo "device to re-subscribe with the new token:"
    echo "  bash $0 --wipe-subs"
    echo ""
    echo "▸ restart the executor:"
    echo "    $COMPOSE restart executor"
    print_install_url "$token"
    ;;

  wipe)
    wipe_subscriptions
    ;;
esac
