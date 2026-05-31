#!/usr/bin/env bash
# smoke-test.sh — run a TAI agent against an isolated sandbox home dir.
#
# Why: by default TAI reads/writes ~/.tailored-ai/{config.yaml,agent.db}.
# Smoke tests that create real tasks ("PHASE5-SMOKE: …") pollute that DB,
# crowd the merge queue, and end up in user-facing reviews. Run smoke
# tests against a throwaway home dir so they vanish on cleanup.
#
# Usage:
#   scripts/smoke-test.sh init                # copy minimal config + start fresh
#   scripts/smoke-test.sh -- <tai-args...>    # exec tai with TAI_HOME redirected
#   scripts/smoke-test.sh clean               # nuke the sandbox dir
#
# Examples:
#   scripts/smoke-test.sh init
#   scripts/smoke-test.sh -- --list-agents
#   scripts/smoke-test.sh -- -a coder -m "smoke test write"

set -euo pipefail

SANDBOX="${TAI_SMOKE_HOME:-/tmp/tai-smoke}"

cmd="${1:-help}"
shift || true

case "$cmd" in
  init)
    rm -rf "$SANDBOX"
    mkdir -p "$SANDBOX/data/context/global" "$SANDBOX/data/context/agents" "$SANDBOX/data/kb"
    if [ -f "$HOME/.tailored-ai/config.yaml" ]; then
      cp "$HOME/.tailored-ai/config.yaml" "$SANDBOX/config.yaml"
      # Force a sandbox-local DB so the real one is untouched even if the
      # config.yaml hardcodes an absolute path.
      sed -i 's#path:.*#path: ./agent.db#' "$SANDBOX/config.yaml" || true
      echo "Copied config to $SANDBOX/config.yaml (db path forced to ./agent.db)"
    else
      echo "No real config.yaml to copy from — run \`tai\` once first or write one yourself at $SANDBOX/config.yaml"
    fi
    echo "Smoke sandbox ready at $SANDBOX"
    ;;
  clean)
    rm -rf "$SANDBOX"
    echo "Cleaned $SANDBOX"
    ;;
  --)
    if [ ! -d "$SANDBOX" ]; then
      echo "Sandbox $SANDBOX missing. Run \`$0 init\` first." >&2
      exit 1
    fi
    TAI_HOME="$SANDBOX" exec pnpm run dev -- "$@"
    ;;
  help|"")
    sed -n '2,15p' "$0"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    sed -n '2,15p' "$0" >&2
    exit 1
    ;;
esac
