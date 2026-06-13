/**
 * Unified Resource model — every extension point (tools, providers, agents,
 * skills, knowledge bases, prompts, workflows, step executors, channels,
 * sandboxes, triggers, task backends) loads through this surface so "local
 * file", "remote URL", and "agent-authored at runtime" are the same code path.
 */

export type ResourceKind =
  | "tool"
  | "provider"
  | "agent"
  | "skill"
  | "kb"
  | "prompt"
  | "workflow"
  | "step_executor"
  | "trigger"
  | "channel"
  | "sandbox"
  | "task_backend"
  | "bundle";

/** Top-level source URI scheme — what {@link ResourceLoader} dispatches on. */
export type ResourceSourceScheme = "file" | "https" | "git" | "npm" | "agent" | "tai-registry" | "mcp";

export interface ResourcePermissions {
  /** Domains the resource may reach over the network. `["*"]` for any. */
  network?: string[];
  /** Absolute or workspace-relative paths the resource may read/write. */
  filesystem?: string[];
  /** Tool ids the resource may invoke (when itself a tool/step that delegates). */
  tools?: string[];
  /** Env vars the resource may read. */
  env?: string[];
}

export interface ResourceDependency {
  /** "tai-core" or a fully-qualified resource id like "my-org/foo". */
  ref: string;
  /** Semver-ish range. Loose validation only — we don't run a full semver here. */
  range?: string;
  /** Optional kind hint for kind-prefixed ids (e.g. tool:my-org/foo). */
  kind?: ResourceKind;
}

export interface ResourceTrust {
  /** ed25519:<hex> signature over the manifest body (excluding the trust block). */
  signedBy?: string;
  /** Free-form publisher hint, only meaningful when signedBy is present. */
  publisher?: string;
}

export interface ResourceManifest {
  kind: ResourceKind;
  /** "org/name" — slash-delimited, lowercase, no spaces. */
  id: string;
  /** Loose semver string (e.g. "1.2.0"). Defaults to "0.0.0" when omitted. */
  version: string;
  /** Path relative to the resource root, or a builtin "id" for built-ins. */
  entrypoint?: string;
  description?: string;
  permissions?: ResourcePermissions;
  dependencies?: ResourceDependency[];
  trust?: ResourceTrust;
  /** Whether `runtime.reload()` can swap this resource without process restart. */
  hotReload?: boolean;
  /** Free-form additional manifest data; kind-specific executors interpret it. */
  data?: Record<string, unknown>;
}

/** Where a resource came from — used for trust decisions and provenance logging. */
export interface ResourceOrigin {
  scheme: ResourceSourceScheme;
  /** Original URI the user/CLI/agent supplied. */
  uri: string;
  /** Absolute path on disk for file-backed resources (after fetch/extract). */
  localPath?: string;
  /** When the resource was loaded (epoch ms). */
  loadedAt: number;
  /** ID of the session that authored an agent:// resource. */
  authoringSessionId?: string;
  /**
   * When this resource was activated as part of a bundle (S11.3), the parent
   * bundle's id. Used by the cascading-uninstall logic to find every member
   * to unregister when the bundle is removed.
   */
  bundleId?: string;
}

/**
 * A loaded, registry-ready resource. Body is left intentionally opaque so
 * each kind can attach its own native object (compiled Tool instance, YAML
 * blob, raw prompt text, etc.). Adapters bridge body shapes to consumers.
 */
export interface Resource<TBody = unknown> {
  manifest: ResourceManifest;
  origin: ResourceOrigin;
  /**
   * Kind-specific payload. For built-ins this is usually a constructed
   * instance (Tool, Workflow, etc.). For remote resources it's whatever the
   * source loader produced after fetch + entrypoint resolution.
   */
  body: TBody;
}

/** Stable composite key for `(kind, id, version)` lookups. */
export interface ResourceRef {
  kind: ResourceKind;
  id: string;
  version?: string;
}

export type ResourceEventType = "registered" | "unregistered" | "replaced";

export interface ResourceEvent {
  type: ResourceEventType;
  kind: ResourceKind;
  id: string;
  version: string;
  origin: ResourceOrigin;
}

export type ResourceListener = (event: ResourceEvent) => void;

export interface ResourceSource {
  scheme: ResourceSourceScheme;
  /**
   * Given a URI matching this source's scheme, fetch the resource onto disk
   * (or compose it in memory for agent://) and return the absolute root path
   * + a parsed manifest. The loader handles entrypoint resolution.
   */
  fetch(uri: string, opts: FetchOptions): Promise<FetchResult>;
}

export interface FetchOptions {
  /** Where the loader caches fetched resources. */
  cacheDir: string;
  /** Signal so HTTP/git operations can be cancelled. */
  signal?: AbortSignal;
}

export interface FetchResult {
  /** Absolute path to the resource root (directory or single file). */
  rootPath: string;
  /** Parsed + validated manifest. */
  manifest: ResourceManifest;
  /** Useful for logging — the resolved/canonical URI (post-redirect, etc.). */
  resolvedUri?: string;
}
