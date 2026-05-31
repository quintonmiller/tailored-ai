import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Resource, ResourceKind, ResourceManifest, ResourceOrigin } from "./interface.js";
import { validateManifest } from "./manifest.js";
import { ResourceRegistry } from "./registry.js";
import { isSkillMdPath, parseSkillMd } from "./skill-md.js";

/**
 * S11.3 — Bundle resource kind.
 *
 * A bundle is a curated, versioned collection of resources from a single
 * author. After install, a bundle's members are *discoverable* but NOT
 * auto-registered — the user opts each member in (or hits "install all" on
 * first install). Bundles register in the generic ResourceRegistry like any
 * other kind; the body carries the discovered member catalog.
 */

/** One member found inside a bundle, before it's been activated. */
export interface BundleMember {
  /** Resource kind this member exposes. */
  kind: ResourceKind;
  /** Stable id (e.g. "acme/pdf-processor"). Derived from the member's manifest or filename. */
  id: string;
  /** Semver-like version. Defaults to "0.0.0" when not declared. */
  version: string;
  /** Absolute path on disk — either a directory or a single file. */
  sourcePath: string;
  /** Pre-loaded manifest when one exists. SKILL.md/workflow.yaml/KB members may have none. */
  manifest?: ResourceManifest;
  /** Optional description surfaced in browse UIs. */
  description?: string;
}

export interface BundleOptions {
  /** Map of kind → override. */
  members?: Record<
    ResourceKind,
    | false
    | {
        path?: string;
        include?: string[];
        exclude?: string[];
        items?: Array<{ path: string; as?: { id?: string; version?: string } }>;
      }
  >;
}

export interface BundleBody {
  manifest: ResourceManifest;
  rootPath: string;
  members: BundleMember[];
  author?: string;
}

/**
 * Map of kind → default discovery layout. `false` means "no auto-discovery
 * for this kind" (rare — most kinds map to a conventional subdir). When a
 * kind isn't listed below, auto-discovery is disabled for it.
 */
const DEFAULT_LAYOUT: Partial<
  Record<ResourceKind, { dir: string; pattern: "file-manifest" | "skill-md" | "bare-yaml" | "bare-dir" | "bare-md" }>
> = {
  skill: { dir: "skills", pattern: "skill-md" },
  agent: { dir: "agents", pattern: "file-manifest" },
  tool: { dir: "tools", pattern: "file-manifest" },
  provider: { dir: "providers", pattern: "file-manifest" },
  prompt: { dir: "prompts", pattern: "bare-md" },
  kb: { dir: "kb", pattern: "bare-dir" },
  workflow: { dir: "workflows", pattern: "bare-yaml" },
  step_executor: { dir: "step-executors", pattern: "file-manifest" },
  trigger: { dir: "triggers", pattern: "file-manifest" },
  channel: { dir: "channels", pattern: "file-manifest" },
  sandbox: { dir: "sandboxes", pattern: "file-manifest" },
  task_backend: { dir: "task-backends", pattern: "file-manifest" },
};

/** Parse a bundle manifest's data block into typed BundleOptions. */
export function parseBundleData(manifest: ResourceManifest): BundleOptions {
  const data = manifest.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`bundle ${manifest.id}: manifest.data must be an object`);
  }
  const out: BundleOptions = {};
  if ((data as Record<string, unknown>).members != null) {
    const v = (data as Record<string, unknown>).members;
    if (typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`bundle ${manifest.id}: data.members must be an object`);
    }
    out.members = v as BundleOptions["members"];
  }
  return out;
}

/**
 * Walk a bundle's root directory and discover its members per the
 * convention layout, applying any overrides from `manifest.data.members`.
 */
export function discoverBundleMembers(rootPath: string, options: BundleOptions): BundleMember[] {
  const members: BundleMember[] = [];
  const overrides = (options.members ?? {}) as Record<
    string,
    BundleOptions["members"] extends infer T ? (T extends Record<string, infer V> ? V : never) : never
  >;

  for (const [kindStr, layout] of Object.entries(DEFAULT_LAYOUT)) {
    const kind = kindStr as ResourceKind;
    const override = overrides[kindStr];

    if (override === false) continue; // user opted out

    const dirName = (override && typeof override === "object" && override.path) || layout!.dir;
    const kindDir = resolvePath(rootPath, dirName);

    // Explicit `items:` lists bypass auto-discovery entirely.
    if (override && typeof override === "object" && Array.isArray(override.items)) {
      for (const item of override.items) {
        const itemPath = resolvePath(rootPath, item.path);
        if (!existsSync(itemPath)) {
          console.warn(`[bundle] explicit member ${kind}:${item.path} does not exist`);
          continue;
        }
        const member = loadMemberFromPath(kind, itemPath, layout!.pattern);
        if (!member) continue;
        if (item.as?.id) member.id = item.as.id;
        if (item.as?.version) member.version = item.as.version;
        members.push(member);
      }
      continue;
    }

    if (!existsSync(kindDir) || !statSync(kindDir).isDirectory()) continue;

    const include = (override && typeof override === "object" && override.include) || undefined;
    const exclude = (override && typeof override === "object" && override.exclude) || undefined;

    for (const entry of readdirSync(kindDir, { withFileTypes: true })) {
      const entryPath = join(kindDir, entry.name);

      // Glob filters work on the path relative to bundle root.
      const rel = relative(rootPath, entryPath);
      if (include && !include.some((g: string) => matchGlob(g, rel))) continue;
      if (exclude?.some((g: string) => matchGlob(g, rel))) continue;

      const member = loadMemberFromPath(kind, entryPath, layout!.pattern);
      if (member) members.push(member);
    }
  }

  return members;
}

function loadMemberFromPath(
  kind: ResourceKind,
  entryPath: string,
  pattern: "file-manifest" | "skill-md" | "bare-yaml" | "bare-dir" | "bare-md",
): BundleMember | null {
  try {
    const stat = statSync(entryPath);
    switch (pattern) {
      case "file-manifest": {
        // Member is either a directory containing manifest.yaml, or a bare .yaml file.
        const manifestPath = stat.isDirectory() ? join(entryPath, "manifest.yaml") : entryPath;
        if (!existsSync(manifestPath)) return null;
        const raw = parseYaml(readFileSync(manifestPath, "utf8"));
        const manifest = validateManifest(raw, manifestPath);
        if (manifest.kind !== kind) {
          console.warn(
            `[bundle] member at ${entryPath} declares kind="${manifest.kind}" but lives in the ${kind}/ dir — skipping`,
          );
          return null;
        }
        return {
          kind,
          id: manifest.id,
          version: manifest.version,
          sourcePath: entryPath,
          manifest,
          description: manifest.description,
        };
      }
      case "skill-md": {
        // SKILL.md or legacy manifest.yaml in a per-skill directory.
        if (!stat.isDirectory()) return null;
        const skillMd =
          ["SKILL.md", "Skill.md", "skill.md"].map((n) => join(entryPath, n)).find((p) => existsSync(p)) ?? null;
        if (skillMd) {
          const text = readFileSync(skillMd, "utf8");
          const parsed = parseSkillMd(text, { dirName: entryPath.split(/[\\/]/).pop() });
          return {
            kind: "skill",
            id: parsed.manifest.id,
            version: parsed.manifest.version,
            sourcePath: entryPath,
            manifest: parsed.manifest,
            description: parsed.manifest.description,
          };
        }
        const fallback = join(entryPath, "manifest.yaml");
        if (existsSync(fallback)) {
          const raw = parseYaml(readFileSync(fallback, "utf8"));
          const manifest = validateManifest(raw, fallback);
          if (manifest.kind !== "skill") return null;
          return {
            kind: "skill",
            id: manifest.id,
            version: manifest.version,
            sourcePath: entryPath,
            manifest,
            description: manifest.description,
          };
        }
        return null;
      }
      case "bare-yaml": {
        if (stat.isDirectory()) return null;
        if (![".yaml", ".yml"].includes(extname(entryPath).toLowerCase())) return null;
        // Workflow id == filename stem.
        const id = entryPath
          .split(/[\\/]/)
          .pop()!
          .replace(/\.(yaml|yml)$/i, "");
        return { kind, id, version: "0.0.0", sourcePath: entryPath };
      }
      case "bare-dir": {
        if (!stat.isDirectory()) return null;
        if (entryPath.endsWith("/.") || entryPath.endsWith("_")) return null;
        const id = entryPath.split(/[\\/]/).pop()!;
        // Pull description from a README, like populateBuiltinKbs.
        let description: string | undefined;
        for (const n of ["README.md", "INDEX.md"]) {
          const r = join(entryPath, n);
          if (existsSync(r)) {
            const first = readFileSync(r, "utf8")
              .split("\n")
              .find((l) => l.trim().length > 0);
            if (first) description = first.replace(/^#+\s*/, "").slice(0, 200);
            break;
          }
        }
        return { kind, id: `kb/${id}`, version: "0.0.0", sourcePath: entryPath, description };
      }
      case "bare-md": {
        if (stat.isDirectory()) {
          const sub = join(entryPath, "manifest.yaml");
          if (existsSync(sub)) {
            const raw = parseYaml(readFileSync(sub, "utf8"));
            const manifest = validateManifest(raw, sub);
            if (manifest.kind !== kind) return null;
            return {
              kind,
              id: manifest.id,
              version: manifest.version,
              sourcePath: entryPath,
              manifest,
              description: manifest.description,
            };
          }
          return null;
        }
        if (extname(entryPath).toLowerCase() !== ".md") return null;
        const id = entryPath.split(/[\\/]/).pop()!.replace(/\.md$/i, "");
        return { kind, id, version: "0.0.0", sourcePath: entryPath };
      }
    }
  } catch (err) {
    console.warn(`[bundle] failed to load member at ${entryPath}: ${(err as Error).message}`);
    return null;
  }
  return null;
}

/** Naive globbing: `**` matches anything (including separators), `*` matches no separators. */
function matchGlob(pattern: string, target: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLE::")
        .replace(/\*/g, "[^/\\\\]*")
        .replace(/::DOUBLE::/g, ".*") +
      "$",
  );
  return re.test(target);
}

/** Façade registry — thin typed wrapper over ResourceRegistry for `kind: "bundle"`. */
export class BundleRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  asResources(): ResourceRegistry {
    return this.resources;
  }

  register(resource: Resource<BundleBody>): void {
    if (resource.manifest.kind !== "bundle") {
      throw new Error(`expected manifest.kind="bundle", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "bundle", id, version });
  }

  get(id: string, version?: string): BundleBody | undefined {
    return this.resources.get<BundleBody>({ kind: "bundle", id, version })?.body;
  }

  list(): Array<{ manifest: ResourceManifest; origin: ResourceOrigin; body: BundleBody }> {
    const out: Array<{ manifest: ResourceManifest; origin: ResourceOrigin; body: BundleBody }> = [];
    for (const r of this.resources.list<BundleBody>("bundle")) {
      if (r.body) out.push({ manifest: r.manifest, origin: r.origin, body: r.body });
    }
    return out;
  }
}

void isSkillMdPath;

/**
 * Activate a bundle member: feed its source path back through the
 * ResourceLoader and register the result into the appropriate facade
 * registry. The activated resource's origin records `bundleId` so
 * cascading uninstall can find it later.
 *
 * `targetRegistries` is a sparse map of `kind → ResourceRegistry`. Callers
 * pass in only the kinds they care about (typically pulled off `AgentRuntime`).
 * Unsupported kinds (e.g. workflow, channel, sandbox, task_backend) are
 * returned as `{ ok: false, reason }` — the caller can decide whether to
 * surface that or silently skip.
 */
export interface ActivateMemberOptions {
  bundleId: string;
  member: BundleMember;
  loader: { load: (uri: string) => Promise<Resource> };
  targetRegistries: Partial<Record<ResourceKind, ResourceRegistry>>;
}

export async function activateBundleMember(
  opts: ActivateMemberOptions,
): Promise<{ ok: true; resource: Resource } | { ok: false; reason: string }> {
  const reg = opts.targetRegistries[opts.member.kind];
  if (!reg) {
    return { ok: false, reason: `no registry wired for kind "${opts.member.kind}"` };
  }
  // Load through the standard pipeline so per-kind body resolvers run.
  const resource = await opts.loader.load(`file://${opts.member.sourcePath}`);
  const stampedOrigin: ResourceOrigin = {
    ...resource.origin,
    bundleId: opts.bundleId,
  };
  const stamped: Resource = {
    manifest: resource.manifest,
    origin: stampedOrigin,
    body: resource.body,
  };
  reg.register(stamped);
  return { ok: true, resource: stamped };
}

export function deactivateBundleMember(opts: {
  member: BundleMember;
  targetRegistries: Partial<Record<ResourceKind, ResourceRegistry>>;
}): boolean {
  const reg = opts.targetRegistries[opts.member.kind];
  if (!reg) return false;
  return reg.unregister({ kind: opts.member.kind, id: opts.member.id });
}

/**
 * Cascade: unregister every resource whose origin records the given bundleId.
 * Returns the list of `(kind, id)` pairs that were removed.
 */
export function uninstallBundleCascade(
  bundleId: string,
  targetRegistries: Partial<Record<ResourceKind, ResourceRegistry>>,
): Array<{ kind: ResourceKind; id: string }> {
  const removed: Array<{ kind: ResourceKind; id: string }> = [];
  for (const [kindStr, reg] of Object.entries(targetRegistries)) {
    if (!reg) continue;
    const kind = kindStr as ResourceKind;
    const all = reg.list();
    for (const r of all) {
      if ((r as { origin?: ResourceOrigin }).origin?.bundleId === bundleId) {
        if (reg.unregister({ kind, id: r.manifest.id })) {
          removed.push({ kind, id: r.manifest.id });
        }
      }
    }
  }
  return removed;
}
