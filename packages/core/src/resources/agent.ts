import type { AgentDefinition } from "../config.js";
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
 * Convert a manifest into an {@link AgentDefinition}. Validation is lenient:
 * unknown fields pass through, and string/number/boolean/array fields are
 * type-checked when present. Returning a partial object is intentional —
 * `resolveAgent` already supplies sensible defaults for every field.
 */
export function parseAgentData(manifest: ResourceManifest): AgentDefinition {
  const data = manifest.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`agent ${manifest.id}: manifest.data must be an object`);
  }
  const out: AgentDefinition = {};

  for (const key of [
    "description",
    "model",
    "provider",
    "instructions",
    "nudgeMessage",
    "contextDir",
    "taskPreamble",
  ] as const) {
    const v = (data as Record<string, unknown>)[key];
    if (v == null) continue;
    if (typeof v !== "string") {
      throw new Error(`agent ${manifest.id}: data.${key} must be a string`);
    }
    (out as Record<string, unknown>)[key] = v;
  }

  for (const key of ["temperature", "maxToolRounds", "nudgeOnText"] as const) {
    const v = (data as Record<string, unknown>)[key];
    if (v == null) continue;
    if (typeof v !== "number") {
      throw new Error(`agent ${manifest.id}: data.${key} must be a number`);
    }
    (out as Record<string, unknown>)[key] = v;
  }

  for (const key of ["skipGlobalContext", "summarizeOnTrim", "worktree"] as const) {
    const v = (data as Record<string, unknown>)[key];
    if (v == null) continue;
    if (typeof v !== "boolean") {
      throw new Error(`agent ${manifest.id}: data.${key} must be a boolean`);
    }
    (out as Record<string, unknown>)[key] = v;
  }

  for (const key of ["tools", "skills"] as const) {
    const v = (data as Record<string, unknown>)[key];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new Error(`agent ${manifest.id}: data.${key} must be an array of strings`);
    }
    (out as Record<string, unknown>)[key] = v;
  }

  if ((data as Record<string, unknown>).models != null) {
    const v = (data as Record<string, unknown>).models;
    if (!Array.isArray(v)) {
      throw new Error(`agent ${manifest.id}: data.models must be an array`);
    }
    out.models = v as AgentDefinition["models"];
  }

  if ((data as Record<string, unknown>).hooks != null) {
    const v = (data as Record<string, unknown>).hooks;
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`agent ${manifest.id}: data.hooks must be an object`);
    }
    out.hooks = v as AgentDefinition["hooks"];
  }

  if ((data as Record<string, unknown>).sandbox != null) {
    const v = (data as Record<string, unknown>).sandbox;
    if (v !== "host" && v !== "docker" && v !== "podman") {
      throw new Error(`agent ${manifest.id}: data.sandbox must be host|docker|podman`);
    }
    out.sandbox = v;
  }

  if ((data as Record<string, unknown>).skillLoading != null) {
    const v = (data as Record<string, unknown>).skillLoading;
    if (v !== "eager" && v !== "progressive") {
      throw new Error(`agent ${manifest.id}: data.skillLoading must be eager|progressive`);
    }
    out.skillLoading = v;
  }

  if ((data as Record<string, unknown>).systemPrompt != null) {
    const v = (data as Record<string, unknown>).systemPrompt;
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`agent ${manifest.id}: data.systemPrompt must be an object`);
    }
    // Trust the AgentDefinition shape — SystemPromptOverride is a thin
    // structural type that composeSystemPrompt validates at use time.
    out.systemPrompt = v as AgentDefinition["systemPrompt"];
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
