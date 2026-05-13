import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * Prompts as a resource kind. The body is plain text — typically the contents
 * of a `.md` file in the resource root. Prompt registry entries are addressable
 * from {@link expandPrompt} via `{{include:resource://prompt:<id>}}` (wired in
 * S8.5).
 */
export interface PromptBody {
  text: string;
}

export class PromptRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  asResources(): ResourceRegistry {
    return this.resources;
  }

  registerBuiltin(input: { id: string; text: string; description?: string; version?: string }): void {
    const manifest: ResourceManifest = {
      kind: "prompt",
      id: input.id,
      version: input.version ?? "0.0.0",
      description: input.description,
    };
    const origin: ResourceOrigin = {
      scheme: "file",
      uri: `builtin:prompt/${input.id}`,
      loadedAt: Date.now(),
    };
    this.resources.register({ manifest, origin, body: { text: input.text } });
  }

  /** Convenience: read a prompt from a file path and register it. */
  registerFromFile(input: { id: string; path: string; description?: string; version?: string }): void {
    const text = readFileSync(resolve(input.path), "utf8");
    this.registerBuiltin({ ...input, text });
  }

  register(resource: Resource<PromptBody>): void {
    if (resource.manifest.kind !== "prompt") {
      throw new Error(`expected manifest.kind="prompt", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "prompt", id, version });
  }

  /** Get the prompt text by id. */
  get(id: string, version?: string): string | undefined {
    return this.resources.get<PromptBody>({ kind: "prompt", id, version })?.body?.text;
  }

  list(): Array<{ id: string; text: string }> {
    return this.resources
      .list<PromptBody>("prompt")
      .map((r) => r.body && { id: r.manifest.id, text: r.body.text })
      .filter((x): x is { id: string; text: string } => !!x);
  }
}
