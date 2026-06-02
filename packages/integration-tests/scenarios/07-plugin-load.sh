#!/usr/bin/env bash
# Verifies the register(ctx) plugin contract from #47 end-to-end:
#
#   1. install a fixture plugin via `tai plugin install <path>`
#   2. add it to plugins:[] in config.yaml
#   3. run `tai -m` and confirm the plugin's register hook ran (marker log
#      from the fixture appears in CLI output)
#
# This is the scenario that #47 promised. Until #47 landed, side-effect
# plugins couldn't import @tailored-ai/core from the plugin home and would
# silently fail to register. The register(ctx) shape sidesteps resolution
# entirely.
set -euo pipefail

plugin_dir="/fixtures/plugin-echo-tool"
plugin_name="tai-plugin-echo-tool"

# Reset state from any earlier scenario that touched the plugin home.
rm -rf "$TAI_HOME/plugins/node_modules/$plugin_name" || true

echo "[scenario] install"
tai plugin install "$plugin_dir" >/dev/null

# Append the plugin to the seeded fixture config so the loader picks it up
# on the next run. The base config lives at /fixtures/config.yaml and was
# already copied into TAI_HOME by the entrypoint; the base config has no
# `plugins:` key, so appending a new top-level block is safe.
if ! grep -q "^plugins:" "$TAI_HOME/config.yaml"; then
  cat >>"$TAI_HOME/config.yaml" <<EOF

plugins:
  - $plugin_name
EOF
fi

echo "[scenario] message"
out=$(tai -a smoke -m "ping" 2>&1)
echo "$out"

# The fixture's register hook prints two marker lines. If the loader
# didn't invoke default(ctx), we wouldn't see them.
if ! echo "$out" | grep -q "\[plugin-echo-tool\] register called"; then
  echo "[scenario] expected plugin register marker in output" >&2
  exit 1
fi
if ! echo "$out" | grep -q "\[plugin-echo-tool\] registered echo_tool"; then
  echo "[scenario] expected post-register marker in output" >&2
  exit 1
fi
if ! echo "$out" | grep -q "loaded $plugin_name (register)"; then
  echo "[scenario] expected loader to log register-shape load" >&2
  exit 1
fi

echo "[scenario] plugin register(ctx) contract OK"
