#!/usr/bin/env bash
#
# Stop a jam, and mean it.
#
# `pkill -f 'cli.ts run'` looks like it works and does not. On 2026-08-23 a run
# was "killed" at round 7, and three hours later it published a finished
# twenty-round entry: the loop script and the `pnpm`/`tsx` parents died, and the
# worker process that actually calls the model kept going. It spent two hours
# sharing the GPU with the run that replaced it, which made every turn of *that*
# run slower and its numbers untrustworthy.
#
# The parents are shells and package managers. The work happens in a child they
# do not forward signals to, so the only reliable unit is the process group.
#
#   scripts/jam-stop.sh          # stop the loop and every run under it
#   scripts/jam-stop.sh --check  # say what is running, kill nothing
#
set -uo pipefail
cd "$(dirname "$0")/.."

LOGS="packages/evals/results/jam-loop"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

# Anything whose command line belongs to a jam. Deliberately broad: a worker is
# `node .../tsx/dist/cli.mjs src/cli.ts run …`, which shares no distinctive
# substring with the loop script that started it.
mapfile -t PIDS < <(pgrep -f 'game-jam-loop|cli\.ts run|evals.*run --filter' 2>/dev/null | sort -u)

if [ "${#PIDS[@]}" -eq 0 ]; then
  echo "nothing running"
  exit 0
fi

echo "jam processes:"
for pid in "${PIDS[@]}"; do
  # Its own group, so a kill reaches the children the parent never signals.
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  cmd=$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-80)
  printf "  pid %-8s pgid %-8s %5ss  %s\n" "$pid" "${pgid:-?}" "${age:-?}" "$cmd"
done

if [ "$CHECK" -eq 1 ]; then
  echo
  echo "(--check: nothing killed)"
  exit 0
fi

# Groups first, TERM then KILL. A run mid-request to the model does not stop on
# TERM alone, and a half-killed run is what caused the problem this script is for.
mapfile -t PGIDS < <(for pid in "${PIDS[@]}"; do ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' '; done | sort -u)
echo
for pgid in "${PGIDS[@]}"; do
  [ -n "$pgid" ] && kill -TERM -- "-$pgid" 2>/dev/null
done
sleep 5
for pgid in "${PGIDS[@]}"; do
  [ -n "$pgid" ] && kill -KILL -- "-$pgid" 2>/dev/null
done
sleep 2

rm -f "$LOGS/loop.pid"

# Verify rather than assume, which is the whole lesson.
left=$(pgrep -f 'game-jam-loop|cli\.ts run|evals.*run --filter' 2>/dev/null | wc -l)
if [ "$left" -eq 0 ]; then
  echo "stopped — nothing left running"
else
  echo "WARNING: $left process(es) survived:"
  pgrep -af 'game-jam-loop|cli\.ts run|evals.*run --filter' 2>/dev/null | cut -c1-100
  exit 1
fi

# A killed run leaves its arcade row with `live` still set, and the live panel is
# the first thing a person looks at. The script used to print a paragraph
# explaining that and leave the rows alone; after three stops in one afternoon
# the panel was showing five jams building at once, none of which existed.
#
# Nothing is deleted. `live = 0` is what `ArcadeStore.endRun` does, and it is
# simply true once this script has verified that no jam process survives — which
# is why it runs here, after the check, rather than next to the kill.
ARCADE_DB="${ARCADE_HOME:-$HOME/.tai-arcade}/arcade.db"
if [ -f "$ARCADE_DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  ended=$(sqlite3 "$ARCADE_DB" \
    "UPDATE entries SET live = 0 WHERE live = 1; SELECT changes();" 2>/dev/null)
  if [ -n "$ended" ] && [ "$ended" -gt 0 ] 2>/dev/null; then
    echo
    echo "marked $ended arcade row(s) as no longer building (nothing deleted)"
  fi
elif [ -f "$ARCADE_DB" ]; then
  echo
  echo "note: sqlite3 not installed — killed runs may still show as building on the"
  echo "      live panel until the next run publishes."
fi
