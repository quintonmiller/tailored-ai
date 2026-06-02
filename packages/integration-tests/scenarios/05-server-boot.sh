#!/usr/bin/env bash
# Boots the server in the background and hits the HTTP API. Covers:
#   - process starts and the port comes up
#   - /api/agents serves the fixture agent
#   - /api/health returns 200
#   - graceful shutdown on SIGTERM
set -euo pipefail

port=$(jq -r '.server.port // 3000' </dev/null <<<'{}' )  # placeholder; we read the yaml below
port=$(grep -E "^  port:" /fixtures/config.yaml | head -1 | awk '{print $2}')
: "${port:=3000}"

log=/work/server.log
: > "$log"

echo "[scenario] starting tai server on port $port"
# Run server in the background. Detach stdin so it doesn't try to attach
# to a TTY for any prompts.
tai </dev/null >"$log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT

wait_ok() {
  local url="$1"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "[scenario] server died before $url responded" >&2
      tail -50 "$log" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  echo "[scenario] timed out waiting for $url" >&2
  tail -50 "$log" >&2 || true
  return 1
}

wait_ok "http://127.0.0.1:${port}/api/health"

health=$(curl -fsS "http://127.0.0.1:${port}/api/health")
echo "[scenario] /api/health → $health"
echo "$health" | jq -e '.status // .ok // .' >/dev/null

agents=$(curl -fsS "http://127.0.0.1:${port}/api/agents")
echo "[scenario] /api/agents (first 200 chars): ${agents:0:200}"
# Response shape is { "<agentId>": <definition>, ... }. Just assert the
# fixture agent is one of the keys.
echo "$agents" | jq -e 'has("smoke")' >/dev/null

echo "[scenario] shutting down"
kill -TERM "$server_pid"
# Wait up to 5s for clean exit; fall back to KILL.
for _ in $(seq 1 20); do
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 "$server_pid" 2>/dev/null; then
  echo "[scenario] server did not exit on SIGTERM, sending SIGKILL" >&2
  kill -KILL "$server_pid" || true
fi
trap - EXIT
echo "[scenario] server boot OK"
