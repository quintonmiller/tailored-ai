#!/usr/bin/env bash
# Exercises the `tai plugin install / list / remove` flow against a local
# fixture plugin. No npm registry is involved — we hand npm a directory and
# verify the plugin home picks it up.
set -euo pipefail

plugin_dir="/fixtures/plugin-noop"
plugin_name="tai-plugin-noop"
plugin_home="$TAI_HOME/plugins"
plugin_pkg="$plugin_home/node_modules/$plugin_name"

# Sanity: previous scenarios might have left state behind. Plugin home is
# auto-bootstrapped on first use; force-clean only what we own.
rm -rf "$plugin_home/node_modules/$plugin_name" || true

echo "[scenario] install"
tai plugin install "$plugin_dir"

if [ ! -f "$plugin_pkg/package.json" ]; then
  echo "[scenario] expected $plugin_pkg/package.json to exist after install" >&2
  ls -la "$plugin_home" "$plugin_home/node_modules" 2>&1 >&2 || true
  exit 1
fi

# Plugin home's package.json should now list the plugin under deps.
if ! jq -e --arg name "$plugin_name" '.dependencies[$name]' "$plugin_home/package.json" >/dev/null; then
  echo "[scenario] expected $plugin_name in plugin home dependencies" >&2
  cat "$plugin_home/package.json" >&2
  exit 1
fi

echo "[scenario] list"
list_out=$(tai plugin list)
echo "$list_out"
echo "$list_out" | grep -q "$plugin_name"

echo "[scenario] remove"
tai plugin remove "$plugin_name"

if [ -d "$plugin_pkg" ]; then
  echo "[scenario] expected $plugin_pkg to be gone after remove" >&2
  exit 1
fi
if jq -e --arg name "$plugin_name" '.dependencies[$name]' "$plugin_home/package.json" >/dev/null 2>&1; then
  echo "[scenario] expected $plugin_name to be removed from plugin home deps" >&2
  cat "$plugin_home/package.json" >&2
  exit 1
fi

echo "[scenario] plugin lifecycle OK"
