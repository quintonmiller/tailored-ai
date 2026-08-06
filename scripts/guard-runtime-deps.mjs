#!/usr/bin/env node
// Runtime dependency guard for the self-host image.
//
// The image is assembled with `pnpm deploy --prod`, so everything a
// first-party package lists under `dependencies` ships to every self-hoster —
// whether or not the runtime can reach it. That is how `@tailored-ai/
// browser-mediator` put Playwright's driver in a container that has no
// browsers to drive: the only reference in the package is a lazy
// `await import("playwright")`, and its own README already told you to install
// Playwright separately. Issue #375.
//
// This guard is the cheap half of the fix. It fails the build when a
// build-time or browser-automation package is declared as a hard runtime
// dependency of a first-party package. The other half lives in
// scripts/prune-dev-peers.mjs, which handles the optional peers that
// `--prod` keeps, and in the image-size ceiling in
// .github/workflows/docker-image.yml.
//
// A package that is genuinely needed at runtime but only sometimes belongs in
// `optionalDependencies` (installed by default, tolerates a failed build) or
// in `peerDependencies` with `optional: true` (the user supplies it). Both are
// left alone here.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Packages that are large and are never needed to *run* an agent. Each ships
// tens of MB and each has a lazy-import or dev-only usage pattern in this repo.
const NOT_RUNTIME = new Map([
  ["playwright", "browser driver — import it lazily; browsers are a separate install"],
  ["playwright-core", "browser driver — see playwright"],
  ["puppeteer", "browser driver — import it lazily"],
  ["md-to-pdf", "pulls typescript + a second browser driver; import it lazily"],
  ["vitest", "test runner"],
  ["vite", "build tool"],
  ["rollup", "build tool"],
  ["esbuild", "build tool"],
  ["typescript", "compiler — a built package ships dist/, not a compiler"],
  ["tsx", "TypeScript loader — dev only"],
  ["lightningcss", "CSS transpiler — build tool"],
]);

// Driving a browser is the entire product for these, so the dependency is not
// a mistake. `docker/tai/Dockerfile` never copies packages/trusted-actions
// into the build context, so this does not reach the self-host image either;
// it ships as its own image (docs/trusted-actions.md).
const ALLOWED = new Set(["@tailored-ai/trusted-actions\0playwright"]);

const errors = [];

for (const dir of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "packages", dir.name, "package.json"), "utf8"));
  } catch {
    continue;
  }
  if (pkg.private) continue; // site, integration-tests: never deployed
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const why = NOT_RUNTIME.get(name);
    if (!why) continue;
    if (ALLOWED.has(`${pkg.name}\0${name}`)) continue;
    errors.push(
      `${pkg.name}: "${name}" is a runtime \`dependency\` — ${why}.\n` +
        `      Move it to devDependencies, and add an optional peerDependency ` +
        `if callers may supply it.`,
    );
  }
}

if (errors.length) {
  console.error("\n✖ runtime dependency guard failed:\n");
  for (const e of errors) console.error("  - " + e);
  console.error(
    "\nEverything under `dependencies` ships in the self-host image. See issue " +
      "#375 and docs/self-hosting.md.\n",
  );
  process.exit(1);
}

console.log(
  `✓ runtime dependency guard: no build-time or browser package is a runtime dependency.`,
);
