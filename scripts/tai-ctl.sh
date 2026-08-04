#!/usr/bin/env bash
# tai-ctl — start/stop/restart the TAI stack so it survives the controlling shell.
#
# Services: agent (HTTP + Discord + cron) and ui (Vite dev) belong to an
# instance; vllm (model server) is shared by all of them.
#
# Usage:
#   scripts/tai-ctl.sh start   -i <instance> [agent|ui|vllm|all] [--no-build]
#   scripts/tai-ctl.sh stop    -i <instance> [agent|ui|vllm|all]
#   scripts/tai-ctl.sh restart -i <instance> [agent|ui|vllm|all] [--no-build]
#   scripts/tai-ctl.sh switch  -i <instance>          # stop the others, start this one
#   scripts/tai-ctl.sh status  [-i <instance>]        # omit -i to see every instance
#   scripts/tai-ctl.sh logs    -i <instance> <service> [tail-lines]
#   scripts/tai-ctl.sh instances                      # list what's configured
#   scripts/tai-ctl.sh build                          # rebuild core+server+cli
#   scripts/tai-ctl.sh wait-vllm [timeout-seconds]    # block until /v1/models 200s
#
# Instances are declared in ~/.tai/instances.conf as `name=/path/to/home`,
# one per line. The file is created on first run holding the single instance
# that already exists.
#
# Per-machine settings go in ~/.tai/env, which is sourced if present — the
# place to pin VLLM_SCRIPT, REPO_DIR or VLLM_DIR for a particular box.
#
# Design notes:
#  - `-i` is required by every command that touches `agent` or `ui`. Naming the
#    instance on each invocation is the whole point: with two homes sharing one
#    port and one machine, an unqualified `restart` is a coin flip, and getting
#    it wrong means the work bot answering personal messages.
#  - Each service is launched with `setsid` so it becomes its own session
#    leader. We store the session-leader PID, and stop with `kill -- -PID`
#    so the whole process group dies (pnpm → node children included).
#  - The agent is spawned with a scrubbed environment carrying an explicit
#    TAI_HOME. Core reads that variable to find its keys, scratch and sandbox
#    allowlist, and `dotenv` does not override values already in the
#    environment — so an exported DISCORD_TOKEN in the invoking shell would
#    otherwise silently outrank the instance's own `.env`.
#  - agent/ui pid + log files are namespaced per instance under ~/.tai/{run,logs};
#    vllm's are not, because one model server serves every instance.
#  - Only one instance may hold the `agent` slot at a time. Enforced by scanning
#    every instance's pid file for a live process, so pid liveness is the only
#    truth and a crash leaves nothing stale to clean up. The shared port 3000 is
#    the second, kernel-level lock behind it.
#  - `restart` and `start` automatically rebuild the agent's compiled deps
#    (core, server, cli) before touching the running process — so build
#    errors abort the cycle with the old agent still serving. Pass
#    `--no-build` to skip when you know nothing changed (faster).
#  - vllm is never in the default target set. Switching instances has nothing
#    to do with the model server, and reloading a 27B model to restart an
#    agent costs minutes for no reason.

set -euo pipefail

TAI_STATE_DIR="${TAI_STATE_DIR:-$HOME/.tai}"

# Optional per-machine settings, sourced before the defaults below so a box can
# pin things like VLLM_SCRIPT without editing this file or exporting from a
# shell rc (which only reaches interactive shells, not cron or a detached
# service). Write entries in `VAR="${VAR:-value}"` form so an explicit
# `VAR=... tai-ctl ...` on the command line still outranks the file.
TAI_ENV_FILE="${TAI_ENV_FILE:-$TAI_STATE_DIR/env}"
# shellcheck source=/dev/null
[ -f "$TAI_ENV_FILE" ] && . "$TAI_ENV_FILE"

REPO_DIR="${REPO_DIR:-$HOME/repos/autonomous-agent}"
VLLM_DIR="${VLLM_DIR:-$HOME/vllm-qwen-managed}"
VLLM_SCRIPT="${VLLM_SCRIPT:-$VLLM_DIR/start-qwen3.6-27b-vllm.sh}"
VLLM_HEALTH_URL="${VLLM_HEALTH_URL:-http://127.0.0.1:8000/v1/models}"

RUN_ROOT="$TAI_STATE_DIR/run"
LOG_ROOT="$TAI_STATE_DIR/logs"
INSTANCES_CONF="$TAI_STATE_DIR/instances.conf"
mkdir -p "$RUN_ROOT" "$LOG_ROOT"

SERVICES=(vllm agent ui)
# Services that belong to one instance. vllm is deliberately absent.
INSTANCE_SERVICES=(agent ui)

INSTANCE=""

# --------------------------------------------------------------------------
# Instances
# --------------------------------------------------------------------------

# Create the file on first run so the mechanism is discoverable and editable,
# seeded with the deployment that already exists.
ensure_instances_conf() {
  [[ -f "$INSTANCES_CONF" ]] && return 0
  cat >"$INSTANCES_CONF" <<EOF
# TAI instances: <name>=<home directory>
# The home holds config.yaml, .env, agent.db and data/.
# Add a line to declare another; each needs its own Discord application.
personal=$HOME/.tailored-ai
EOF
  echo "  created $INSTANCES_CONF (one instance: personal)" >&2
}

instance_names() {
  ensure_instances_conf
  # Trim per line, not with `tr -d`, which would eat the newlines too and
  # return every instance concatenated into one name.
  sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$INSTANCES_CONF" |
    cut -d= -f1 |
    sed -e 's/[[:space:]]//g' |
    grep -v '^$' || true
}

instance_home() {
  ensure_instances_conf
  local want="$1" name home
  while IFS='=' read -r name home; do
    name="$(echo "$name" | tr -d '[:space:]')"
    [[ -z "$name" || "$name" == \#* ]] && continue
    if [[ "$name" == "$want" ]]; then
      echo "${home%%#*}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
      return 0
    fi
  done < <(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$INSTANCES_CONF")
  return 1
}

require_instance() {
  if [[ -z "$INSTANCE" ]]; then
    echo "error: instance required — say which deployment to act on." >&2
    echo "" >&2
    for n in $(instance_names); do
      echo "  $0 $CURRENT_SUB -i $n ${ORIGINAL_TARGET:-}" >&2
    done
    echo "" >&2
    echo "Declared in $INSTANCES_CONF." >&2
    return 1
  fi
  local home
  if ! home="$(instance_home "$INSTANCE")"; then
    echo "error: no instance named '$INSTANCE'. Known: $(instance_names | tr '\n' ' ')" >&2
    echo "Declared in $INSTANCES_CONF." >&2
    return 1
  fi
  if [[ ! -d "$home" ]]; then
    echo "error: instance '$INSTANCE' points at $home, which does not exist." >&2
    echo "Create it with: TAI_HOME=$home tai init" >&2
    return 1
  fi
  INSTANCE_HOME="$home"
  mkdir -p "$RUN_ROOT/$INSTANCE" "$LOG_ROOT/$INSTANCE"
}

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

is_instance_service() {
  for s in "${INSTANCE_SERVICES[@]}"; do [[ "$1" == "$s" ]] && return 0; done
  return 1
}

# agent/ui are per-instance; vllm is shared by all of them.
pid_file() {
  if is_instance_service "$1"; then echo "$RUN_ROOT/${2:-$INSTANCE}/$1.pid"; else echo "$RUN_ROOT/$1.pid"; fi
}

log_file() {
  if is_instance_service "$1"; then echo "$LOG_ROOT/${2:-$INSTANCE}/$1.log"; else echo "$LOG_ROOT/$1.log"; fi
}

# The layout before instances existed put agent.pid and agent.log straight in
# ~/.tai/{run,logs}. A live agent started under the old script would otherwise
# be invisible to `stop` here — reported as "not running" while it kept the
# port. Adopt it into the first declared instance, once.
migrate_flat_layout() {
  local first; first="$(instance_names | head -1)"
  [[ -n "$first" ]] || return 0
  for svc in "${INSTANCE_SERVICES[@]}"; do
    mkdir -p "$RUN_ROOT/$first" "$LOG_ROOT/$first"
    if [[ -f "$RUN_ROOT/$svc.pid" ]]; then
      mv "$RUN_ROOT/$svc.pid" "$RUN_ROOT/$first/$svc.pid"
      echo "  adopted running $svc into instance '$first'" >&2
    fi
    if [[ -f "$LOG_ROOT/$svc.log" ]]; then
      mv "$LOG_ROOT/$svc.log" "$LOG_ROOT/$first/$svc.log"
    fi
  done
}

is_running() {
  local pid; pid="$(cat "$(pid_file "$1" "${2:-}")" 2>/dev/null || echo "")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Which instance currently holds a live $1, if any. Pid liveness is the only
# truth here, so a crashed instance releases the slot with nothing to clean up.
service_owner() {
  local svc="$1" name
  for name in $(instance_names); do
    if is_running "$svc" "$name"; then echo "$name"; return 0; fi
  done
  return 1
}

# --------------------------------------------------------------------------
# Spawning
# --------------------------------------------------------------------------

spawn() {
  local name="$1"; shift
  local log; log="$(log_file "$name")"
  mkdir -p "$(dirname "$log")"
  : >>"$log"
  setsid bash -c "exec \"\$@\" >>'$log' 2>&1" _ "$@" </dev/null &
  local pid=$!
  echo "$pid" > "$(pid_file "$name")"
  sleep 0.2
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "  $name failed to start — see $log" >&2
    rm -f "$(pid_file "$name")"
    return 1
  fi
  echo "  [$INSTANCE] $name started (pid $pid, log $log)"
}

# Launch with only what a shell needs, plus this instance's TAI_HOME.
#
# The scrub is the point, not the TAI_HOME. `dotenv` does not overwrite a
# variable already present in the environment, so a DISCORD_TOKEN or
# OPENROUTER_API_KEY exported in the invoking shell outranks the instance's own
# `.env` — and the wrong bot logs in with no error anywhere.
spawn_in_home() {
  local name="$1" cmd="$2"
  spawn "$name" env -i \
    PATH="$PATH" HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
    SHELL="${SHELL:-/bin/bash}" LANG="${LANG:-}" TZ="${TZ:-}" TERM="${TERM:-dumb}" \
    TAI_HOME="$INSTANCE_HOME" \
    bash -c "cd '$REPO_DIR' && exec $cmd"
}

await_vllm_ready() {
  local pid="$1" timeout="$2" started=$SECONDS
  while (( SECONDS - started < timeout )); do
    if curl -fsS --max-time 2 "$VLLM_HEALTH_URL" >/dev/null 2>&1; then
      echo "  vllm ready (took $((SECONDS - started))s)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "  vllm process exited during startup (after $((SECONDS - started))s)" >&2
      return 1
    fi
    sleep 2
  done
  echo "  vllm still not answering after ${timeout}s" >&2
  return 1
}

start_vllm() {
  if is_running vllm; then echo "  vllm already running (pid $(cat "$(pid_file vllm)"))"; return; fi
  [[ -x "$VLLM_SCRIPT" ]] || { echo "  vllm script not found / not executable: $VLLM_SCRIPT" >&2; return 1; }
  spawn vllm "$VLLM_SCRIPT" || return 1
  # spawn() only confirms the process launched; the vllm engine can still abort
  # ~a minute later during memory profiling (e.g. the KV cache won't fit the
  # requested context). Block on the health endpoint so a failed boot exits
  # nonzero instead of leaving a dead process reported as "started".
  echo "  waiting for vllm to become ready (up to ${VLLM_START_TIMEOUT:-300}s)..."
  if ! await_vllm_ready "$(cat "$(pid_file vllm)")" "${VLLM_START_TIMEOUT:-300}"; then
    echo "  vllm failed to start — see $(log_file vllm)" >&2
    stop_one vllm >/dev/null 2>&1 || true
    return 1
  fi
}

# Refuse rather than race. Both instances bind port 3000, so a second start
# would die on EADDRINUSE anyway — but only after logging a second Discord bot
# in and firing cron for a few seconds. Saying no here is cheaper and legible.
guard_exclusive() {
  local svc="$1" owner
  if owner="$(service_owner "$svc")" && [[ "$owner" != "$INSTANCE" ]]; then
    echo "  refusing: instance '$owner' is already running $svc (pid $(cat "$(pid_file "$svc" "$owner")"))." >&2
    echo "  Stop it first:  $0 stop -i $owner $svc" >&2
    echo "  Or switch:      $0 switch -i $INSTANCE" >&2
    return 1
  fi
}

start_agent() {
  if is_running agent; then echo "  [$INSTANCE] agent already running (pid $(cat "$(pid_file agent)"))"; return; fi
  guard_exclusive agent || return 1
  spawn_in_home agent "pnpm run dev"
}

start_ui() {
  if is_running ui; then echo "  [$INSTANCE] ui already running (pid $(cat "$(pid_file ui)"))"; return; fi
  guard_exclusive ui || return 1
  spawn_in_home ui "pnpm run dev:ui"
}

stop_one() {
  local name="$1" inst="${2:-$INSTANCE}"
  local label; label="$(is_instance_service "$name" && echo "[$inst] $name" || echo "$name")"
  if ! is_running "$name" "$inst"; then
    echo "  $label not running"
    rm -f "$(pid_file "$name" "$inst")"
    return
  fi
  local pid; pid="$(cat "$(pid_file "$name" "$inst")")"
  echo "  stopping $label (pgid $pid)..."
  # Kill the whole process group, then escalate to KILL if needed.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    kill -0 "$pid" 2>/dev/null || break
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $label didn't exit, sending KILL"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$(pid_file "$name" "$inst")"
  echo "  $label stopped"
}

# --------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------

resolve_targets() {
  local arg="${1:-default}"
  case "$arg" in
    default) echo "agent" ;;
    all)     echo "vllm agent ui" ;;
    vllm|agent|ui) echo "$arg" ;;
    *) echo "unknown service: $arg" >&2; return 1 ;;
  esac
}

targets_include_agent() {
  for t in $1; do [[ "$t" == "agent" ]] && return 0; done
  return 1
}

targets_need_instance() {
  for t in $1; do is_instance_service "$t" && return 0; done
  return 1
}

# Walk $@, splitting flags (-i <name>, --no-build) from the single positional
# target. Sets `parsed_targets_arg`, `parsed_skip_build` and `INSTANCE`.
parse_action_args() {
  parsed_targets_arg=""
  parsed_skip_build=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -i|--instance)
        [[ $# -ge 2 ]] || { echo "error: $1 needs an instance name" >&2; return 1; }
        INSTANCE="$2"; shift 2 ;;
      -i=*|--instance=*) INSTANCE="${1#*=}"; shift ;;
      --no-build) parsed_skip_build=1; shift ;;
      --*|-*) echo "unknown flag: $1" >&2; return 1 ;;
      *)
        if [[ -z "$parsed_targets_arg" ]]; then parsed_targets_arg="$1"; shift
        else echo "unexpected extra argument: $1" >&2; return 1; fi ;;
    esac
  done
  ORIGINAL_TARGET="$parsed_targets_arg"
}

do_build() {
  echo "  building @tailored-ai/core + @tailored-ai/server + @tailored-ai/cli..."
  local started=$SECONDS
  if ! (cd "$REPO_DIR" && pnpm --filter @tailored-ai/core --filter @tailored-ai/server --filter @tailored-ai/cli run build); then
    echo "  build failed — leaving running services untouched" >&2
    return 1
  fi
  local elapsed=$((SECONDS - started))
  (( elapsed < 0 )) && elapsed=0
  echo "  build ok (${elapsed}s)"
}

# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

cmd_start() {
  parse_action_args "$@" || return 1
  local targets; targets="$(resolve_targets "${parsed_targets_arg:-default}")"
  targets_need_instance "$targets" && { require_instance || return 1; }
  if [[ $parsed_skip_build -eq 0 ]] && targets_include_agent "$targets"; then
    do_build || return 1
  fi
  for t in $targets; do "start_$t"; done
}

cmd_stop() {
  parse_action_args "$@" || return 1
  local targets; targets="$(resolve_targets "${parsed_targets_arg:-default}")"
  targets_need_instance "$targets" && { require_instance || return 1; }
  for t in $targets; do stop_one "$t"; done
}

cmd_restart() {
  parse_action_args "$@" || return 1
  local targets; targets="$(resolve_targets "${parsed_targets_arg:-default}")"
  targets_need_instance "$targets" && { require_instance || return 1; }
  # Build *before* stopping anything so a compile error doesn't drop the
  # running agent. UI / vllm restarts don't need the workspace build.
  if [[ $parsed_skip_build -eq 0 ]] && targets_include_agent "$targets"; then
    do_build || return 1
  fi
  for t in $targets; do stop_one "$t"; done
  sleep 1
  for t in $targets; do "start_$t"; done
}

# Hand the agent + ui slots to one instance. vllm is untouched — it serves
# every instance and reloading it here would cost minutes for nothing.
cmd_switch() {
  parse_action_args "$@" || return 1
  require_instance || return 1
  local name
  for name in $(instance_names); do
    [[ "$name" == "$INSTANCE" ]] && continue
    for svc in "${INSTANCE_SERVICES[@]}"; do
      is_running "$svc" "$name" && stop_one "$svc" "$name"
    done
  done
  sleep 1
  if [[ $parsed_skip_build -eq 0 ]]; then do_build || return 1; fi
  start_agent
}

cmd_status() {
  parse_action_args "$@" || return 1
  printf "%-10s  %-7s  %-9s  %-8s  %s\n" INSTANCE SERVICE STATE PID LOG

  local pid state
  pid="-"; state="stopped"
  if is_running vllm; then pid="$(cat "$(pid_file vllm)")"; state="running"; fi
  printf "%-10s  %-7s  %-9s  %-8s  %s\n" "(shared)" "vllm" "$state" "$pid" "$(log_file vllm)"

  local names; names="$(instance_names)"
  [[ -n "$INSTANCE" ]] && names="$INSTANCE"
  for name in $names; do
    local home; home="$(instance_home "$name" || echo '?')"
    for svc in "${INSTANCE_SERVICES[@]}"; do
      pid="-"; state="stopped"
      if is_running "$svc" "$name"; then pid="$(cat "$(pid_file "$svc" "$name")")"; state="running"; fi
      printf "%-10s  %-7s  %-9s  %-8s  %s\n" "$name" "$svc" "$state" "$pid" "$(log_file "$svc" "$name")"
    done
    printf "%-10s  %-7s  %s\n" "$name" "home" "$home"
  done
}

cmd_logs() {
  parse_action_args "$@" || return 1
  local name="$parsed_targets_arg"
  [[ -n "$name" ]] || { echo "usage: logs -i <instance> <service> [tail-lines]" >&2; return 1; }
  is_instance_service "$name" && { require_instance || return 1; }
  local log; log="$(log_file "$name")"
  [[ -f "$log" ]] || { echo "no log yet: $log" >&2; return 1; }
  tail -n "${LOG_LINES:-80}" "$log"
}

cmd_instances() {
  printf "%-10s  %-9s  %s\n" INSTANCE AGENT HOME
  for name in $(instance_names); do
    local state="stopped"
    is_running agent "$name" && state="running"
    printf "%-10s  %-9s  %s\n" "$name" "$state" "$(instance_home "$name" || echo '?')"
  done
  echo ""
  echo "Declared in $INSTANCES_CONF"
}

cmd_build() { do_build; }

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

usage() { sed -n '2,26p' "$0"; }

main() {
  CURRENT_SUB="${1:-}"
  local sub="$CURRENT_SUB"
  shift || true
  # `logs` takes a trailing line count that isn't a target; peel it off first.
  if [[ "$sub" == "logs" ]]; then
    local last="${*: -1}"
    if [[ "$last" =~ ^[0-9]+$ ]]; then LOG_LINES="$last"; set -- "${@:1:$#-1}"; fi
  fi
  case "$sub" in
    start|stop|restart|switch|status|logs|instances)
      ensure_instances_conf
      migrate_flat_layout ;;
  esac
  case "$sub" in
    start)     cmd_start "$@" ;;
    stop)      cmd_stop "$@" ;;
    restart)   cmd_restart "$@" ;;
    switch)    cmd_switch "$@" ;;
    status)    cmd_status "$@" ;;
    logs)      cmd_logs "$@" ;;
    instances) cmd_instances ;;
    build)     cmd_build ;;
    wait-vllm) cmd_wait_vllm "$@" ;;
    ""|-h|--help) usage ;;
    *) echo "unknown command: $sub" >&2; usage; exit 2 ;;
  esac
}

main "$@"
