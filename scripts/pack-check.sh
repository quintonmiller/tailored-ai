#!/usr/bin/env bash
# Pack every public @tailored-ai/* package and assert the tarball includes
# dist/index.js. Run from the repo root.
#
# Exists because release.yml runs `pnpm publish -r` over every workspace
# package; if the root `build` script forgets one, that package ships with
# a missing or stale dist directory (#56). This catches that before npm
# does.
#
# The package list is derived, never typed. It used to be a literal array with
# a comment asking the next person to keep it in sync with the changesets fixed
# group; six packages were added after that comment and none of them made it
# in, so the guard silently covered 7 of 13 for several releases. `pnpm publish
# -r` ships every non-private workspace package, so that is the set this reads.
set -euo pipefail

OUTDIR=$(mktemp -d -t tai-pack-check-XXXXXX)
trap 'rm -rf "$OUTDIR"' EXIT

mapfile -t PUBLISHABLE < <(node -e '
  const { readdirSync, readFileSync } = require("node:fs");
  const names = [];
  for (const dir of readdirSync("packages")) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"));
    } catch {
      continue;
    }
    if (pkg.name && pkg.private !== true) names.push(pkg.name);
  }
  console.log(names.sort().join("\n"));
')

if [[ ${#PUBLISHABLE[@]} -eq 0 ]]; then
  echo "[pack-check] FAIL: found no publishable packages under packages/" >&2
  exit 1
fi

# The changesets `fixed` group decides what gets a version bump. A package that
# publishes without being in it ships whatever stale version its package.json
# happens to carry, which is the one failure mode a pack check cannot see.
drift=$(node -e '
  const { readFileSync } = require("node:fs");
  const fixed = new Set((JSON.parse(readFileSync(".changeset/config.json", "utf8")).fixed ?? []).flat());
  const shipping = new Set(process.argv.slice(1));
  const lines = [];
  for (const name of shipping) {
    if (!fixed.has(name)) lines.push(`  ${name} publishes but is not in the changesets fixed group — it would ship unbumped.`);
  }
  for (const name of fixed) {
    if (!shipping.has(name)) lines.push(`  ${name} is in the changesets fixed group but no longer publishes — stale entry.`);
  }
  console.log(lines.join("\n"));
' "${PUBLISHABLE[@]}")

if [[ -n "$drift" ]]; then
  echo "[pack-check] FAIL: the publishing set and the changesets fixed group disagree." >&2
  echo "$drift" >&2
  exit 1
fi

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
echo "[pack-check] All ${#PUBLISHABLE[@]} publishable packages produced a tarball with dist/index.js."
