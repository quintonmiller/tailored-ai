#!/usr/bin/env bash
# Host-side entry point for the integration tests. Resolves the repo root,
# builds the image, and runs scenarios inside it.
#
#   bash scripts/run.sh                # build + run every scenario
#   bash scripts/run.sh --build-only   # rebuild image, don't run
#   bash scripts/run.sh --shell        # drop into a shell in the runtime image
#   bash scripts/run.sh <name>         # run a single scenario, e.g. 03-basic-chat
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
image="${TAI_E2E_IMAGE:-tai-e2e:local}"

build() {
  echo "[e2e] building image $image (context: $repo_root)"
  docker build \
    -f "$here/Dockerfile" \
    -t "$image" \
    "$repo_root"
}

case "${1:-}" in
  --build-only)
    build
    ;;
  --shell)
    build
    docker run --rm -it "$image" shell
    ;;
  "")
    build
    docker run --rm "$image" all
    ;;
  *)
    build
    docker run --rm "$image" "$1"
    ;;
esac
