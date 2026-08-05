/**
 * Deploy-target registry and discovery.
 *
 * Lives in the CLI rather than core: `tai deploy` is the only caller, and the
 * agent runtime has no use for the concept. Core holds the type contract only
 * (see `@tailored-ai/core`'s `deploy/types.ts` for why the split is there).
 */

import { type DeployTarget, Registry } from "@tailored-ai/core";
import { PluginManager } from "../plugins/manager.js";
import { dockerTarget } from "./targets/docker.js";

/** Built-in targets. `docker` ships here so the seam has a working reference
 * implementation and is exercised by TAI's own test suite — a registry whose
 * only implementations live in unreleased plugins is a registry nobody has
 * proven works. */
export const BUILTIN_DEPLOY_TARGETS: DeployTarget[] = [dockerTarget];

export function createDeployRegistry(): Registry<DeployTarget> {
  const registry = new Registry<DeployTarget>("deploy-target");
  for (const target of BUILTIN_DEPLOY_TARGETS) registry.register(target.id, target);
  return registry;
}

/**
 * Anything a discovery pass could not use, so `tai deploy list` can say why a
 * plugin the operator installed is not showing up. Silence there is the worst
 * outcome: the plugin is present, the target is absent, and nothing explains it.
 */
export interface DeployDiscoveryProblem {
  module: string;
  reason: string;
}

export interface DeployDiscovery {
  registry: Registry<DeployTarget>;
  problems: DeployDiscoveryProblem[];
}

/** Shape-check an entry before trusting it. A plugin exporting a half-built
 * object should be reported, not registered and then crashed into. */
function validateTarget(value: unknown): string | null {
  if (!value || typeof value !== "object") return "not an object";
  const t = value as Partial<DeployTarget>;
  if (typeof t.id !== "string" || !t.id) return "missing a string `id`";
  if (typeof t.description !== "string") return `target "${t.id}" is missing a string \`description\``;
  if (typeof t.plan !== "function") return `target "${t.id}" is missing \`plan()\``;
  if (typeof t.up !== "function") return `target "${t.id}" is missing \`up()\``;
  return null;
}

/**
 * Register built-ins, then every `deployTargets` export found in the installed
 * plugins under `<homeDir>/plugins/`.
 *
 * This deliberately does NOT go through `loadPlugins`: that reads
 * `config.plugins` from a loaded config, and `tai deploy` is often the command
 * that creates the instance the config would describe. Discovery here is by
 * *installation*, not by configuration — if you `tai plugin install` a deploy
 * package, its targets are available immediately, config or no config.
 *
 * A plugin that fails to import is reported and skipped. One broken package
 * must not make `tai deploy list` unusable.
 */
export async function discoverDeployTargets(
  homeDir: string,
  opts: { manager?: PluginManager } = {},
): Promise<DeployDiscovery> {
  const registry = createDeployRegistry();
  const problems: DeployDiscoveryProblem[] = [];

  const manager = opts.manager ?? new PluginManager(homeDir);
  let installed: Array<{ name: string }>;
  try {
    installed = manager.list();
  } catch {
    // No plugin home yet — a fresh install. Built-ins are still available.
    return { registry, problems };
  }

  const importer = manager.buildImporter();
  for (const { name } of installed) {
    let mod: { deployTargets?: unknown } | undefined;
    try {
      mod = (await importer(name)) as { deployTargets?: unknown };
    } catch (err) {
      problems.push({ module: name, reason: `import failed: ${(err as Error).message}` });
      continue;
    }
    // Most plugins contribute nothing here. Absence is normal, not a problem.
    if (mod?.deployTargets === undefined) continue;
    if (!Array.isArray(mod.deployTargets)) {
      problems.push({ module: name, reason: "`deployTargets` export is not an array" });
      continue;
    }
    for (const entry of mod.deployTargets) {
      const invalid = validateTarget(entry);
      if (invalid) {
        problems.push({ module: name, reason: invalid });
        continue;
      }
      const target = entry as DeployTarget;
      // Registry.register warns on replacement; say which package won, since
      // "my target stopped working" is otherwise an unsearchable symptom.
      if (registry.has(target.id)) {
        problems.push({ module: name, reason: `target "${target.id}" overrides an already-registered target` });
      }
      registry.register(target.id, target);
    }
  }

  return { registry, problems };
}
