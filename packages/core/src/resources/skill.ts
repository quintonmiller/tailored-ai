import type { AgentHook } from "../config.js";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * A Skill is a shareable bundle of capability: extra instructions + tool
 * references + hook automations + knowledge / workflow handles. Agents
 * declare `skills: [<id>]` and at resolve time the bundles are merged into
 * the agent's tool set, instructions, and hooks.
 *
 * Encoded entirely in the manifest's `data` block — no separate file, no
 * entrypoint required. Future versions may add a `skill.yaml` for richer
 * structure (sub-resources, conditional inclusion, etc.).
 */
export interface SkillDefinition {
  /** Extra system-prompt text. Concatenated after any agent-level instructions. */
  instructions?: string;
  /**
   * Tool names (matched against `Tool.name`) the skill needs. The agent's
   * effective tool set is the union of (agent.tools | skill.toolRefs).
   */
  toolRefs?: string[];
  /** Knowledge base resource ids. Surfaced via {@link ResolvedSkillBundle}. */
  knowledgeRefs?: string[];
  /** Workflow resource ids. Surfaced via {@link ResolvedSkillBundle}. */
  workflowRefs?: string[];
  /** Named prompt fragments — `id => prompt resource id`. Available via expand. */
  promptRefs?: Record<string, string>;
  /** Hooks contributed by the skill. Appended after the agent's own hooks. */
  hooks?: {
    beforeRun?: AgentHook | AgentHook[];
    afterRun?: AgentHook | AgentHook[];
  };
}

/**
 * Body shape stored in the registry under `kind: "skill"`. Keeping the
 * definition + manifest pair together makes the body self-describing.
 */
export interface SkillBody {
  manifest: ResourceManifest;
  definition: SkillDefinition;
}

/**
 * Resolves a manifest's `data` block into a {@link SkillDefinition}. The
 * loader's body resolver wraps this so registered skill resources have a
 * structured body rather than untyped `Record<string, unknown>`.
 */
export function parseSkillData(manifest: ResourceManifest): SkillDefinition {
  const data = manifest.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`skill ${manifest.id}: manifest.data must be an object`);
  }
  const out: SkillDefinition = {};

  if (data.instructions != null) {
    if (typeof data.instructions !== "string") {
      throw new Error(`skill ${manifest.id}: data.instructions must be a string`);
    }
    out.instructions = data.instructions;
  }

  if (data.toolRefs != null) {
    if (!Array.isArray(data.toolRefs) || data.toolRefs.some((x) => typeof x !== "string")) {
      throw new Error(`skill ${manifest.id}: data.toolRefs must be a string array`);
    }
    out.toolRefs = data.toolRefs as string[];
  }

  for (const key of ["knowledgeRefs", "workflowRefs"] as const) {
    const v = (data as Record<string, unknown>)[key];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new Error(`skill ${manifest.id}: data.${key} must be a string array`);
    }
    out[key] = v as string[];
  }

  if (data.promptRefs != null) {
    if (typeof data.promptRefs !== "object" || Array.isArray(data.promptRefs)) {
      throw new Error(`skill ${manifest.id}: data.promptRefs must be an object`);
    }
    const o = data.promptRefs as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v !== "string") {
        throw new Error(`skill ${manifest.id}: data.promptRefs.${k} must be a string`);
      }
    }
    out.promptRefs = o as Record<string, string>;
  }

  if (data.hooks != null) {
    if (typeof data.hooks !== "object" || Array.isArray(data.hooks)) {
      throw new Error(`skill ${manifest.id}: data.hooks must be an object`);
    }
    out.hooks = data.hooks as SkillDefinition["hooks"];
  }

  return out;
}

/**
 * Thin facade for skill lookups. Skills live as ordinary resources in the
 * underlying registry; this wrapper just types the body shape.
 */
export class SkillRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  asResources(): ResourceRegistry {
    return this.resources;
  }

  registerBuiltin(input: { id: string; definition: SkillDefinition; description?: string; version?: string }): void {
    const manifest: ResourceManifest = {
      kind: "skill",
      id: input.id,
      version: input.version ?? "0.0.0",
      description: input.description,
      data: input.definition as Record<string, unknown>,
    };
    const origin: ResourceOrigin = {
      scheme: "file",
      uri: `builtin:skill/${input.id}`,
      loadedAt: Date.now(),
    };
    this.resources.register({ manifest, origin, body: { manifest, definition: input.definition } });
  }

  register(resource: Resource<SkillBody>): void {
    if (resource.manifest.kind !== "skill") {
      throw new Error(`expected manifest.kind="skill", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "skill", id, version });
  }

  get(id: string, version?: string): SkillDefinition | undefined {
    return this.resources.get<SkillBody>({ kind: "skill", id, version })?.body?.definition;
  }

  list(): SkillDefinition[] {
    return this.resources
      .list<SkillBody>("skill")
      .map((r) => r.body?.definition)
      .filter((d): d is SkillDefinition => !!d);
  }

  listWithManifests(): Array<{ manifest: ResourceManifest; origin: ResourceOrigin; definition: SkillDefinition }> {
    const out: Array<{ manifest: ResourceManifest; origin: ResourceOrigin; definition: SkillDefinition }> = [];
    for (const r of this.resources.list<SkillBody>("skill")) {
      if (r.body) out.push({ manifest: r.manifest, origin: r.origin, definition: r.body.definition });
    }
    return out;
  }
}
