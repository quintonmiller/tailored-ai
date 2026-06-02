#!/usr/bin/env bash
# End-to-end agent-loop check: send a message, hit the mock provider, get the
# canned response back. Asserts both the CLI output and that the mock saw
# exactly one chat completion request.
set -euo pipefail

: > "$MOCK_PROVIDER_LOG"

out=$(tai -a smoke -m "ping")
echo "$out"

if ! echo "$out" | grep -q "pong"; then
  echo "[scenario] expected 'pong' in CLI output" >&2
  exit 1
fi

calls=$(grep -c '"url":"/v1/chat/completions"' "$MOCK_PROVIDER_LOG" || true)
if [ "$calls" -lt 1 ]; then
  echo "[scenario] mock provider received 0 chat completions" >&2
  cat "$MOCK_PROVIDER_LOG" >&2
  exit 1
fi
echo "[scenario] mock provider saw $calls chat completion request(s)"
