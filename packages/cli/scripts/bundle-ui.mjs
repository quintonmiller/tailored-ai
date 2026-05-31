#!/usr/bin/env node
// Copies the built UI from packages/ui/dist into packages/cli/ui-dist
// so it ships inside the published CLI tarball. The CLI's server serves
// ui-dist/ as the static frontend when the SPA is requested.
//
// Run automatically as part of `pnpm --filter @tailored-ai/cli run build`.
// Fails loudly if the UI hasn't been built yet — there is no point publishing
// a CLI with no UI.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..", "ui", "dist");
const dest = resolve(here, "..", "ui-dist");

if (!existsSync(src)) {
  console.error(
    `[bundle-ui] ${src} not found.\n` +
      "  The UI must be built before the CLI. Run `pnpm --filter @tailored-ai/ui run build` first,\n" +
      "  or use the top-level `pnpm run build` which sequences the builds.",
  );
  process.exit(1);
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[bundle-ui] copied ${src} -> ${dest}`);
