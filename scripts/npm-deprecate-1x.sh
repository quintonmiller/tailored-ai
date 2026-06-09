#!/usr/bin/env bash
#
# Roll back the accidentally-published 1.0.x releases of the @tailored-ai fixed
# group. We CANNOT unpublish them — the packages depend on each other in the
# registry, so npm's "no dependent packages" unpublish criterion can never be
# met (npm 405 "has dependent packages in the registry"). The supported path is
# to DEPRECATE the bad versions and re-point the `latest` dist-tag at the last
# good 0.x. See docs/publishing.md.
#
# Auth: the maintainer's npm 2FA is a WebAuthn security key, which the CLI can't
# use for `--otp`. Pass an npm AUTOMATION or GRANULAR access token (both bypass
# 2FA for CLI writes) via the NPM_TOKEN env var. The token is written to a
# throwaway userconfig so your real ~/.npmrc is never touched.
#
#   1. npmjs.com -> Access Tokens -> Generate New Token
#      -> Granular Access Token: Read and write, scope @tailored-ai  (or Classic -> Automation)
#   2. NPM_TOKEN=npm_xxx bash scripts/npm-deprecate-1x.sh
#
set -euo pipefail

# --- knobs -------------------------------------------------------------------
PKGS=(core server cli google-tools channel-slack trusted-actions browser-mediator)
BAD_VERSIONS=(1.0.0 1.0.1)
GOOD_LATEST=0.1.6   # what `latest` should resolve to until a real V1 / 0.1.7
DEPRECATE_MSG="Published in error — @tailored-ai is staying on 0.x until a deliberate V1. Use the 0.1.x line."
# -----------------------------------------------------------------------------

: "${NPM_TOKEN:?Set NPM_TOKEN to an npm automation/granular token with read+write on @tailored-ai}"

NPMRC="$(mktemp)"
cleanup() { rm -f "$NPMRC"; }
trap cleanup EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"

npm_() { npm --userconfig "$NPMRC" --registry https://registry.npmjs.org/ "$@"; }

echo "Authenticated as: $(npm_ whoami)"
echo

for p in "${PKGS[@]}"; do
  pkg="@tailored-ai/$p"
  echo "==> $pkg"
  for v in "${BAD_VERSIONS[@]}"; do
    if npm_ view "$pkg@$v" version >/dev/null 2>&1; then
      echo "    deprecate $pkg@$v"
      npm_ deprecate "$pkg@$v" "$DEPRECATE_MSG"
    else
      echo "    skip (not published): $pkg@$v"
    fi
  done
  echo "    re-point latest -> $pkg@$GOOD_LATEST"
  npm_ dist-tag add "$pkg@$GOOD_LATEST" latest
  echo
done

echo "Done. Resulting dist-tags:"
for p in "${PKGS[@]}"; do
  printf '  %-36s ' "@tailored-ai/$p"
  npm_ dist-tag ls "@tailored-ai/$p" | tr '\n' ' '
  echo
done
