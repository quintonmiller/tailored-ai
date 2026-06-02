#!/usr/bin/env bash
# Smoke check: `tai --help` exits 0 and prints usage. Catches missing bin
# entries, broken shebangs, and import-time crashes in the CLI.
set -euo pipefail

out=$(tai --help)
echo "$out"
echo "$out" | grep -qi "Usage: tai"
