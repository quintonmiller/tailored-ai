/**
 * Comment-preserving edits to config.yaml's `plugins:` list, used by
 * `tai plugin install` / `remove` so users don't hand-edit config to
 * enable a plugin they just installed. Same `parseDocument` approach as
 * the setup wizard — comments and formatting in the rest of the file
 * survive the round trip.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMap, isScalar, isSeq, parseDocument, YAMLSeq } from "yaml";

export interface ConfigEntryResult {
  /** Names actually added / removed. */
  changed: string[];
  /** Names that needed no edit (already present on add; absent on remove). */
  unchanged: string[];
}

/** Read the module name out of one `plugins:` entry (string or `{ module }`). */
function entryModule(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && "module" in node) {
    const m = (node as { module?: unknown }).module;
    return typeof m === "string" ? m : undefined;
  }
  return undefined;
}

/**
 * Append the given plugin names to `plugins:` in the config file, creating
 * the key if needed and skipping names already listed (as a bare string or
 * a `module:` object). No-op (all unchanged) when the file doesn't exist.
 */
export function addPluginsToConfig(configPath: string, names: string[]): ConfigEntryResult {
  if (!existsSync(configPath)) return { changed: [], unchanged: [...names] };
  const doc = parseDocument(readFileSync(configPath, "utf8"));

  const existing = new Set<string>();
  const current = doc.get("plugins", true);
  if (isSeq(current)) {
    for (const item of current.toJS(doc) as unknown[]) {
      const mod = entryModule(item);
      if (mod) existing.add(mod);
    }
  }

  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const name of names) {
    if (existing.has(name)) {
      unchanged.push(name);
      continue;
    }
    if (isSeq(doc.get("plugins", true))) {
      doc.addIn(["plugins"], name);
    } else {
      // Missing, null, or non-list value: (re)create as a one-item list.
      const seq = new YAMLSeq();
      seq.add(doc.createNode(name));
      doc.set("plugins", seq);
    }
    existing.add(name);
    changed.push(name);
  }

  if (changed.length > 0) writeFileSync(configPath, doc.toString(), "utf8");
  return { changed, unchanged };
}

/**
 * Remove the given plugin names from `plugins:` — matches bare-string
 * entries and `module:` objects (any `enabled` / `config` fields on the
 * entry go with it). No-op when the file or key doesn't exist.
 */
export function removePluginsFromConfig(configPath: string, names: string[]): ConfigEntryResult {
  if (!existsSync(configPath)) return { changed: [], unchanged: [...names] };
  const doc = parseDocument(readFileSync(configPath, "utf8"));

  const seq = doc.get("plugins", true);
  if (!isSeq(seq)) return { changed: [], unchanged: [...names] };

  const targets = new Set(names);
  const changed = new Set<string>();
  seq.items = seq.items.filter((item) => {
    let mod: string | undefined;
    if (isScalar(item) && typeof item.value === "string") {
      mod = item.value;
    } else if (isMap(item)) {
      const m = item.get("module", false);
      mod = typeof m === "string" ? m : undefined;
    }
    if (mod && targets.has(mod)) {
      changed.add(mod);
      return false;
    }
    return true;
  });

  if (changed.size > 0) writeFileSync(configPath, doc.toString(), "utf8");
  return {
    changed: [...changed],
    unchanged: names.filter((n) => !changed.has(n)),
  };
}
