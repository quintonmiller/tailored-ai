import type { AgentDefinition } from "../config.js";
import { AGENT_DEFINITION_KEYS, AgentDefinitionSchema, shapeIssues } from "../config-schema.js";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * `kind: "agent"` resource. Agents used to be config-yaml-only fragments
 * under `config.agents.<name>`. As of S11.4 they're first-class resources
 * that live in their own registry, can be authored at runtime, and can be
 * shipped inside bundles.
 *
 * The {@link AgentDefinition} structure is unchanged — only its home moves.
 * The manifest's `data` block carries the definition verbatim so the existing
 * config-yaml shape round-trips through the manifest.
 */
export interface AgentBody {
  manifest: ResourceManifest;
  definition: AgentDefinition;
}

/**
 * Convert a manifest into an {@link AgentDefinition}. Every field is
 * type-checked against `AgentDefinitionSchema` and then copied through
 * verbatim; a field this build does not recognise is warned about rather than
 * dropped in silence. Returning a partial object is intentional —
 * `resolveAgent` already supplies sensible defaults for every field.
 *
 * This used to be a hand-written allowlist of the fields someone had
 * remembered to copy, under a docstring promising that "unknown fields pass
 * through" — the opposite of what the code did. Anything not enumerated was
 * silently discarded on its way from the manifest to the loop. What that cost,
 * in one deployment: `fileBoundary` never reached `toolContextExtras`, so three
 * agents holding `write` and `edit` ran with a declared filesystem confinement
 * that did nothing, and thirteen agents set `injectMemory: true` and never got
 * a single injected memory. Both were configured, both round-tripped into the
 * manifest, and neither was ever read.
 *
 * The list that replaced it had the same weakness one level up: it was still
 * hand-maintained, so a field could be added to the interface and forgotten
 * here. It now derives from the schema, which cannot drift from the interface
 * without failing the build.
 */
export function parseAgentData(manifest: ResourceManifest): AgentDefinition {
  const data = manifest.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`agent ${manifest.id}: manifest.data must be an object`);
  }

  // `key:` with nothing after it has always counted as absent here, and stays
  // that way: a manifest is parsed at startup, where a rejection costs the
  // whole agent. config.yaml is held to the stricter reading, because there
  // the identical finding is a warning rather than a dead agent.
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value != null) present[key] = value;
  }

  const issues = shapeIssues(`agent ${manifest.id}`, AgentDefinitionSchema, present, "data");
  if (issues.length > 0) throw new Error(issues.join("; "));

  // Copied rather than taken from the schema's output, which would strip
  // unrecognised keys nested inside a known field without saying so.
  const out: AgentDefinition = {};
  for (const [key, value] of Object.entries(present)) {
    if (AGENT_DEFINITION_KEYS.has(key)) {
      (out as Record<string, unknown>)[key] = value;
      continue;
    }
    // `system_prompt` (the snake_case spelling of `systemPrompt`) sat in four
    // agents' config carrying their entire persona, round-tripped faithfully
    // into their manifests, and was read by nothing.
    console.warn(
      `[agents] ${manifest.id}: unknown field "${key}" — it will be ignored. ` +
        `Check the spelling (fields are camelCase), or remove it.`,
    );
  }

  return out;
}

/**
 * Build a manifest from an AgentDefinition + identity. The reverse of
 * `parseAgentData` — used by auto-migration and authoring endpoints.
 */
export function agentDefinitionToManifest(input: {
  id: string;
  definition: AgentDefinition;
  version?: string;
}): ResourceManifest {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.definition)) {
    if (v === undefined) continue;
    data[k] = v;
  }
  const manifest: ResourceManifest = {
    kind: "agent",
    id: input.id,
    version: input.version ?? "0.0.0",
    description: input.definition.description,
    data,
  };
  return manifest;
}

export class AgentRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  asResources(): ResourceRegistry {
    return this.resources;
  }

  registerBuiltin(input: {
    id: string;
    definition: AgentDefinition;
    description?: string;
    version?: string;
    origin?: ResourceOrigin;
  }): void {
    const manifest = agentDefinitionToManifest({
      id: input.id,
      definition: { ...input.definition, description: input.description ?? input.definition.description },
      version: input.version,
    });
    const origin: ResourceOrigin = input.origin ?? {
      scheme: "file",
      uri: `builtin:agent/${input.id}`,
      loadedAt: Date.now(),
    };
    this.resources.register({ manifest, origin, body: { manifest, definition: input.definition } });
  }

  register(resource: Resource<AgentBody>): void {
    if (resource.manifest.kind !== "agent") {
      throw new Error(`expected manifest.kind="agent", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "agent", id, version });
  }

  get(id: string, version?: string): AgentDefinition | undefined {
    return this.resources.get<AgentBody>({ kind: "agent", id, version })?.body?.definition;
  }

  list(): Array<{ id: string; definition: AgentDefinition }> {
    return this.resources
      .list<AgentBody>("agent")
      .filter((r) => !!r.body)
      .map((r) => ({ id: r.manifest.id, definition: r.body!.definition }));
  }

  listWithManifests(): Array<{ manifest: ResourceManifest; origin: ResourceOrigin; definition: AgentDefinition }> {
    const out: Array<{ manifest: ResourceManifest; origin: ResourceOrigin; definition: AgentDefinition }> = [];
    for (const r of this.resources.list<AgentBody>("agent")) {
      if (r.body) out.push({ manifest: r.manifest, origin: r.origin, definition: r.body.definition });
    }
    return out;
  }
}
