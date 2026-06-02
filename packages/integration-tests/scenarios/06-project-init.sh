#!/usr/bin/env bash
# `tai project init` / `tai project list` lifecycle: register a directory as
# a project and confirm it shows up. Exercises the SQLite project store and
# the project subcommand router.
set -euo pipefail

work=/work/project-fixture
rm -rf "$work"
mkdir -p "$work"

cd "$work"
echo "[scenario] tai project init"
init_out=$(tai project init <<<"")
echo "$init_out"

echo "[scenario] tai project list"
list_out=$(tai project list)
echo "$list_out"

# init writes the project under TAI_HOME's database. list reads it back.
# We don't know the auto-generated id, but the path should appear.
echo "$list_out" | grep -q "$work"
echo "[scenario] project lifecycle OK"
