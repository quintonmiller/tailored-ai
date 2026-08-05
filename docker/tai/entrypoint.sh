#!/bin/sh
# Container entrypoint for the TAI image.
#
# Its whole job is to make the first boot and the thousandth boot identical
# from the operator's point of view: if TAI_HOME has no config.yaml, write one
# from the environment; then hand off to the command.
#
# Deliberately a POSIX sh script with no cleverness. Anything that reads the
# config, decides what to run, or reconciles state belongs in `tai` itself,
# where it is tested — an entrypoint that grows logic becomes a second,
# untested configuration system that only runs in production.

set -eu

TAI_HOME="${TAI_HOME:-/data}"
CONFIG="${TAI_HOME}/config.yaml"

# Skipping init when config.yaml exists is what makes restarts idempotent, and
# it is why `tai init --non-interactive` refuses to overwrite without --force:
# a container that re-ran init on every start would silently discard whatever
# the operator had edited into the file since.
if [ ! -f "$CONFIG" ]; then
  echo "[entrypoint] no config at $CONFIG — running first-time setup"

  if [ -z "${TAI_MODEL:-}" ]; then
    cat >&2 <<'EOF'
[entrypoint] TAI_MODEL is not set, and there is nothing to fall back to.

  A guessed model produces a container that starts, passes its healthcheck,
  and then fails on the first message with a provider-side 404. Refusing now
  instead.

  Point TAI at a model, for example:

    -e TAI_MODEL=llama3.2 \
    -e TAI_BASE_URL=http://host.docker.internal:11434/v1

  Or mount a config.yaml you already have at /data/config.yaml and this step
  is skipped entirely.

  Full option list: docker run --rm <image> tai init --help
EOF
    exit 1
  fi

  # Everything else comes from the environment: TAI_PROVIDER, TAI_BASE_URL,
  # TAI_API_KEY, TAI_SERVER_HOST, TAI_SERVER_PORT, TAI_AUTH_TOKEN. The image
  # sets TAI_SERVER_HOST=0.0.0.0, so init mints an auth token unless one was
  # supplied, and prints it once — capture it from `docker logs`.
  tai init --non-interactive
fi

# `tai` loads TAI_HOME/.env itself (dotenv, and dotenv does not override
# variables already present in the environment) — so a token passed with
# `-e TAI_AUTH_TOKEN` still wins over the one init wrote on an earlier boot.

exec "$@"
