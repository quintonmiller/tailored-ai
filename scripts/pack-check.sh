#!/usr/bin/env bash
# Pack every public @tailored-ai/* package and assert the tarball includes
# dist/index.js. Run from the repo root.
#
# Exists because release.yml runs `pnpm publish -r` over every workspace
# package; if the root `build` script forgets one, that package ships with
# a missing or stale dist directory (#56). This catches that before npm
# does.
set -euo pipefail

OUTDIR=$(mktemp -d -t tai-pack-check-XXXXXX)
trap 'rm -rf "$OUTDIR"' EXIT

# Packages that publish to npm. Keep in sync with .changeset/config.json's
# fixed group. Private packages (ui, site, integration-tests) are skipped
# by design.
PUBLISHABLE=(
  "@tailored-ai/browser-mediator"
  "@tailored-ai/channel-slack"
  "@tailored-ai/cli"
  "@tailored-ai/core"
  "@tailored-ai/google-tools"
  "@tailored-ai/server"
  "@tailored-ai/trusted-actions"
)

fail=0
for pkg in "${PUBLISHABLE[@]}"; do
  echo
  echo "[pack-check] $pkg"
  pnpm --filter "$pkg" pack --pack-destination "$OUTDIR" >/dev/null

  # pnpm pack uses the package name + version + .tgz. Resolve by glob since
  # we don't want to parse the package.json version here.
  shortname="${pkg#@tailored-ai/}"
  tarball=$(ls "$OUTDIR"/tailored-ai-"$shortname"-*.tgz 2>/dev/null | head -n1 || true)
  if [[ -z "$tarball" ]]; then
    echo "[pack-check] FAIL: no tarball produced for $pkg" >&2
    fail=1
    continue
  fi

  # Every publishable package's package.json points main/exports at
  # ./dist/index.js (or ./dist/<name>.js). At minimum require dist/index.js.
  # `tar | grep -q` would SIGPIPE tar under `set -o pipefail`, so dump the
  # listing to a temp file and grep from disk.
  listing=$(mktemp)
  tar -tzf "$tarball" >"$listing"
  if ! grep -qE '^package/dist/index\.(js|cjs|mjs)$' "$listing"; then
    echo "[pack-check] FAIL: $pkg tarball is missing package/dist/index.js" >&2
    echo "[pack-check] tarball contents:" >&2
    sed 's/^/    /' "$listing" >&2
    rm -f "$listing"
    fail=1
    continue
  fi
  rm -f "$listing"

  echo "[pack-check] OK: $(basename "$tarball")"
done

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "[pack-check] One or more tarballs failed. Investigate the failing package's build script and tsconfig outDir." >&2
  exit 1
fi
echo
echo "[pack-check] All $((${#PUBLISHABLE[@]})) publishable packages produced a tarball with dist/index.js."
