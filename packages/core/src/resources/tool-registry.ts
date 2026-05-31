import type { Tool } from "../tools/interface.js";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * Thin facade over {@link ResourceRegistry} that yields `Tool` instances. The
 * agent loop reads tools through this surface, so built-ins, custom shell
 * tools, and remote/agent-authored tools are all indistinguishable to the loop.
 *
 * Built-ins register through {@link ToolRegistry.registerBuiltin}, which
 * synthesizes a minimal manifest so they show up in `list()` like any other
 * resource.
 */
export class ToolRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  /** Access the underlying resource registry — escape hatch for advanced consumers. */
  asResources(): ResourceRegistry {
    return this.resources;
  }

  /** Register a built-in tool with a synthetic file:// origin and version 0.0.0. */
  registerBuiltin(tool: Tool, opts: { id?: string; version?: string } = {}): void {
    const id = normalizeBuiltinId(opts.id ?? tool.name);
    const version = opts.version ?? "0.0.0";
    const manifest: ResourceManifest = {
      kind: "tool",
      id,
      version,
      description: tool.description,
      hotReload: true,
    };
    const origin: ResourceOrigin = {
      scheme: "file",
      uri: `builtin:tool/${id}`,
      loadedAt: Date.now(),
    };
    this.resources.register({ manifest, origin, body: tool });
  }

  /** Register a resource-backed tool. The body must implement Tool. */
  register(resource: Resource<Tool>): void {
    if (resource.manifest.kind !== "tool") {
      throw new Error(`expected manifest.kind="tool", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  /** Remove a tool — by id (all versions) or pinned version. */
  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "tool", id, version });
  }

  /** Get a single tool by id (and optional pinned version). */
  get(id: string, version?: string): Tool | undefined {
    const res = this.resources.get<Tool>({ kind: "tool", id, version });
    return res?.body;
  }

  /** Look up by the tool's runtime `.name` rather than its resource id. */
  getByName(name: string): Tool | undefined {
    for (const res of this.resources.list<Tool>("tool")) {
      if (res.body?.name === name) return res.body;
    }
    return undefined;
  }

  /** List all active tool instances. Suitable as the agent loop's `tools` array. */
  list(): Tool[] {
    return this.resources
      .list<Tool>("tool")
      .map((r) => r.body)
      .filter((t): t is Tool => !!t);
  }

  /** List with manifests attached — useful for UI/inspection. */
  listWithManifests(): Array<{ tool: Tool; manifest: ResourceManifest; origin: ResourceOrigin }> {
    const out: Array<{ tool: Tool; manifest: ResourceManifest; origin: ResourceOrigin }> = [];
    for (const res of this.resources.list<Tool>("tool")) {
      if (res.body) out.push({ tool: res.body, manifest: res.manifest, origin: res.origin });
    }
    return out;
  }

  /** Run destroy() on all currently-registered tools (used during reload). */
  async destroyAll(): Promise<void> {
    for (const tool of this.list()) {
      try {
        await tool.destroy?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[resources] tool ${tool.name} destroy() failed`, err);
      }
    }
  }
}

function normalizeBuiltinId(name: string): string {
  // Tool names are already lowercase-safe in practice; this is a guardrail.
  return name.toLowerCase().replace(/[^a-z0-9._/-]/g, "-");
}
