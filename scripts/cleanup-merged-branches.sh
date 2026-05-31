#!/usr/bin/env bash
# cleanup-merged-branches.sh — delete agent/ branches that are ancestors of main.
#
# Usage:
#   scripts/cleanup-merged-branches.sh            # dry-run (default)
#   scripts/cleanup-merged-branches.sh --apply    # actually delete
#   scripts/cleanup-merged-branches.sh --remote   # include remote tracking branches

set -euo pipefail

APPLY=0
DO_REMOTE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --remote) DO_REMOTE=1 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

MAIN_REF="${MAIN_REF:-main}"
git rev-parse --verify "$MAIN_REF" >/dev/null 2>&1 || { echo "no $MAIN_REF ref"; exit 1; }

deleted_local=0
deleted_remote=0
kept=0

# Local branches.
while IFS= read -r br; do
  [ -z "$br" ] && continue
  if git merge-base --is-ancestor "$br" "$MAIN_REF" 2>/dev/null; then
    if [ "$APPLY" -eq 1 ]; then
      git branch -D "$br" >/dev/null
      echo "deleted local: $br"
    else
      echo "would delete (local): $br"
    fi
    deleted_local=$((deleted_local + 1))
  else
    kept=$((kept + 1))
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/agent/)

# Remote branches (origin/agent/*).
if [ "$DO_REMOTE" -eq 1 ]; then
  while IFS= read -r remote_br; do
    [ -z "$remote_br" ] && continue
    # remote_br looks like "origin/agent/ptask_xxx-foo"
    if git merge-base --is-ancestor "$remote_br" "$MAIN_REF" 2>/dev/null; then
      short_name="${remote_br#origin/}"
      if [ "$APPLY" -eq 1 ]; then
        git push origin --delete "$short_name" >/dev/null 2>&1 \
          && echo "deleted remote: $remote_br" \
          || echo "skipped remote (push failed): $remote_br"
      else
        echo "would delete (remote): $remote_br"
      fi
      deleted_remote=$((deleted_remote + 1))
    fi
  done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin/agent/)
fi

echo ""
echo "summary: ${deleted_local} local merged, ${deleted_remote} remote merged, ${kept} unmerged kept"
if [ "$APPLY" -eq 0 ]; then
  echo "(dry run — pass --apply to actually delete; --remote to also clean origin)"
fi
