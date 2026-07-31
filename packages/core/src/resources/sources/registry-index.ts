import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { taiHomePath } from "../../home.js";
import type { FetchOptions, FetchResult, ResourceKind, ResourceSource } from "../interface.js";

export interface RegistryIndexEntry {
  kind: ResourceKind;
  id: string;
  /** Latest version. Older versions can be listed under `versions[]`. */
  version: string;
  versions?: string[];
  description?: string;
  /** Concrete URI to install from (typically https:// to a tarball). */
  source: string;
  /** Optional fields surfaced in `tai search` output. */
  publisher?: string;
  tags?: string[];
}

export interface RegistryIndexShape {
  version: 1;
  updatedAt?: string;
  entries: RegistryIndexEntry[];
}

export interface TaiRegistrySourceOptions {
  /**
   * Resolves an index name (e.g. "default") to a path or URL. The default
   * resolver reads from `~/.tailored-ai/registries/<name>.json` if present,
   * else returns `null` (search disabled).
   */
  indexResolver?: (name: string) => string | null;
  /** Override fetch for HTTP-hosted indexes. */
  fetchImpl?: typeof fetch;
  /** Inject an in-memory index (test convenience). */
  staticIndex?: RegistryIndexShape;
}

/**
 * Resolves URIs of the form `tai-registry:<id>` (latest) or
 * `tai-registry:<id>@<version>` by consulting a static registry index. The
 * index lists every published resource and its install URI; the source
 * delegates to whichever scheme the entry's `source` field uses (typically
 * https://). This keeps the index itself static and cacheable.
 *
 * Self-hosted registries are the same shape — point `indexResolver` at the
 * URL/path of an internal index file.
 */
export class TaiRegistrySource implements ResourceSource {
  readonly scheme = "tai-registry" as const;
  private cachedIndex: RegistryIndexShape | null = null;
  private indexResolver: (name: string) => string | null;
  private fetchImpl: typeof fetch;
  private staticIndex?: RegistryIndexShape;

  constructor(opts: TaiRegistrySourceOptions = {}) {
    this.indexResolver = opts.indexResolver ?? defaultIndexResolver;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.staticIndex = opts.staticIndex;
  }

  async fetch(uri: string, opts: FetchOptions): Promise<FetchResult> {
    if (!uri.startsWith("tai-registry:")) {
      throw new Error(`TaiRegistrySource expects tai-registry: URI, got: ${uri}`);
    }
    const spec = uri.slice("tai-registry:".length);
    if (!spec) throw new Error(`empty tai-registry spec: ${uri}`);

    // Format: `<indexName>/<id>[@<version>]` or `<id>[@<version>]` for default index.
    const indexName = "default";
    const rest = spec;
    if (spec.includes("/") && !spec.startsWith("@")) {
      // `<indexName>/<id>` — first segment is the index when followed by another `/`
      const slash = spec.indexOf("/");
      // Heuristic: if the prefix looks like a known index name (alphanumeric), use it.
      // For now we always treat single-slash specs as `<org>/<name>` against default.
      // Reserve `<indexName>:<id>` syntax for future bi-slash form.
      void slash;
    }
    const at = rest.indexOf("@");
    const id = at === -1 ? rest : rest.slice(0, at);
    const version = at === -1 ? undefined : rest.slice(at + 1);

    const index = await this.loadIndex(indexName);
    if (!index) {
      throw new Error(`no registry index resolved for "${indexName}"`);
    }
    const entry = index.entries.find((e) => e.id === id && (!version || e.version === version));
    if (!entry) {
      throw new Error(`registry "${indexName}" has no entry for ${id}${version ? `@${version}` : ""}`);
    }

    // Delegate to whatever scheme the entry's `source` field uses by re-throwing.
    // Loaders should detect tai-registry and dispatch to the entry.source URI
    // via the same loader.load() — to keep this source self-contained, we
    // return a synthetic FetchResult whose rootPath is the resolved URI; the
    // caller (loader.load) then needs a follow-up dispatch. Implementations
    // typically wrap fetch via {@link resolveRegistryUri} below instead of
    // calling fetch() directly.
    throw new RegistryDispatchError(entry.source, entry, opts);
  }

  /** Programmatic lookup — returns the resolved entry without throwing. */
  async resolve(uri: string): Promise<RegistryIndexEntry | undefined> {
    if (!uri.startsWith("tai-registry:")) return undefined;
    const spec = uri.slice("tai-registry:".length);
    const at = spec.indexOf("@");
    const id = at === -1 ? spec : spec.slice(0, at);
    const version = at === -1 ? undefined : spec.slice(at + 1);
    const index = await this.loadIndex("default");
    if (!index) return undefined;
    return index.entries.find((e) => e.id === id && (!version || e.version === version));
  }

  async search(query: string): Promise<RegistryIndexEntry[]> {
    const index = await this.loadIndex("default");
    if (!index) return [];
    const q = query.toLowerCase();
    return index.entries.filter((e) => {
      if (e.id.toLowerCase().includes(q)) return true;
      if (e.description?.toLowerCase().includes(q)) return true;
      if (e.tags?.some((t) => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  private async loadIndex(name: string): Promise<RegistryIndexShape | null> {
    if (this.staticIndex) return this.staticIndex;
    if (this.cachedIndex) return this.cachedIndex;
    const resolved = this.indexResolver(name);
    if (!resolved) return null;
    let text: string;
    if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
      const res = await this.fetchImpl(resolved);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching index ${resolved}`);
      text = await res.text();
    } else if (resolved.startsWith("file://")) {
      text = readFileSync(fileURLToPath(resolved), "utf8");
    } else {
      text = readFileSync(resolved, "utf8");
    }
    try {
      const raw = JSON.parse(text) as Partial<RegistryIndexShape>;
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      this.cachedIndex = { version: 1, entries, updatedAt: raw.updatedAt };
      return this.cachedIndex;
    } catch (err) {
      throw new Error(`registry index ${resolved} is malformed: ${(err as Error).message}`);
    }
  }
}

/**
 * Sentinel thrown by {@link TaiRegistrySource.fetch} so a higher-level loader
 * can re-dispatch to the resolved entry's URI. Keeping this out-of-band lets
 * the source stay protocol-agnostic — it doesn't need to know how to fetch
 * tarballs / clone git / extract npm packages itself.
 */
export class RegistryDispatchError extends Error {
  constructor(
    readonly resolvedUri: string,
    readonly entry: RegistryIndexEntry,
    readonly fetchOptions: FetchOptions,
  ) {
    super(`__dispatch:${resolvedUri}`);
    this.name = "RegistryDispatchError";
  }
}

function defaultIndexResolver(name: string): string | null {
  const candidates = [process.env.TAI_REGISTRY_INDEX, taiHomePath("registries", `${name}.json`)].filter(
    Boolean,
  ) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
