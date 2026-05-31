import type { FetchOptions, FetchResult, ResourceManifest, ResourceSource } from "../interface.js";
import { manifestKey, validateManifest } from "../manifest.js";

/**
 * Resources authored at runtime by an agent. The agent posts a payload via
 * {@link AgentResourceSource.publish}; subsequent `fetch("agent://...")` calls
 * return the cached entry without touching disk.
 *
 * URI shape: `agent://<sessionId>/<kind>/<id>@<version>`.
 *
 * These resources are intentionally ephemeral — they live only for the
 * runtime's lifetime unless explicitly promoted to disk via
 * `tai resources promote` (S8.6).
 */
export class AgentResourceSource implements ResourceSource {
  readonly scheme = "agent" as const;

  private cache = new Map<string, { manifest: ResourceManifest; rootPath: string; sessionId: string }>();

  publish(input: {
    sessionId: string;
    manifest: ResourceManifest;
    /** Virtual root path used for any subsequent file lookups (e.g. /tmp/agent-foo). */
    rootPath: string;
  }): string {
    const m = validateManifest(input.manifest, `agent://${input.sessionId}/${input.manifest.id}`);
    const uri = buildUri(input.sessionId, m);
    this.cache.set(uri, { manifest: m, rootPath: input.rootPath, sessionId: input.sessionId });
    return uri;
  }

  /** Remove a previously-published agent resource. Returns true if it existed. */
  revoke(uri: string): boolean {
    return this.cache.delete(uri);
  }

  async fetch(uri: string, _opts: FetchOptions): Promise<FetchResult> {
    const entry = this.cache.get(uri);
    if (!entry) {
      throw new Error(`agent resource not found: ${uri}`);
    }
    return {
      rootPath: entry.rootPath,
      manifest: entry.manifest,
      resolvedUri: uri,
    };
  }

  /** Inspect what's currently in the cache (debug / introspection). */
  list(): Array<{ uri: string; sessionId: string; manifest: ResourceManifest }> {
    return Array.from(this.cache.entries()).map(([uri, e]) => ({
      uri,
      sessionId: e.sessionId,
      manifest: e.manifest,
    }));
  }
}

function buildUri(sessionId: string, m: ResourceManifest): string {
  return `agent://${sessionId}/${manifestKey(m.kind, m.id, m.version)}`;
}
