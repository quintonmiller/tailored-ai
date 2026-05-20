#!/usr/bin/env bash
# tai-ctl — start/stop/restart the TAI stack so it survives the controlling shell.
# Services: vllm (model server), agent (HTTP + Discord + cron), ui (Vite dev).
#
# Usage:
#   scripts/tai-ctl.sh start    [vllm|agent|ui|all] [--no-build]   # default: vllm + agent
#   scripts/tai-ctl.sh stop     [vllm|agent|ui|all]
#   scripts/tai-ctl.sh restart  [vllm|agent|ui|all] [--no-build]
#   scripts/tai-ctl.sh build                          # rebuild core+server+cli, no restart
#   scripts/tai-ctl.sh status
#   scripts/tai-ctl.sh logs     <service> [tail-lines]
#   scripts/tai-ctl.sh wait-vllm [timeout-seconds]    # block until /v1/models 200s
#
# Design notes:
#  - Each service is launched with `setsid` so it becomes its own session
#    leader. We store the session-leader PID, and stop with `kill -- -PID`
#    so the whole process group dies (pnpm → node children included).
#  - All output goes to ~/.tai/logs/<service>.log. The controlling shell
#    can exit; the services keep running.
#  - PID files live in ~/.tai/run/<service>.pid.
#  - `restart` and `start` automatically rebuild the agent's compiled deps
#    (core, server, cli) before touching the running process — so build
#    errors abort the cycle with the old agent still serving. Pass
#    `--no-build` to skip when you know nothing changed (faster).

set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/repos/autonomous-agent}"
VLLM_DIR="${VLLM_DIR:-$HOME/vllm-qwen-managed}"
VLLM_SCRIPT="${VLLM_SCRIPT:-$VLLM_DIR/start-qwen3.6-27b-vllm.sh}"
VLLM_HEALTH_URL="${VLLM_HEALTH_URL:-http://127.0.0.1:8000/v1/models}"

RUN_DIR="$HOME/.tai/run"
LOG_DIR="$HOME/.tai/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

SERVICES=(vllm agent ui)

pid_file()  { echo "$RUN_DIR/$1.pid"; }
log_file()  { echo "$LOG_DIR/$1.log"; }

is_running() {
  local pid; pid="$(cat "$(pid_file "$1")" 2>/dev/null || echo "")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Spawn $* as a new session leader, redirect output to $log, record PID.
spawn() {
  local name="$1"; shift
  local log; log="$(log_file "$name")"
  : >>"$log"
  # setsid gives us a fresh session+process group. Disown via & and stdin from /dev/null.
  setsid bash -c "exec \"\$@\" >>'$log' 2>&1" _ "$@" </dev/null &
  local pid=$!
  echo "$pid" > "$(pid_file "$name")"
  sleep 0.2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "  $name failed to start — see $log" >&2
    rm -f "$(pid_file "$name")"
    return 1
  fi
  echo "  $name started (pid $pid, log $log)"
}

start_vllm() {
  if is_running vllm; then echo "  vllm already running (pid $(cat "$(pid_file vllm)"))"; return; fi
  [[ -x "$VLLM_SCRIPT" ]] || { echo "  vllm script not found / not executable: $VLLM_SCRIPT" >&2; return 1; }
  spawn vllm "$VLLM_SCRIPT"
}

start_agent() {
  if is_running agent; then echo "  agent already running (pid $(cat "$(pid_file agent)"))"; return; fi
  spawn agent bash -c "cd '$REPO_DIR' && exec pnpm run dev"
}

start_ui() {
  if is_running ui; then echo "  ui already running (pid $(cat "$(pid_file ui)"))"; return; fi
  spawn ui bash -c "cd '$REPO_DIR' && exec pnpm run dev:ui"
}

stop_one() {
  local name="$1"
  if ! is_running "$name"; then
    echo "  $name not running"
    rm -f "$(pid_file "$name")"
    return
  fi
  local pid; pid="$(cat "$(pid_file "$name")")"
  echo "  stopping $name (pgid $pid)..."
  # Kill the whole process group, then escalate to KILL if needed.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    kill -0 "$pid" 2>/dev/null || break
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $name didn't exit, sending KILL"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$(pid_file "$name")"
  echo "  $name stopped"
}

resolve_targets() {
  local arg="${1:-default}"
  case "$arg" in
    default) echo "vllm agent" ;;
    all)     echo "vllm agent ui" ;;
    vllm|agent|ui) echo "$arg" ;;
    *) echo "unknown service: $arg" >&2; return 1 ;;
  esac
}

# Walk $@, split out flags (--no-build) from positional args. Sets globals
# `parsed_targets_arg` and `parsed_skip_build` for callers.
parse_action_args() {
  parsed_targets_arg=""
  parsed_skip_build=0
  for a in "$@"; do
    case "$a" in
      --no-build) parsed_skip_build=1 ;;
      --*) echo "unknown flag: $a" >&2; return 1 ;;
      *)
        if [[ -z "$parsed_targets_arg" ]]; then
          parsed_targets_arg="$a"
        else
          echo "unexpected extra argument: $a" >&2; return 1
        fi
        ;;
    esac
  done
}

targets_include_agent() {
  for t in $1; do
    [[ "$t" == "agent" ]] && return 0
  done
  return 1
}

# Synchronous build of the workspace packages the agent depends on. Blocks
# until tsc finishes; returns nonzero on failure so callers can abort
# without taking down the running agent. We build core + server + cli
# explicitly (rather than `pnpm run build`) to skip the UI / site bundles
# — those have their own dev servers and don't matter for `agent`.
do_build() {
  echo "  building @agent/core + @agent/server + @tailored-ai/cli..."
  local started=$SECONDS
  if ! (cd "$REPO_DIR" && pnpm --filter @agent/core --filter @agent/server --filter @tailored-ai/cli run build); then
    echo "  build failed — leaving running services untouched" >&2
    return 1
  fi
  local elapsed=$((SECONDS - started))
  (( elapsed < 0 )) && elapsed=0
  echo "  build ok (${elapsed}s)"
}

cmd_start() {
  parse_action_args "$@" || return 1
  local targets; targets="$(resolve_targets "${parsed_targets_arg:-default}")"
  if [[ $parsed_skip_build -eq 0 ]] && targets_include_agent "$targets"; then
    do_build || return 1
  fi
  for t in $targets; do "start_$t"; done
}

cmd_stop() {
  local targets; targets="$(resolve_targets "${1:-default}")"
  for t in $targets; do stop_one "$t"; done
}

cmd_restart() {
  parse_action_args "$@" || return 1
  local targets; targets="$(resolve_targets "${parsed_targets_arg:-default}")"
  # Build *before* stopping anything so a compile error doesn't drop the
  # running agent. UI / vllm restarts don't need the workspace build.
  if [[ $parsed_skip_build -eq 0 ]] && targets_include_agent "$targets"; then
    do_build || return 1
  fi
  for t in $targets; do stop_one "$t"; done
  sleep 1
  for t in $targets; do "start_$t"; done
}

cmd_build() {
  do_build
}

cmd_status() {
  printf "%-7s  %-10s  %-8s  %s\n" SERVICE STATE PID LOG
  for s in "${SERVICES[@]}"; do
    local pid="-" state="stopped"
    if is_running "$s"; then
      pid="$(cat "$(pid_file "$s")")"
      state="running"
    fi
    printf "%-7s  %-10s  %-8s  %s\n" "$s" "$state" "$pid" "$(log_file "$s")"
  done
}

cmd_logs() {
  local name="${1:-}"; local n="${2:-80}"
  [[ -n "$name" ]] || { echo "usage: logs <service> [tail-lines]" >&2; return 1; }
  local log; log="$(log_file "$name")"
  [[ -f "$log" ]] || { echo "no log yet: $log" >&2; return 1; }
  tail -n "$n" "$log"
}

cmd_wait_vllm() {
  local timeout="${1:-180}"
  local started=$SECONDS
  while (( SECONDS - started < timeout )); do
    if curl -fsS --max-time 2 "$VLLM_HEALTH_URL" >/dev/null 2>&1; then
      echo "  vllm ready (took $((SECONDS - started))s)"
      return 0
    fi
    sleep 2
  done
  echo "  vllm not ready after ${timeout}s" >&2
  return 1
}

usage() {
  sed -n '2,22p' "$0"
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    start)     cmd_start "$@" ;;
    stop)      cmd_stop "$@" ;;
    restart)   cmd_restart "$@" ;;
    build)     cmd_build ;;
    status)    cmd_status ;;
    logs)      cmd_logs "$@" ;;
    wait-vllm) cmd_wait_vllm "$@" ;;
    ""|-h|--help) usage ;;
    *) echo "unknown command: $sub" >&2; usage; exit 2 ;;
  esac
}

main "$@"
