import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentConfig, AgentDefinition } from "../config.js";
import { type AgentRegistry, agentDefinitionToManifest, parseAgentData } from "./agent.js";
import type { Resource, ResourceOrigin } from "./interface.js";
import { validateManifest } from "./manifest.js";

/**
 * Where authored agent resources live on disk. Mirrors the path used by the
 * server's `/api/authored/:kind` endpoints — there's one canonical location
 * so both server and runtime see the same files.
 */
export function authoredAgentRoot(contextDir: string): string {
  return resolve(contextDir, "..", "authored-resources", "agent");
}

export function authoredAgentDir(contextDir: string, id: string): string {
  return resolve(authoredAgentRoot(contextDir), id);
}

export function authoredAgentManifestPath(contextDir: string, id: string): string {
  return join(authoredAgentDir(contextDir, id), "manifest.yaml");
}

/**
 * On runtime startup, export every agent defined in `config.yaml` to its own
 * `manifest.yaml` under `data/authored-resources/agent/<name>/`.
 *
 * - If the manifest doesn't exist yet, write it (the original migration step).
 * - If the manifest exists but its `data:` field has drifted from what
 *   `config.yaml` would produce, re-export and warn. This makes config.yaml
 *   the source of truth for agents that are still defined there — without
 *   this, config-yaml edits silently stop taking effect once the registry
 *   has been seeded.
 * - If the manifest is up-to-date, leave it alone.
 *
 * Returns the ids touched (split into `migrated` for first-time exports and
 * `resynced` for drift-driven re-exports) so callers can log the difference.
 */
export interface MigrationResult {
  migrated: string[];
  resynced: string[];
}

export function migrateConfigAgentsToResources(config: AgentConfig, contextDir: string): MigrationResult {
  const result: MigrationResult = { migrated: [], resynced: [] };
  const agents = config.agents ?? {};
  for (const [id, definition] of Object.entries(agents)) {
    if (!id) continue;
    const manifestPath = authoredAgentManifestPath(contextDir, id);
    const fresh = agentDefinitionToManifest({ id, definition: definition as AgentDefinition });

    if (!existsSync(manifestPath)) {
      mkdirSync(authoredAgentDir(contextDir, id), { recursive: true });
      writeFileSync(manifestPath, stringifyYaml(fresh), "utf8");
      result.migrated.push(id);
      continue;
    }

    // Compare existing manifest's data field to the freshly-derived one.
    // Stringify-and-compare is good enough — both go through the same
    // serialiser. If anything is different, the config has won.
    try {
      const existingRaw = readFileSync(manifestPath, "utf8");
      const existing = parseYaml(existingRaw) as { data?: unknown };
      const existingData = stringifyYaml(existing?.data ?? null);
      const freshData = stringifyYaml(fresh.data ?? null);
      if (existingData !== freshData) {
        writeFileSync(manifestPath, stringifyYaml(fresh), "utf8");
        result.resynced.push(id);
      }
    } catch (err) {
      // Bad / unreadable manifest — overwrite it so the system isn't stuck.
      console.warn(
        `[agents] couldn't read existing manifest for "${id}" (${(err as Error).message}); overwriting from config.yaml`,
      );
      writeFileSync(manifestPath, stringifyYaml(fresh), "utf8");
      result.resynced.push(id);
    }
  }
  return result;
}

/**
 * Walk `data/authored-resources/agent/` and register every manifest into the
 * supplied registry. Returns the ids that loaded successfully.
 */
export function populateAgentsFromDisk(registry: AgentRegistry, contextDir: string): string[] {
  const root = authoredAgentRoot(contextDir);
  if (!existsSync(root)) return [];
  const loaded: string[] = [];
  function walk(rel: string) {
    const abs = resolve(root, rel);
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    let hasManifest = false;
    for (const e of entries) {
      if (e.isFile() && e.name === "manifest.yaml") {
        hasManifest = true;
        const manifestPath = join(abs, "manifest.yaml");
        try {
          const text = readFileSync(manifestPath, "utf8");
          const raw = parseYaml(text);
          const manifest = validateManifest(raw, manifestPath);
          if (manifest.kind !== "agent") continue;
          const id = rel.split(/[\\/]/).join("/") || manifest.id;
          const definition = parseAgentData(manifest);
          const origin: ResourceOrigin = {
            scheme: "file",
            uri: `file://${manifestPath}`,
            localPath: abs,
            loadedAt: Date.now(),
          };
          const resource: Resource = {
            manifest: { ...manifest, id },
            origin,
            body: { manifest: { ...manifest, id }, definition },
          };
          registry.register(resource as never);
          loaded.push(id);
        } catch (err) {
          console.warn(`[agents] failed to load ${manifestPath}: ${(err as Error).message}`);
        }
      }
    }
    if (hasManifest) return;
    for (const e of entries) {
      if (e.isDirectory()) walk(join(rel, e.name));
    }
  }
  try {
    statSync(root);
    walk(".");
  } catch {
    // root doesn't exist yet
  }
  return loaded;
}
