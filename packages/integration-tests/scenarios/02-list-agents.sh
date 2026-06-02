#!/usr/bin/env bash
# Asserts that `tai --list-agents` finds the agent declared in the fixture
# config — i.e. that config loading + agent merging work end-to-end against
# an installed CLI, not just the workspace dev path.
set -euo pipefail

out=$(tai --list-agents)
echo "$out"
echo "$out" | grep -q "smoke"
