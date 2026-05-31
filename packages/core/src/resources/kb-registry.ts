import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * Knowledge-base resource. Each entry corresponds to a directory of markdown
 * / text files that the memory tool can search via `scope: "knowledge"`.
 *
 * Built-in registration walks the on-disk `data/kb/` tree and creates one
 * resource per top-level subdirectory. Remote KBs install as ordinary
 * `kind: kb` resources whose body points at the on-disk root.
 */
export interface KbResource {
  /** Absolute path to the KB root directory. */
  rootPath: string;
  /** Free-text description from manifest, or auto-derived from a README. */
  description?: string;
}

export class KbRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  asResources(): ResourceRegistry {
    return this.resources;
  }

  registerBuiltin(input: { id: string; rootPath: string; description?: string; version?: string }): void {
    const manifest: ResourceManifest = {
      kind: "kb",
      id: input.id,
      version: input.version ?? "0.0.0",
      description: input.description,
      data: { rootPath: input.rootPath },
    };
    const origin: ResourceOrigin = {
      scheme: "file",
      uri: `builtin:kb/${input.id}`,
      loadedAt: Date.now(),
    };
    this.resources.register({
      manifest,
      origin,
      body: { rootPath: input.rootPath, description: input.description },
    });
  }

  register(resource: Resource<KbResource>): void {
    if (resource.manifest.kind !== "kb") {
      throw new Error(`expected manifest.kind="kb", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "kb", id, version });
  }

  get(id: string, version?: string): KbResource | undefined {
    return this.resources.get<KbResource>({ kind: "kb", id, version })?.body;
  }

  list(): Array<KbResource & { id: string }> {
    return this.resources
      .list<KbResource>("kb")
      .map((r) => r.body && { ...r.body, id: r.manifest.id })
      .filter((x): x is KbResource & { id: string } => !!x);
  }
}

/**
 * Walks `kbDir` (typically `data/kb/`) and registers one built-in resource per
 * top-level directory. The global root itself registers as `kb/global` so the
 * memory tool's `action: "search"` lookups can address it by id.
 */
export function populateBuiltinKbs(registry: KbRegistry, kbDir: string): void {
  if (!existsSync(kbDir)) return;
  registry.registerBuiltin({
    id: "kb/global",
    rootPath: resolve(kbDir),
    description: "Global knowledge base (data/kb/)",
  });
  for (const entry of readdirSync(kbDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = resolve(kbDir, entry.name);
    // Ignore hidden / underscore-prefixed dirs (e.g. ".git", "_archive").
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    registry.registerBuiltin({
      id: `kb/${entry.name}`,
      rootPath: dirPath,
      description: tryDescriptionFromDir(dirPath) ?? `Knowledge base: ${entry.name}`,
    });
  }
}

function tryDescriptionFromDir(dir: string): string | undefined {
  for (const candidate of ["README.md", "readme.md", "INDEX.md"]) {
    const p = resolve(dir, candidate);
    try {
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      const text = readFileSync(p, "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim().replace(/^#+\s*/, "");
        if (t.length > 0) return t.slice(0, 200);
      }
    } catch {
      // best-effort metadata; ignore failures
    }
  }
  return undefined;
}
