#!/usr/bin/env node
/**
 * tai-model — switch which provider every agent runs on.
 *
 *   node scripts/tai-model.mjs status [-i <instance>]
 *   node scripts/tai-model.mjs use <provider> [-i <instance>] [--model <id>]
 *
 * Flips `agent.defaultProvider` in an instance's config.yaml, keeping comments
 * and formatting intact, after backing the file up.
 *
 * This is the whole fallback mechanism, and it is deliberately manual: core has
 * no request-time failover, and `AgentDefinition.models[]` is inert despite its
 * docstring (see docs/model-fallbacks.md). Any agent that sets its own
 * `provider:` keeps it; everything else follows the default.
 *
 * Instances come from ~/.tai/instances.conf, the same file tai-ctl.sh reads.
 * Restart the agent service afterwards — config hot-reload does not reliably
 * pick up a provider change:
 *
 *   scripts/tai-ctl.sh restart -i <instance> agent
 */

import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseDocument } from "yaml";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANCES_CONF = join(homedir(), ".tai", "instances.conf");

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: tai-model.mjs status [-i <instance>]");
  console.error("       tai-model.mjs use <provider> [-i <instance>] [--model <id>]");
  process.exit(msg ? 1 : 0);
}

function instanceHomes() {
  if (!existsSync(INSTANCES_CONF)) return {};
  const out = {};
  for (const raw of readFileSync(INSTANCES_CONF, "utf8").split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const argv = process.argv.slice(2);
const command = argv.shift();
if (!command || command === "--help" || command === "-h") usage();

let instance;
let modelOverride;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-i") instance = argv[++i];
  else if (argv[i] === "--model") modelOverride = argv[++i];
  else positional.push(argv[i]);
}

const homes = instanceHomes();
const names = Object.keys(homes);
if (!instance) {
  if (names.length === 1) instance = names[0];
  else usage(`-i is required. Known instances: ${names.join(", ") || "(none declared)"}`);
}
const home = homes[instance];
if (!home) usage(`no instance named "${instance}". Known: ${names.join(", ") || "(none)"}`);

const configPath = join(home, "config.yaml");
if (!existsSync(configPath)) usage(`${configPath} does not exist`);

// parseDocument rather than parse: this file is hand-maintained and full of
// comments, and a round-trip through plain objects would strip every one.
const doc = parseDocument(readFileSync(configPath, "utf8"));
const providers = doc.get("providers");
const providerIds = providers?.items?.map((p) => String(p.key)) ?? [];
const current = doc.getIn(["agent", "defaultProvider"]);

const describe = (id) => {
  const model = doc.getIn(["providers", id, "defaultModel"]);
  const base = doc.getIn(["providers", id, "baseUrl"]);
  return `${id.padEnd(20)} ${String(model ?? "(no defaultModel)").padEnd(28)}${base ? ` ${base}` : ""}`;
};

if (command === "status") {
  console.log(`instance: ${instance}  (${configPath})`);
  console.log(`active:   ${current}\n`);
  console.log("available providers:");
  for (const id of providerIds) console.log(`  ${id === current ? "*" : " "} ${describe(id)}`);
  process.exit(0);
}

if (command !== "use") usage(`unknown command "${command}"`);

const target = positional[0];
if (!target) usage("use requires a provider id");
if (!providerIds.includes(target)) {
  usage(`providers.${target} is not configured. Available: ${providerIds.join(", ")}`);
}
const targetModel = modelOverride ?? doc.getIn(["providers", target, "defaultModel"]);
if (!targetModel) usage(`providers.${target} has no defaultModel — pass --model <id>`);

if (target === current && !modelOverride) {
  console.log(`already on ${target} (${targetModel}); nothing to do`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${configPath}.bak-before-model-switch-${stamp}`;
copyFileSync(configPath, backup);

// Surgical line edits rather than writing `doc` back out. A full YAML
// round-trip preserves comments but reflows their alignment, which on a
// hand-maintained 100KB config means every switch produces diff noise that
// buries the one line that actually changed.
let text = readFileSync(configPath, "utf8");
const providerLine = /^(\s*)defaultProvider:[^\n]*$/m;
// Test for the line rather than comparing before/after: rewriting
// `defaultProvider: deepseek` to the same value is a legitimate no-op when only
// --model is changing, and must not be mistaken for "the key is missing".
if (!providerLine.test(text)) usage("could not find `defaultProvider:` to rewrite — edit config.yaml by hand");
text = text.replace(providerLine, `$1defaultProvider: ${target}`);

if (modelOverride) {
  // Only inside the target provider's own block: `defaultModel` appears once
  // per provider, so anchor on the provider key and take the first one after it.
  const at = text.search(new RegExp(`^\\s{2}${target}:\\s*$`, "m"));
  if (at < 0) usage(`could not locate the providers.${target} block to set --model`);
  const head = text.slice(0, at);
  const tail = text.slice(at).replace(/^(\s*)defaultModel:[^\n]*$/m, `$1defaultModel: ${modelOverride}`);
  text = head + tail;
}
writeFileSync(configPath, text, "utf8");

console.log(`${current} -> ${target} (${targetModel})`);
console.log(`backup: ${backup}`);
console.log(`\nRestart to apply:  ${join(REPO, "scripts/tai-ctl.sh")} restart -i ${instance} agent`);
