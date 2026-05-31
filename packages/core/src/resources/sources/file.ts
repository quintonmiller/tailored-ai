import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FetchOptions, FetchResult, ResourceSource } from "../interface.js";
import { findManifestFile, ManifestError, readManifest } from "../manifest.js";
import { findSkillMdFile, isSkillMdPath, readSkillMd } from "../skill-md.js";

/**
 * Loads resources from the local filesystem. Accepts either `file://` URIs or
 * plain absolute/relative paths (which we coerce to `file://` for consistency).
 *
 * Resolution order inside a directory:
 *   1. SKILL.md   — agentskills.io standard
 *   2. manifest.yaml / manifest.yml / tai-resource.yaml — TAI legacy
 *
 * If a file path is passed directly (e.g. `.../SKILL.md` or `.../manifest.yaml`)
 * it is used verbatim.
 */
export class FileResourceSource implements ResourceSource {
  readonly scheme = "file" as const;

  async fetch(uri: string, _opts: FetchOptions): Promise<FetchResult> {
    const rootPath = uriToPath(uri);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(rootPath);
    } catch (err) {
      throw new Error(`file resource not found: ${rootPath} (${(err as Error).message})`);
    }
    const dir = stat.isDirectory() ? rootPath : resolve(rootPath, "..");

    // 1. Direct file path?
    if (stat.isFile()) {
      if (isSkillMdPath(rootPath)) {
        const parsed = await readSkillMd(rootPath);
        return { rootPath: dir, manifest: parsed.manifest, resolvedUri: pathToFileURL(dir).href };
      }
      if (
        rootPath.endsWith("manifest.yaml") ||
        rootPath.endsWith("manifest.yml") ||
        rootPath.endsWith("tai-resource.yaml")
      ) {
        const manifest = await readManifest(rootPath);
        warnLegacySkillManifest(manifest, rootPath);
        return { rootPath: dir, manifest, resolvedUri: pathToFileURL(dir).href };
      }
    }

    // 2. Directory — prefer SKILL.md.
    const skillMdPath = findSkillMdFile(dir);
    if (skillMdPath) {
      const parsed = await readSkillMd(skillMdPath);
      return { rootPath: dir, manifest: parsed.manifest, resolvedUri: pathToFileURL(dir).href };
    }

    const manifestPath = findManifestFile(dir);
    if (!manifestPath) {
      throw new ManifestError(`no SKILL.md or manifest.yaml found in ${dir}`);
    }
    const manifest = await readManifest(manifestPath);
    warnLegacySkillManifest(manifest, manifestPath);
    return { rootPath: dir, manifest, resolvedUri: pathToFileURL(dir).href };
  }
}

// Re-export for convenience — `BundleBody` discovery happens at the loader
// resolver level using `discoverBundleMembers(rootPath, options)`. See
// `packages/core/src/resources/bundle.ts`.

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) return fileURLToPath(uri);
  return resolve(uri);
}

const warnedIds = new Set<string>();
function warnLegacySkillManifest(manifest: { kind: string; id: string }, path: string): void {
  if (manifest.kind !== "skill") return;
  const key = `${manifest.id}@${path}`;
  if (warnedIds.has(key)) return;
  warnedIds.add(key);
  console.warn(
    `[skill] DEPRECATION: ${manifest.id} uses manifest.yaml at ${path}. ` +
      `Migrate to the agentskills.io SKILL.md format (frontmatter + Markdown body).`,
  );
}
