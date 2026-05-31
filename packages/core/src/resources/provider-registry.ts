import type { AIProvider } from "../providers/interface.js";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * Providers exposed as a resource kind. Each registered entry pairs an
 * {@link AIProvider} instance with the model name the runtime should use by
 * default. Multiple providers can be registered simultaneously; the runtime
 * picks one by `id` (matching `agent.defaultProvider`).
 */
export interface RegisteredProvider {
  provider: AIProvider;
  defaultModel: string;
}

export class ProviderRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  asResources(): ResourceRegistry {
    return this.resources;
  }

  /** Register a built-in (or composed-in-process) provider. */
  registerBuiltin(input: { id: string; provider: AIProvider; defaultModel: string; version?: string }): void {
    const manifest: ResourceManifest = {
      kind: "provider",
      id: input.id,
      version: input.version ?? "0.0.0",
      description: input.provider.name,
      hotReload: true,
    };
    const origin: ResourceOrigin = {
      scheme: "file",
      uri: `builtin:provider/${input.id}`,
      loadedAt: Date.now(),
    };
    this.resources.register({
      manifest,
      origin,
      body: { provider: input.provider, defaultModel: input.defaultModel },
    });
  }

  register(resource: Resource<RegisteredProvider>): void {
    if (resource.manifest.kind !== "provider") {
      throw new Error(`expected manifest.kind="provider", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "provider", id, version });
  }

  get(id: string, version?: string): RegisteredProvider | undefined {
    return this.resources.get<RegisteredProvider>({ kind: "provider", id, version })?.body;
  }

  list(): Array<RegisteredProvider & { id: string }> {
    return this.resources
      .list<RegisteredProvider>("provider")
      .map((res) => res.body && { ...res.body, id: res.manifest.id })
      .filter((x): x is RegisteredProvider & { id: string } => !!x);
  }

  listWithManifests(): Array<{ entry: RegisteredProvider; manifest: ResourceManifest; origin: ResourceOrigin }> {
    const out: Array<{ entry: RegisteredProvider; manifest: ResourceManifest; origin: ResourceOrigin }> = [];
    for (const res of this.resources.list<RegisteredProvider>("provider")) {
      if (res.body) out.push({ entry: res.body, manifest: res.manifest, origin: res.origin });
    }
    return out;
  }
}
