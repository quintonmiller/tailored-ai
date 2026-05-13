import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResourceKind, ResourceManifest } from "./interface.js";

export class ManifestError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(path ? `${message} (at ${path})` : message);
    this.name = "ManifestError";
  }
}

const VALID_KINDS: ReadonlySet<ResourceKind> = new Set([
  "tool",
  "provider",
  "agent",
  "skill",
  "kb",
  "prompt",
  "workflow",
  "step_executor",
  "trigger",
  "channel",
  "sandbox",
  "task_backend",
  "bundle",
]);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/;

const MANIFEST_FILENAMES = ["manifest.yaml", "manifest.yml", "tai-resource.yaml"];

/** Walk a candidate dir for a manifest file; returns absolute path or null. */
export function findManifestFile(rootPath: string): string | null {
  for (const name of MANIFEST_FILENAMES) {
    const candidate = join(rootPath, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function readManifest(manifestPath: string): Promise<ResourceManifest> {
  const text = await readFile(manifestPath, "utf8");
  const raw = parseYaml(text);
  return validateManifest(raw, manifestPath);
}

export function validateManifest(raw: unknown, source?: string): ResourceManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("manifest must be a YAML object", source);
  }
  const obj = raw as Record<string, unknown>;

  const kind = obj.kind;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind as ResourceKind)) {
    throw new ManifestError(
      `kind must be one of: ${Array.from(VALID_KINDS).join(", ")} (got ${JSON.stringify(kind)})`,
      source,
    );
  }

  const id = obj.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ManifestError(
      `id must match "[org/]name" (lowercase, hyphen/underscore/dot/digit) — got ${JSON.stringify(id)}`,
      source,
    );
  }

  const versionRaw = obj.version ?? "0.0.0";
  if (typeof versionRaw !== "string" || !VERSION_PATTERN.test(versionRaw)) {
    throw new ManifestError(`version must be semver-like — got ${JSON.stringify(versionRaw)}`, source);
  }

  const manifest: ResourceManifest = {
    kind: kind as ResourceKind,
    id,
    version: versionRaw,
  };

  if (obj.entrypoint != null) {
    if (typeof obj.entrypoint !== "string") {
      throw new ManifestError("entrypoint must be a string", source);
    }
    manifest.entrypoint = obj.entrypoint;
  }

  if (obj.description != null) {
    if (typeof obj.description !== "string") {
      throw new ManifestError("description must be a string", source);
    }
    manifest.description = obj.description;
  }

  if (obj.hotReload != null) {
    if (typeof obj.hotReload !== "boolean") {
      throw new ManifestError("hotReload must be a boolean", source);
    }
    manifest.hotReload = obj.hotReload;
  }

  if (obj.permissions != null) {
    manifest.permissions = validatePermissions(obj.permissions, source);
  }

  if (obj.dependencies != null) {
    if (!Array.isArray(obj.dependencies)) {
      throw new ManifestError("dependencies must be an array", source);
    }
    manifest.dependencies = obj.dependencies.map((dep, i) => {
      if (!dep || typeof dep !== "object" || Array.isArray(dep)) {
        throw new ManifestError(`dependencies[${i}] must be an object`, source);
      }
      const d = dep as Record<string, unknown>;
      if (typeof d.ref !== "string" || d.ref.length === 0) {
        throw new ManifestError(`dependencies[${i}].ref must be a non-empty string`, source);
      }
      if (d.range != null && typeof d.range !== "string") {
        throw new ManifestError(`dependencies[${i}].range must be a string`, source);
      }
      if (d.kind != null && (typeof d.kind !== "string" || !VALID_KINDS.has(d.kind as ResourceKind))) {
        throw new ManifestError(`dependencies[${i}].kind invalid`, source);
      }
      return {
        ref: d.ref,
        range: d.range as string | undefined,
        kind: d.kind as ResourceKind | undefined,
      };
    });
  }

  if (obj.trust != null) {
    if (typeof obj.trust !== "object" || Array.isArray(obj.trust)) {
      throw new ManifestError("trust must be an object", source);
    }
    const t = obj.trust as Record<string, unknown>;
    manifest.trust = {};
    if (t.signedBy != null) {
      if (typeof t.signedBy !== "string") {
        throw new ManifestError("trust.signedBy must be a string", source);
      }
      manifest.trust.signedBy = t.signedBy;
    }
    if (t.publisher != null) {
      if (typeof t.publisher !== "string") {
        throw new ManifestError("trust.publisher must be a string", source);
      }
      manifest.trust.publisher = t.publisher;
    }
  }

  if (obj.data != null) {
    if (typeof obj.data !== "object" || Array.isArray(obj.data)) {
      throw new ManifestError("data must be an object", source);
    }
    manifest.data = obj.data as Record<string, unknown>;
  }

  return manifest;
}

function validatePermissions(raw: unknown, source?: string): NonNullable<ResourceManifest["permissions"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("permissions must be an object", source);
  }
  const obj = raw as Record<string, unknown>;
  const out: NonNullable<ResourceManifest["permissions"]> = {};
  for (const key of ["network", "filesystem", "tools", "env"] as const) {
    const v = obj[key];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new ManifestError(`permissions.${key} must be an array of strings`, source);
    }
    out[key] = v as string[];
  }
  return out;
}

/** Stable string key for indexing — `kind:id@version`. */
export function manifestKey(kind: ResourceKind, id: string, version: string): string {
  return `${kind}:${id}@${version}`;
}
