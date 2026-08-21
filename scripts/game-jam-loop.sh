#!/usr/bin/env bash
#
# Run the game jam on a loop, so the arcade fills up on its own.
#
# One jam is one entry on the site. The interesting questions — does theme
# relevance improve, does a team that browses previous entries do better, is
# this model reliably worse at polish than at gameplay — are all questions about
# *many* entries, and a run costs ninety minutes of one GPU. So it runs
# unattended and the answers accumulate.
#
#   scripts/game-jam-loop.sh                 # forever, seeds counting up from 1
#   scripts/game-jam-loop.sh --runs 5        # five jams and stop
#   scripts/game-jam-loop.sh --seed 40 --brief site
#   scripts/game-jam-loop.sh --arm the-workshop-alone
#
# Every run gets its own seed, which is what picks the theme — a loop on one
# seed is eight hours of the same jam. Logs go to results/jam-loop/, one file
# per run, and the games appear at http://127.0.0.1:4321 as each one finishes.
#
# Stop it with Ctrl-C, or `kill $(cat results/jam-loop/loop.pid)` if it was
# started with setsid.

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LOGS="$ROOT/packages/evals/results/jam-loop"

MODEL="${JAM_MODEL:-qwen3.8-27b}"
BASE_URL="${JAM_BASE_URL:-http://127.0.0.1:8080/v1}"
CONTEXT_TOKENS="${JAM_CONTEXT_TOKENS:-131072}"
ARM="the-workshop"
BRIEF="arcade"
SEED=1
RUNS=0            # 0 means keep going
# Thirty, not the default six. Measured across two full jams: a turn that
# checks, plays, reads and patches genuinely needs the rounds, and at twenty the
# second run stalled. It costs about 45% more wall clock.
TOOL_ROUNDS="${JAM_TOOL_ROUNDS:-30}"

while [ $# -gt 0 ]; do
  case "$1" in
    --seed)     SEED="$2"; shift 2 ;;
    --runs)     RUNS="$2"; shift 2 ;;
    --arm)      ARM="$2"; shift 2 ;;
    --brief)    BRIEF="$2"; shift 2 ;;
    --model)    MODEL="$2"; shift 2 ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --tool-rounds) TOOL_ROUNDS="$2"; shift 2 ;;
    -h|--help)  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOGS"
echo $$ > "$LOGS/loop.pid"

# The endpoint has to be up. A run against a dead port finishes in three
# minutes with zero tool calls and no error at all — it looks like a model that
# did nothing, and it has cost an afternoon before.
wait_for_model() {
  local waited=0
  until curl -sf -m 5 "$BASE_URL/models" >/dev/null 2>&1; do
    if [ "$waited" -eq 0 ]; then
      echo "$(date '+%H:%M:%S')  waiting for $BASE_URL — start it with: docker start ninfer"
    fi
    sleep 30
    waited=$((waited + 30))
    if [ "$waited" -ge 3600 ]; then
      echo "$(date '+%H:%M:%S')  giving up: $BASE_URL has been down for an hour"
      return 1
    fi
  done
  return 0
}

trap 'echo; echo "stopping after this run"; STOP=1' INT TERM
STOP=0
run=0

echo "jam loop — $ARM, brief $BRIEF, model $MODEL"
echo "logs      $LOGS"
echo "arcade    pnpm run arcade   (http://127.0.0.1:4321)"
echo

while [ "$STOP" -eq 0 ]; do
  if [ "$RUNS" -ne 0 ] && [ "$run" -ge "$RUNS" ]; then break; fi
  run=$((run + 1))

  wait_for_model || break
  [ "$STOP" -eq 0 ] || break

  LOG="$LOGS/$(date '+%Y-%m-%d-%H-%M-%S')-seed-$SEED.log"
  echo "$(date '+%H:%M:%S')  run $run — seed $SEED — $LOG"

  pnpm run eval -- \
    --filter "=$ARM" \
    --model "$MODEL" \
    --base-url "$BASE_URL" \
    --seed "$SEED" \
    --repeats 1 \
    --max-tool-rounds "$TOOL_ROUNDS" \
    --context-tokens "$CONTEXT_TOKENS" \
    --max-scenario-minutes 180 \
    --sim-option "brief=$BRIEF" \
    >"$LOG" 2>&1

  status=$?
  entry=$(grep -m1 '  artifact ' "$LOG" | sed 's/.*artifact  *//')
  if [ "$status" -ne 0 ]; then
    echo "$(date '+%H:%M:%S')  run $run failed (exit $status) — see $LOG"
  else
    echo "$(date '+%H:%M:%S')  run $run done — ${entry:-no artifact recorded}"
  fi

  SEED=$((SEED + 1))
done

rm -f "$LOGS/loop.pid"
echo "jam loop finished after $run run(s); next seed would be $SEED"
