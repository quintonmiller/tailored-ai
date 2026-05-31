// Copy pwa/ → dist/pwa/ and stamp the build ID into the files that
// reference __BUILD_ID__. Run from `npm run build` in this package.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "pwa");
const DST = path.join(ROOT, "dist", "pwa");

// Build ID: ISO timestamp without separators (sortable, readable).
const BUILD_ID = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, "")
  .slice(0, 14); // YYYYMMDDHHMMSS

if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });

// Stamp files that contain __BUILD_ID__.
const STAMP_FILES = ["index.html", "sw.js", "app.js"];
for (const name of STAMP_FILES) {
  const p = path.join(DST, name);
  if (!fs.existsSync(p)) continue;
  let body = fs.readFileSync(p, "utf8");
  body = body.replace(/__BUILD_ID__/g, BUILD_ID);
  fs.writeFileSync(p, body);
}

console.log(`[build-pwa] PWA built with BUILD_ID=${BUILD_ID}`);
