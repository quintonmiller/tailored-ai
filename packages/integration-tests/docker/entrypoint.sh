#!/usr/bin/env bash
# In-container test runner. Boots the mock provider, seeds a clean TAI_HOME,
# then runs the requested scenario(s).
#
#   /entrypoint.sh           → run every scenario in /scenarios alphabetically
#   /entrypoint.sh all       → same
#   /entrypoint.sh shell     → drop to bash for debugging
#   /entrypoint.sh <name>    → run /scenarios/<name>.sh
set -euo pipefail

: "${TAI_HOME:=/work/.tai}"
: "${MOCK_PROVIDER_PORT:=18080}"
: "${MOCK_PROVIDER_LOG:=/work/mock-provider.log}"
export TAI_HOME MOCK_PROVIDER_PORT MOCK_PROVIDER_LOG

mkdir -p "$TAI_HOME" /work
: > "$MOCK_PROVIDER_LOG"

echo "[e2e] starting mock provider on :$MOCK_PROVIDER_PORT"
node /fixtures/mock-provider.mjs &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT

# Wait until the mock provider responds before running anything.
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${MOCK_PROVIDER_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" = "30" ]; then
    echo "[e2e] mock provider failed to come up" >&2
    exit 1
  fi
  sleep 0.1
done
echo "[e2e] mock provider ready"

# Always seed TAI_HOME with a known-good config + the deterministic mock so
# scenarios don't have to duplicate this.
cp /fixtures/config.yaml "$TAI_HOME/config.yaml"

target="${1:-all}"

run_one() {
  local script="$1"
  local name
  name=$(basename "$script" .sh)
  echo
  echo "===================================================================="
  echo "[e2e] scenario: $name"
  echo "===================================================================="
  if bash "$script"; then
    echo "[e2e] PASS: $name"
  else
    echo "[e2e] FAIL: $name" >&2
    return 1
  fi
}

case "$target" in
  shell)
    exec bash
    ;;
  all)
    failures=0
    for script in /scenarios/*.sh; do
      [ -f "$script" ] || continue
      if ! run_one "$script"; then
        failures=$((failures + 1))
      fi
    done
    echo
    if [ "$failures" -eq 0 ]; then
      echo "[e2e] all scenarios passed"
    else
      echo "[e2e] $failures scenario(s) failed" >&2
      exit 1
    fi
    ;;
  *)
    script="/scenarios/${target}.sh"
    if [ ! -f "$script" ]; then
      echo "[e2e] no scenario at $script" >&2
      exit 2
    fi
    run_one "$script"
    ;;
esac
