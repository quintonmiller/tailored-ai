#!/usr/bin/env bash
#
# descent.sh — play one run of The Endless Descent and watch it happen.
#
# Starts three things and holds them together until you stop them:
#
#   the run        five agents playing the dungeon through a live model
#   the broadcast  a web page rendering the run as it arrives
#   the narrator   a second model commentating from outside the run
#
# The narrator only ever reads the trace and writes a sidecar next to it. It
# cannot reach the run, so a narrated run and a private one score identically.
#
# Ctrl-C stops all three.
#
# Usage:
#   packages/evals/scripts/descent.sh                     play, with commentary
#   packages/evals/scripts/descent.sh --seed 3301         play a particular dungeon
#   packages/evals/scripts/descent.sh --model qwen3.8-27b-vllm --thinking high
#                                                         play through a different model,
#                                                         at a named reasoning effort
#   packages/evals/scripts/descent.sh --betrayed           play the hidden-traitor
#                                                         variant: zero to two of the
#                                                         five want the rest dead, and
#                                                         the broadcast tells you which
#   packages/evals/scripts/descent.sh --rehearse rule-based
#                                                         no model at all — a baseline
#                                                         plays it in ~20s. This checks
#                                                         the page, not the agents.
#   packages/evals/scripts/descent.sh --replay <trace>    re-open a finished run
#   packages/evals/scripts/descent.sh --help
#:END-USAGE
#
# Job control is on so that every child becomes its own process group leader.
# That is what lets the cleanup below kill a run *and* the scenario workers it
# spawned, rather than orphaning them onto the GPU.
set -euo pipefail
set -m

EVALS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$EVALS/../.." && pwd)"
ROUTER="${ROUTER:-http://127.0.0.1:8000}"

SEED=""
PORT=""
TARGET="qwen-local"
MODEL=""
THINKING=""
THINKING_DIALECT=""
MINUTES="240"
REHEARSE=""
REPLAY=""
BETRAYED=""
NARRATOR="yes"
NARRATOR_MODEL=""
ROUNDS=""
TAG=""
SIM_OPTIONS=()
RESUME_TRACE=""
RESUME_ROUND=""

die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

usage() {
  # Everything between the shebang and the sentinel is the help text, so the two
  # cannot drift apart the way a hardcoded line range does.
  sed -n '3,/^#:END-USAGE$/p' "${BASH_SOURCE[0]}" | sed '/^#:END-USAGE$/d; s/^# \?//'
  cat <<'OPTS'

Options
  --seed <n>          Dungeon to play. Same seed, same dungeon. Default: random.
  --port <n>          Broadcast port. Default: first free from 4382 up.
  --target <name>     Model target from targets/. Default: qwen-local.
  --model <name>      Model to play through. Default: the target's own.
                      The router loads it on demand; one model is resident at a
                      time, so naming one here evicts whatever is loaded.
  --thinking <level>  off | auto | low | medium | high. Needs a dialect that can
                      carry it — see --thinking-dialect.
  --thinking-dialect <d>
                      openai | vllm | vllm_effort | none. Default: the target's.
                      `vllm` sends only an on/off switch, so every enabled level
                      is the same request and the template's own default decides
                      the effort. `vllm_effort` sends the rung, and maps `high`
                      to the template's `xhigh`.
  --minutes <n>       Give up on the run after this long. Default: 240.
  --rounds <n>        Cut the run to n rounds. For iterating on a question, not
                      for a measurement — a clamped run is not comparable to a
                      full-horizon one and its milestones are unreachable.
  --sim-option k=v    Override one of the simulation's own knobs. Repeatable.
                      An arm of an experiment should name every option it varies
                      rather than relying on a default: the trace records what
                      was passed, and an option that is absent from a trace is
                      unknown rather than defaulted.
  --tag <name>        Label this run. Goes into the trace filename, which is
                      what lets several runs started in the same second coexist
                      and lets a directory of them be read back by arm.
  --resume <trace> <n>
                      Continue a finished run from the start of round n. The
                      world is rebuilt by replaying the trace — no GPU, ~20ms —
                      and play continues from there with whatever `--rounds`
                      says. The horizon is moved *after* the rebuild, so the
                      rounds before the seam were played under the old pressure
                      curve and the ones after are not: a resumed run is for
                      watching and iterating, never for a published number.
  --rehearse <policy> Play a baseline instead of a model: rule-based, oracle,
                      greedy-dps, tactics-only, basic-tactics, random.
  --replay <trace>    Serve a finished trace. Starts nothing else.
  --narrator-model <name>
                      Model to commentate through. Defaults to --model, because
                      the router keeps one model resident and a narrator on a
                      different id evicts the run's model on every call.
  --no-narrator       Run and broadcast only.

Environment
  ROUTER              Endpoint checked (and started, if down) before a run.
                      Default: http://127.0.0.1:8000 — llama-swap, which is
                      where every `home`-shaped target points. A target that
                      names its own base-url is served by something else, and
                      this must be pointed at it too, or the script starts vLLM
                      on :8000 to satisfy a check for a server it will not use
                      and both servers then contend for the one GPU. E.g.
                      ROUTER=http://127.0.0.1:8080 for a NInfer target.
OPTS
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --seed)      SEED="${2:?--seed needs a number}"; shift 2 ;;
    --port)      PORT="${2:?--port needs a number}"; shift 2 ;;
    --target)    TARGET="${2:?--target needs a name}"; shift 2 ;;
    --model)     MODEL="${2:?--model needs a name}"; shift 2 ;;
    --thinking)  THINKING="${2:?--thinking needs a level}"; shift 2 ;;
    --thinking-dialect) THINKING_DIALECT="${2:?--thinking-dialect needs a name}"; shift 2 ;;
    --minutes)   MINUTES="${2:?--minutes needs a number}"; shift 2 ;;
    # Absolutised here, against the shell's cwd. The eval CLI resolves the flag
    # against *its* cwd, which is the package directory, so a repo-relative path
    # typed at the repo root became `packages/evals/packages/evals/...` and the
    # run died on ENOENT before its first turn. Loudly, and at no cost — but the
    # caller's path should simply mean what it looks like.
    --resume)    RESUME_TRACE="$(cd "$(dirname "${2:?--resume needs a trace path}")" && pwd)/$(basename "$2")"
                 RESUME_ROUND="${3:?--resume needs a round number}"; shift 3 ;;
    --rehearse)  REHEARSE="${2:?--rehearse needs a policy}"; shift 2 ;;
    --replay)    REPLAY="${2:?--replay needs a trace path}"; shift 2 ;;
    --betrayed)  BETRAYED="yes"; shift ;;
    --rounds)    ROUNDS="${2:?--rounds needs a number}"; shift 2 ;;
    --tag)       TAG="${2:?--tag needs a name}"; shift 2 ;;
    --sim-option) SIM_OPTIONS+=(--sim-option "${2:?--sim-option needs key=value}"); shift 2 ;;
    --narrator-model) NARRATOR_MODEL="${2:?--narrator-model needs a name}"; shift 2 ;;
    --no-narrator) NARRATOR="no"; shift ;;
    -h|--help)   usage 0 ;;
    *)           printf '\n  unknown option: %s\n' "$1" >&2; usage 2 ;;
  esac
done

# A seed nobody chose still gets printed, so a run worth seeing again can be.
[[ -n "$SEED" ]] || SEED=$(( (RANDOM << 15 | RANDOM) % 900000 + 100000 ))

# See the note by the narrator below: one resident model, so the observer shares
# the player's unless somebody asks for a second one on purpose.
[[ -n "$NARRATOR_MODEL" || -z "$MODEL" ]] || NARRATOR_MODEL="$MODEL"

# Asking for an effort the dialect cannot carry is silent, not loud: `vllm`
# sends the same boolean for every enabled level, so `--thinking medium` against
# it produces a run at whatever the template defaults to and a report that says
# `medium`. That is how every Qwen3.8 number before 2026-08-15 came to be an
# xhigh number. Refuse the combination rather than mislabel four hours of play.
if [[ -n "$THINKING" && "$THINKING" != "off" && "$THINKING" != "auto" ]]; then
  dialect="$THINKING_DIALECT"
  if [[ -z "$dialect" ]]; then
    dialect=$(node -e '
      const {readFileSync}=require("node:fs");
      const t=JSON.parse(readFileSync(process.argv[1],"utf8"));
      // A direct-endpoint target declares its own dialect; only a target that
      // defers to a deployment has to go read the config.yaml over there.
      if(t["thinking-dialect"]){process.stdout.write(t["thinking-dialect"]);process.exit(0)}
      if(!t.home){process.exit(0)}
      const home=t.home.replace(/^~/, process.env.HOME);
      const yaml=readFileSync(home+"/config.yaml","utf8");
      const m=yaml.match(/^\s*thinkingDialect:\s*(\S+)/m);
      if(m)process.stdout.write(m[1]);
    ' "$EVALS/targets/$TARGET.json" 2>/dev/null || true)
  fi
  if [[ "$dialect" != "vllm_effort" && "$dialect" != "openai" ]]; then
    die "--thinking $THINKING needs a dialect that carries an effort rung, but this run would use '${dialect:-none}'.
  Add: --thinking-dialect vllm_effort   (it maps high -> the template's xhigh)"
  fi
fi

cd "$EVALS"

# ---------------------------------------------------------------------------
# Ports. 4380 and 4381 are conventionally left to whatever you already have
# open, so the search starts above them and steps over anything listening.
# ---------------------------------------------------------------------------
port_free() { ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }

if [[ -n "$PORT" ]]; then
  port_free "$PORT" || die "port $PORT is already in use. Pass a different --port."
else
  for candidate in 4382 4383 4384 4385 4386 4387; do
    if port_free "$candidate"; then PORT="$candidate"; break; fi
  done
  [[ -n "$PORT" ]] || die "no free port between 4382 and 4387. Pass --port."
fi

# ---------------------------------------------------------------------------
# The broadcast page is bundled, and the bundle is not in git. Building it is
# about a second and skipping it is how you end up debugging yesterday's code.
# ---------------------------------------------------------------------------
say "building the broadcast page..."
pnpm run --silent build:viewer

# ---------------------------------------------------------------------------
# Replay: no run, no narrator, no model. Just serve the file.
# ---------------------------------------------------------------------------
if [[ -n "$REPLAY" ]]; then
  [[ -f "$REPLAY" ]] || die "no such trace: $REPLAY"
  printf '\n  replaying %s\n  http://127.0.0.1:%s/broadcast\n\n' "$REPLAY" "$PORT"
  exec pnpm run --silent eval -- watch --trace "$REPLAY" --port "$PORT"
fi

# ---------------------------------------------------------------------------
# The model backend, for anything that is not a rehearsal.
#
# llama-swap owns :8000 and starts vLLM behind it on demand. Its /v1/models
# answers from config without loading anything, so "the router is up" is not
# "a model is resident" — the first real request is what triggers the 40-125s
# load. Both states are fine here; a dead router is not, and after a reboot
# that is exactly what you have. The run does not fail on a dead endpoint, it
# quietly plays 200 turns of nothing and scores zero, which is why this checks
# rather than assumes.
# ---------------------------------------------------------------------------
if [[ -z "$REHEARSE" ]]; then
  if curl -fsS --max-time 3 "$ROUTER/v1/models" >/dev/null 2>&1; then
    say "model router is up on ${ROUTER#http://}"
  else
    say "model router is down — starting it"
    ( cd "$REPO" && ./scripts/tai-ctl.sh start vllm ) \
      || die "could not start the model router. Look in ~/.tai/logs/vllm.log"
    curl -fsS --max-time 10 "$ROUTER/v1/models" >/dev/null 2>&1 \
      || die "the router started but is not answering on $ROUTER"
  fi
fi

# ---------------------------------------------------------------------------
# One trace path, decided here and handed to all three. Left to their own
# devices they each resolve "the newest trace", and during the seconds before
# the run creates its file that resolves to the *previous* run — so the page
# fills with a finished game and the narrator commentates it.
# ---------------------------------------------------------------------------
#
# A rehearsal is deliberately written somewhere else. `results/traces/` is the
# scoreboard's cohort, and a baseline bot filed in there would be read back as
# something an agent once achieved.
#
# The two paths below are not the same string, and that is not a slip. `--trace`
# on a run is a *base*: the harness writes one file per scenario and derives
# each name by inserting the scenario id before the extension. Point the page at
# the base and it watches a file nothing ever writes. `rehearse --out` takes the
# literal path, because it only ever plays the one simulation.
STAMP="$(date +%Y-%m-%d-%H-%M-%S)${TAG:+.$TAG}"
SCENARIO="the-endless-descent"
SIMULATION="descent"
if [[ -n "$BETRAYED" ]]; then
  SCENARIO="the-descent-betrayed"
  SIMULATION="descent-betrayed"
fi
if [[ -n "$REHEARSE" ]]; then
  TRACE_ARG="$EVALS/results/rehearsals/$STAMP.$REHEARSE.ndjson"
  TRACE="$TRACE_ARG"
else
  TRACE_ARG="$EVALS/results/traces/$STAMP.ndjson"
  TRACE="$EVALS/results/traces/$STAMP.$SCENARIO.ndjson"
fi
LOG="${TRACE%.ndjson}.run.log"
mkdir -p "$(dirname "$TRACE")"

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  printf '\n  stopping...\n'
  for pid in "${PIDS[@]}"; do
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  printf '  trace: %s\n\n' "${TRACE#"$REPO"/}"
}
trap cleanup INT TERM EXIT

# ---------------------------------------------------------------------------
# The run.
# ---------------------------------------------------------------------------
if [[ -n "$REHEARSE" ]]; then
  say "rehearsing as $REHEARSE (no model)"
  # `--sim-option` reaches the rehearsal too. It did not until 2026-08-18, and
  # the failure was silent: the flag was accepted here, dropped on the way to a
  # command with no such option, and the run played the *default* arm while its
  # trace filename said otherwise. A rehearsal is the cheap arm of an
  # experiment; an unread option here measures a different one.
  pnpm run --silent eval -- rehearse \
    --simulation "$SIMULATION" \
    ${SIM_OPTIONS[@]+"${SIM_OPTIONS[@]}"} \
    --policy "$REHEARSE" --seed "$SEED" ${ROUNDS:+--rounds "$ROUNDS"} --out "$TRACE_ARG" >"$LOG" 2>&1 &
  PIDS+=("$!")
else
  if [[ -n "$RESUME_TRACE" ]]; then
    say "resuming ${RESUME_TRACE##*/} from round $RESUME_ROUND${ROUNDS:+, horizon $ROUNDS}"
  fi
  say "playing seed $SEED through ${MODEL:-the $TARGET default}${THINKING:+ at $THINKING effort}"
  pnpm run --silent eval -- \
    --target "$TARGET" \
    ${MODEL:+--model "$MODEL"} \
    ${THINKING:+--thinking "$THINKING"} \
    ${THINKING_DIALECT:+--thinking-dialect "$THINKING_DIALECT"} \
    --filter "$SCENARIO" \
    --repeats 1 \
    --seed "$SEED" \
    ${ROUNDS:+--rounds "$ROUNDS"} \
    ${RESUME_TRACE:+--resume-trace "$RESUME_TRACE"} \
    ${RESUME_ROUND:+--resume-round "$RESUME_ROUND"} \
    ${SIM_OPTIONS[@]+"${SIM_OPTIONS[@]}"} \
    --max-scenario-minutes "$MINUTES" \
    --trace "$TRACE_ARG" \
    --out "$EVALS/results/$STAMP.json" >"$LOG" 2>&1 &
  PIDS+=("$!")
fi

# ---------------------------------------------------------------------------
# The broadcast.
# ---------------------------------------------------------------------------
pnpm run --silent eval -- watch --trace "$TRACE" --port "$PORT" >/dev/null 2>&1 &
PIDS+=("$!")

# ---------------------------------------------------------------------------
# The narrator, once there is something to narrate. It gives up after five
# quiet minutes, so starting it against an empty file would just kill it.
# ---------------------------------------------------------------------------
if [[ "$NARRATOR" == "yes" && -z "$REHEARSE" ]]; then
  (
    for _ in $(seq 1 150); do
      if [[ -s "$TRACE" ]]; then break; fi
      sleep 2
    done
    [[ -s "$TRACE" ]] || exit 0
    # Two shapes of target, and the narrator has to read both. A target that
    # names a `home` defers to that deployment's config.yaml for its model and
    # sampling; a target that names its own `base-url` and `model` — every
    # direct-endpoint target, which is what an A/B against a second server is —
    # carries no config.yaml at all. Until 2026-08-17 only the first shape was
    # handled, so `--target ninfer-38 --betrayed` printed one apologetic line
    # into the run log and played the whole run in silence.
    eval "$(node -e '
      const t = require(process.argv[1]);
      const q = (v) => String(v).replace(/'"'"'/g, `'"'"'\\'"'"''"'"'`);
      for (const [k, v] of [["HOME_DIR", t.home], ["BASE_URL", t["base-url"]], ["TARGET_MODEL", t.model]]) {
        process.stdout.write(`${k}=${v ? `'"'"'${q(v)}'"'"'` : ""}\n`);
      }
    ' "$EVALS/targets/$TARGET.json" 2>/dev/null || true)"
    # The narrator follows the run's model unless told otherwise, and that is
    # not a cosmetic default. llama-swap keeps exactly one model resident, so
    # a narrator reading a *different* id out of the home's config evicts the
    # model the party is playing through — on every commentary call, for the
    # whole run. The observer would be reloading 27B of weights under the
    # thing it is supposed to be observing. A single-artifact server like
    # NInfer is stricter still: it serves exactly one id and 404s any other.
    if [[ -n "$HOME_DIR" ]]; then
      exec pnpm run --silent eval -- narrate --trace "$TRACE" --home "${HOME_DIR/#\~/$HOME}" \
        ${NARRATOR_MODEL:+--model "$NARRATOR_MODEL"}
    fi
    if [[ -n "$BASE_URL" && -n "${NARRATOR_MODEL:-$TARGET_MODEL}" ]]; then
      exec pnpm run --silent eval -- narrate --trace "$TRACE" --base-url "$BASE_URL" \
        --model "${NARRATOR_MODEL:-$TARGET_MODEL}"
    fi
    # Commentary is optional; the run is not.
    printf '  no narrator: target %s names neither a home nor a base-url and model\n' "$TARGET"
  ) >>"$LOG" 2>&1 &
  PIDS+=("$!")
fi

printf '\n  broadcast   http://127.0.0.1:%s/broadcast\n' "$PORT"
printf '  scoreboard  http://127.0.0.1:%s/\n' "$PORT"
printf '  seed        %s\n' "$SEED"
printf '  trace       %s\n' "${TRACE#"$REPO"/}"
printf '  run log     %s\n\n' "${LOG#"$REPO"/}"

# ---------------------------------------------------------------------------
# Watchdog. A run against a dead or wrong model does not crash — it plays out
# its whole horizon making no tool calls and reports a zero. `call` events are
# the difference between a party playing badly and a party that was never
# asked anything, so wait for the first one and say so if it never comes.
# ---------------------------------------------------------------------------
if [[ -z "$REHEARSE" ]]; then
  (
    for _ in $(seq 1 90); do
      if grep -qm1 '"kind":"call"' "$TRACE" 2>/dev/null; then
        printf '  the party is playing.\n\n'
        exit 0
      fi
      sleep 4
    done
    printf '\n  WARNING: six minutes in and the party has not taken a single action.\n'
    printf '  That is what a dead model looks like from here, not a bad run.\n'
    printf '  Check:  tail -40 %s\n' "${LOG#"$REPO"/}"
    printf '          tail -40 ~/.tai/logs/vllm.log\n\n'
  ) &
  PIDS+=("$!")
fi

# Hold the terminal until the run finishes or Ctrl-C arrives. `wait -n` returns
# on the first child to exit, which is the run itself in the normal case.
wait -n "${PIDS[0]}" || true
printf '\n  the run has finished. The broadcast is still up — Ctrl-C to stop it.\n\n'
wait
