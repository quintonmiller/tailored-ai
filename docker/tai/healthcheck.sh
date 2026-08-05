#!/bin/sh
# Container healthcheck.
#
# /api/health is behind the same bearer check as every other /api/ route, so a
# plain `curl /api/health` returns 401 and the container goes permanently
# unhealthy the moment an auth token exists — which, in this image, is always,
# because the bind is 0.0.0.0 and first boot mints one. Send the token.
#
# Order matters: the environment wins over the stored file, matching how the
# server itself resolves the token (dotenv does not override an already-set
# variable), so a rotated `-e TAI_AUTH_TOKEN` is checked against the value the
# server is actually using.

set -eu

PORT="${TAI_SERVER_PORT:-3000}"
TOKEN="${TAI_AUTH_TOKEN:-}"

if [ -z "$TOKEN" ] && [ -f "${TAI_HOME:-/data}/.env" ]; then
  TOKEN=$(sed -n 's/^TAI_AUTH_TOKEN=//p' "${TAI_HOME:-/data}/.env" | head -n 1)
fi

if [ -n "$TOKEN" ]; then
  exec curl -fsS -o /dev/null -H "Authorization: Bearer ${TOKEN}" "http://127.0.0.1:${PORT}/api/health"
fi

# No token: either a loopback-bound override or auth handled upstream. The
# unauthenticated request is the correct probe in that case.
exec curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/health"
