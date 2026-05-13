import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FetchOptions, FetchResult, ResourceSource } from "../interface.js";
import { findManifestFile, readManifest, ManifestError } from "../manifest.js";

const execFileAsync = promisify(execFile);

export interface HttpResourceSourceOptions {
  /** Override `tar` binary path. Defaults to "tar" on PATH. */
  tarBin?: string;
  /** Override `fetch` for testability. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Loads resources from `https://` URLs. Two shapes are supported:
 *
 *  1. **Tarball** (Content-Type `application/(gzip|x-tar)` or `.tar.gz` URL):
 *     downloaded, extracted under the cache dir, and `manifest.yaml` resolved
 *     from the extraction root.
 *  2. **Single-file manifest** (Content-Type `application/yaml` or `.yaml`/
 *     `.yml` URL): the body is parsed as a manifest directly. The resource
 *     root is the parent dir of the cached file (which contains only the
 *     manifest); entrypoint resolution must be self-contained.
 *
 * Cache keys are `sha256(url)` so repeated loads are zero-cost. The cache is
 * never auto-evicted today; users delete `~/.tailored-ai/cache/` manually.
 */
export class HttpResourceSource implements ResourceSource {
  readonly scheme = "https" as const;
  private readonly tarBin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpResourceSourceOptions = {}) {
    this.tarBin = opts.tarBin ?? "tar";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetch(uri: string, opts: FetchOptions): Promise<FetchResult> {
    if (!uri.startsWith("https://") && !uri.startsWith("http://")) {
      throw new Error(`HttpResourceSource expects an http(s) URI, got: ${uri}`);
    }
    const cacheRoot = join(opts.cacheDir, "http", hashUri(uri));
    if (cacheExists(cacheRoot)) {
      const { manifest, manifestDir } = await loadManifestFromDir(cacheRoot);
      return { rootPath: manifestDir, manifest, resolvedUri: uri };
    }

    mkdirSync(cacheRoot, { recursive: true });
    const res = await this.fetchImpl(uri, { signal: opts.signal });
    if (!res.ok) {
      await rm(cacheRoot, { recursive: true, force: true });
      throw new Error(`HTTP ${res.status} fetching ${uri}: ${res.statusText}`);
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const looksLikeTarball =
      /\.tar\.gz($|\?)/.test(uri) ||
      /\.tgz($|\?)/.test(uri) ||
      contentType.includes("gzip") ||
      contentType.includes("x-tar");

    try {
      if (looksLikeTarball) {
        const tarPath = join(cacheRoot, "_bundle.tgz");
        if (!res.body) throw new Error("response body is empty");
        await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tarPath));
        await execFileAsync(this.tarBin, ["-xzf", tarPath, "-C", cacheRoot, "--strip-components=0"]);
        await rm(tarPath, { force: true });
      } else if (
        /\.ya?ml($|\?)/.test(uri) ||
        contentType.includes("yaml") ||
        contentType.includes("text/plain")
      ) {
        const text = await res.text();
        const manifestPath = join(cacheRoot, "manifest.yaml");
        await import("node:fs/promises").then((m) => m.writeFile(manifestPath, text, "utf8"));
      } else {
        await rm(cacheRoot, { recursive: true, force: true });
        throw new Error(
          `unsupported content-type "${contentType}" for ${uri} (expected tarball or YAML manifest)`,
        );
      }
    } catch (err) {
      await rm(cacheRoot, { recursive: true, force: true });
      throw err;
    }

    const { manifest, manifestDir } = await loadManifestFromDir(cacheRoot);
    return { rootPath: manifestDir, manifest, resolvedUri: uri };
  }
}

function hashUri(uri: string): string {
  return createHash("sha256").update(uri).digest("hex").slice(0, 24);
}

function cacheExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && findManifestFile(dir) !== null;
  } catch {
    return false;
  }
}

async function loadManifestFromDir(rootPath: string) {
  // After tar extraction, the manifest can be at the root or one level down
  // (npm-style "package/" prefix). Try both, returning whichever dir actually
  // contains manifest.yaml so entrypoint paths resolve correctly.
  let manifestPath = findManifestFile(rootPath);
  let manifestDir = rootPath;
  if (!manifestPath) {
    const { readdirSync } = await import("node:fs");
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const inner = join(rootPath, entry.name);
      const found = findManifestFile(inner);
      if (found) {
        manifestPath = found;
        manifestDir = inner;
        break;
      }
    }
  }
  if (!manifestPath) {
    throw new ManifestError(`no manifest.yaml found after extraction at ${rootPath}`);
  }
  const manifest = await readManifest(manifestPath);
  return { manifest, manifestDir };
}


/** Exported only for tests / scripted maintenance. */
export async function _clearHttpCache(cacheDir: string): Promise<void> {
  const root = join(cacheDir, "http");
  if (existsSync(root)) await rm(root, { recursive: true, force: true });
}
