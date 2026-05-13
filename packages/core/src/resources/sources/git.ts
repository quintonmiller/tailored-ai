import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FetchOptions, FetchResult, ResourceSource } from "../interface.js";
import { findManifestFile, readManifest, ManifestError } from "../manifest.js";

const execFileAsync = promisify(execFile);

export interface GitRunner {
  (args: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }>;
}

export interface GitResourceSourceOptions {
  /** Override `git` binary path. Defaults to "git" on PATH. */
  gitBin?: string;
  /** Replace the underlying runner — primarily for tests. */
  runner?: GitRunner;
}

/**
 * Loads resources by shallow-cloning a git repository. URI form:
 *
 *     git+https://github.com/owner/repo#<ref>
 *     git+ssh://git@github.com/owner/repo.git#<ref>
 *
 * The fragment after `#` is the branch/tag/sha to check out. When omitted, the
 * default branch is used. Subdirectories are not addressable yet — the
 * manifest is expected at the repo root (or one level down for monorepo-style
 * layouts).
 */
export class GitResourceSource implements ResourceSource {
  readonly scheme = "git" as const;
  private readonly runner: GitRunner;

  constructor(opts: GitResourceSourceOptions = {}) {
    const gitBin = opts.gitBin ?? "git";
    this.runner =
      opts.runner ??
      (async (args, runOpts) => {
        const { stdout, stderr } = await execFileAsync(gitBin, args, {
          cwd: runOpts?.cwd,
          signal: runOpts?.signal,
        });
        return { stdout, stderr };
      });
  }

  async fetch(uri: string, opts: FetchOptions): Promise<FetchResult> {
    const parsed = parseGitUri(uri);
    const cacheRoot = join(opts.cacheDir, "git", hashSpec(parsed.url, parsed.ref ?? "HEAD"));

    if (!cacheExists(cacheRoot)) {
      mkdirSync(cacheRoot, { recursive: true });
      try {
        const cloneArgs = ["clone", "--depth=1"];
        if (parsed.ref) cloneArgs.push("--branch", parsed.ref);
        cloneArgs.push(parsed.url, cacheRoot);
        await this.runner(cloneArgs, { signal: opts.signal });
      } catch (err) {
        await rm(cacheRoot, { recursive: true, force: true });
        throw new Error(`git clone failed for ${uri}: ${(err as Error).message}`);
      }
    }

    let manifestPath = findManifestFile(cacheRoot);
    let manifestDir = cacheRoot;
    if (!manifestPath) {
      const { readdirSync } = await import("node:fs");
      for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".git") continue;
        const inner = join(cacheRoot, entry.name);
        const found = findManifestFile(inner);
        if (found) {
          manifestPath = found;
          manifestDir = inner;
          break;
        }
      }
    }
    if (!manifestPath) {
      throw new ManifestError(`no manifest.yaml found in cloned repo at ${cacheRoot}`);
    }
    const manifest = await readManifest(manifestPath);
    return { rootPath: manifestDir, manifest, resolvedUri: uri };
  }
}

function parseGitUri(uri: string): { url: string; ref?: string } {
  if (!uri.startsWith("git+") && !uri.startsWith("git://")) {
    throw new Error(`GitResourceSource expects git+/git:// URI, got: ${uri}`);
  }
  const stripped = uri.replace(/^git\+/, "");
  const hashIdx = stripped.indexOf("#");
  if (hashIdx === -1) return { url: stripped };
  return {
    url: stripped.slice(0, hashIdx),
    ref: stripped.slice(hashIdx + 1) || undefined,
  };
}

function hashSpec(url: string, ref: string): string {
  return createHash("sha256").update(`${url}#${ref}`).digest("hex").slice(0, 24);
}

function cacheExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
}
