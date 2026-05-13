import { resolve } from "node:path";
import { homedir } from "node:os";
import type {
  FetchOptions,
  Resource,
  ResourceManifest,
  ResourceOrigin,
  ResourceSource,
  ResourceSourceScheme,
} from "./interface.js";
import { FileResourceSource } from "./sources/file.js";
import { AgentResourceSource } from "./sources/agent.js";
import { RegistryDispatchError } from "./sources/registry-index.js";
import { discoverBundleMembers, parseBundleData } from "./bundle.js";

export interface ResourceLoaderOptions {
  /** Override the default `~/.tailored-ai/cache/resources` directory. */
  cacheDir?: string;
  /** Pre-registered sources (defaults to file:// + agent://). */
  sources?: ResourceSource[];
  /**
   * Per-kind body resolvers. Given the raw manifest + root path, produce the
   * `body` field of the loaded Resource — e.g. compile a Tool instance, read
   * a workflow YAML, etc. When unspecified for a kind the body is `null`.
   */
  resolvers?: Partial<Record<ResourceManifest["kind"], BodyResolver>>;
}

export type BodyResolver = (input: {
  manifest: ResourceManifest;
  rootPath: string;
  origin: ResourceOrigin;
}) => Promise<unknown> | unknown;

/**
 * Top-level loader: dispatches a URI to its source, runs the kind's body
 * resolver, and returns a fully-formed Resource ready for the registry.
 */
export class ResourceLoader {
  private sources = new Map<ResourceSourceScheme, ResourceSource>();
  private resolvers: Map<ResourceManifest["kind"], BodyResolver>;
  private cacheDir: string;

  constructor(opts: ResourceLoaderOptions = {}) {
    this.cacheDir = opts.cacheDir ?? resolve(homedir(), ".tailored-ai/cache/resources");
    const sources = opts.sources ?? [new FileResourceSource(), new AgentResourceSource()];
    for (const s of sources) this.sources.set(s.scheme, s);
    this.resolvers = new Map(Object.entries(opts.resolvers ?? {}) as [ResourceManifest["kind"], BodyResolver][]);
    // Built-in: bundles auto-discover their members from the bundle root.
    // Consumers can override with `opts.resolvers.bundle` if needed.
    if (!this.resolvers.has("bundle")) {
      this.resolvers.set("bundle", defaultBundleResolver);
    }
  }

  /** Register an additional source (e.g. HttpSource lands in S8.1b). */
  addSource(source: ResourceSource): void {
    this.sources.set(source.scheme, source);
  }

  /** Register or replace the body resolver for a given kind. */
  setResolver(kind: ResourceManifest["kind"], resolver: BodyResolver): void {
    this.resolvers.set(kind, resolver);
  }

  /** Look up a source by scheme; useful for source-specific operations (e.g. agent.publish). */
  getSource<T extends ResourceSource = ResourceSource>(scheme: ResourceSourceScheme): T | undefined {
    return this.sources.get(scheme) as T | undefined;
  }

  async load(uri: string, opts: { signal?: AbortSignal } = {}): Promise<Resource> {
    const scheme = parseScheme(uri);
    const source = this.sources.get(scheme);
    if (!source) {
      throw new Error(`no resource source registered for scheme "${scheme}" (uri: ${uri})`);
    }
    const fetchOpts: FetchOptions = { cacheDir: this.cacheDir, signal: opts.signal };
    let fetched;
    try {
      fetched = await source.fetch(uri, fetchOpts);
    } catch (err) {
      // tai-registry source signals re-dispatch by throwing this sentinel.
      // Loop the loader on the resolved concrete URI (typically https://).
      if (err instanceof RegistryDispatchError) {
        return this.load(err.resolvedUri, opts);
      }
      throw err;
    }
    const origin: ResourceOrigin = {
      scheme,
      uri,
      localPath: fetched.rootPath,
      loadedAt: Date.now(),
      authoringSessionId: scheme === "agent" ? extractSessionId(uri) : undefined,
    };
    const resolver = this.resolvers.get(fetched.manifest.kind);
    const body = resolver
      ? await resolver({ manifest: fetched.manifest, rootPath: fetched.rootPath, origin })
      : null;
    return {
      manifest: fetched.manifest,
      origin,
      body,
    };
  }
}

function parseScheme(uri: string): ResourceSourceScheme {
  // `git+https://...` / `git+ssh://...` — strip the transport prefix; both route to the git source.
  if (uri.startsWith("git+")) return "git";

  // Authority-prefixed: scheme://...
  const slashIdx = uri.indexOf("://");
  if (slashIdx !== -1) {
    const scheme = uri.slice(0, slashIdx);
    if (
      scheme === "file" ||
      scheme === "https" ||
      scheme === "http" ||
      scheme === "git" ||
      scheme === "agent" ||
      scheme === "tai-registry"
    ) {
      // Treat http like https — same source.
      return (scheme === "http" ? "https" : scheme) as ResourceSourceScheme;
    }
    throw new Error(`unsupported resource URI scheme: ${scheme}`);
  }

  // Opaque schemes: `npm:foo@1`, `tai-registry:my-org/foo`, etc.
  const colonIdx = uri.indexOf(":");
  if (colonIdx > 0) {
    const scheme = uri.slice(0, colonIdx);
    if (scheme === "npm" || scheme === "tai-registry") {
      return scheme;
    }
  }

  // Bare paths default to file://.
  return "file";
}

function extractSessionId(uri: string): string | undefined {
  // agent://<sessionId>/<rest>
  const m = /^agent:\/\/([^/]+)/.exec(uri);
  return m?.[1];
}

const defaultBundleResolver: BodyResolver = ({ manifest, rootPath }) => {
  const options = parseBundleData(manifest);
  const members = discoverBundleMembers(rootPath, options);
  return {
    manifest,
    rootPath,
    members,
    author: typeof manifest.data?.author === "string" ? manifest.data.author : undefined,
  };
};
