import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentConfig, AgentDefinition } from "../config.js";
import type { Resource, ResourceOrigin } from "./interface.js";
import { agentDefinitionToManifest, AgentRegistry, parseAgentData } from "./agent.js";
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
 * `manifest.yaml` under `data/authored-resources/agent/<name>/`. Skips agents
 * that already have a file on disk — re-runs are idempotent.
 *
 * Returns the ids that were newly written (for logging / telemetry).
 */
export function migrateConfigAgentsToResources(
  config: AgentConfig,
  contextDir: string,
): string[] {
  const migrated: string[] = [];
  const agents = config.agents ?? {};
  for (const [id, definition] of Object.entries(agents)) {
    if (!id) continue;
    const manifestPath = authoredAgentManifestPath(contextDir, id);
    if (existsSync(manifestPath)) continue;
    const manifest = agentDefinitionToManifest({ id, definition: definition as AgentDefinition });
    mkdirSync(authoredAgentDir(contextDir, id), { recursive: true });
    writeFileSync(manifestPath, stringifyYaml(manifest), "utf8");
    migrated.push(id);
  }
  return migrated;
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
    let entries;
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

