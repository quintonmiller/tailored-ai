import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FetchOptions, FetchResult, ResourceSource } from "../interface.js";
import { findManifestFile, readManifest, ManifestError } from "../manifest.js";

const execFileAsync = promisify(execFile);

export interface NpmRunner {
  (args: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }>;
}

export interface TarRunner {
  (args: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }>;
}

export interface NpmResourceSourceOptions {
  npmBin?: string;
  tarBin?: string;
  /** Override the npm runner for tests. */
  runner?: NpmRunner;
  /** Override the tar runner for tests. */
  tarRunner?: TarRunner;
}

/**
 * Resolves resources from the npm registry. URI form:
 *
 *     npm:@scope/name@1.2.3
 *     npm:plain-name@^1
 *
 * Uses `npm pack <spec>` to fetch the tarball into the cache, then extracts
 * it with `tar -xzf`. The extracted root is `<cache>/<spec>/package/` which
 * is where npm puts the contents — manifest.yaml lives there. Single-file
 * shipments are not supported (npm always packs a directory).
 */
export class NpmResourceSource implements ResourceSource {
  readonly scheme = "npm" as const;
  private readonly runner: NpmRunner;
  private readonly tarRunner: TarRunner;

  constructor(opts: NpmResourceSourceOptions = {}) {
    const npmBin = opts.npmBin ?? "npm";
    const tarBin = opts.tarBin ?? "tar";
    this.runner =
      opts.runner ??
      (async (args, runOpts) => {
        const { stdout, stderr } = await execFileAsync(npmBin, args, {
          cwd: runOpts?.cwd,
          signal: runOpts?.signal,
        });
        return { stdout, stderr };
      });
    this.tarRunner =
      opts.tarRunner ??
      (async (args, runOpts) => {
        const { stdout, stderr } = await execFileAsync(tarBin, args, {
          cwd: runOpts?.cwd,
          signal: runOpts?.signal,
        });
        return { stdout, stderr };
      });
  }

  async fetch(uri: string, opts: FetchOptions): Promise<FetchResult> {
    if (!uri.startsWith("npm:")) {
      throw new Error(`NpmResourceSource expects npm: URI, got: ${uri}`);
    }
    const spec = uri.slice("npm:".length);
    if (!spec) throw new Error(`empty npm spec in URI: ${uri}`);
    const cacheRoot = join(opts.cacheDir, "npm", sanitize(spec));

    if (!cacheExists(cacheRoot)) {
      mkdirSync(cacheRoot, { recursive: true });
      try {
        const result = await this.runner(["pack", spec, "--silent", "--json"], {
          cwd: cacheRoot,
          signal: opts.signal,
        });
        const tarballName = parsePackOutput(result.stdout);
        if (!tarballName) {
          throw new Error(`npm pack produced no tarball name: ${result.stdout.slice(0, 200)}`);
        }
        const tarballPath = join(cacheRoot, tarballName);
        await this.tarRunner(["-xzf", tarballPath, "-C", cacheRoot]);
        await rm(tarballPath, { force: true });
        // npm always wraps in `package/`; promote its contents up one level so
        // `findManifestFile(cacheRoot)` succeeds directly.
        const inner = join(cacheRoot, "package");
        if (existsSync(inner)) {
          for (const entry of readdirSync(inner)) {
            await rename(join(inner, entry), join(cacheRoot, entry));
          }
          await rm(inner, { recursive: true, force: true });
        }
      } catch (err) {
        await rm(cacheRoot, { recursive: true, force: true });
        throw err;
      }
    }

    const manifestPath = findManifestFile(cacheRoot);
    if (!manifestPath) {
      throw new ManifestError(`no manifest.yaml found in npm package at ${cacheRoot}`);
    }
    const manifest = await readManifest(manifestPath);
    return { rootPath: cacheRoot, manifest, resolvedUri: uri };
  }
}

function sanitize(spec: string): string {
  return spec.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parsePackOutput(stdout: string): string | null {
  // `npm pack --json` emits an array; older npm emits plain text (tarball name per line).
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as Array<{ filename?: string }>;
      const first = arr[0];
      if (first?.filename) return first.filename;
    } catch {
      /* fall through to plain text */
    }
  }
  const lines = trimmed.split("\n").filter((l) => l.endsWith(".tgz"));
  return lines[lines.length - 1] ?? null;
}

function cacheExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && findManifestFile(dir) !== null;
  } catch {
    return false;
  }
}
