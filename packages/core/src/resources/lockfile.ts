import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Resource, ResourceKind } from "./interface.js";
import { hashManifest } from "./trust.js";

export interface LockfileEntry {
  kind: ResourceKind;
  id: string;
  version: string;
  /** Manifest hash at install time. Re-install must match (else re-approval). */
  manifestHash: string;
  /** Original URI the resource was installed from. */
  uri: string;
  /** ISO timestamp. */
  installedAt: string;
}

export interface LockfileShape {
  version: 1;
  entries: LockfileEntry[];
}

const EMPTY: LockfileShape = { version: 1, entries: [] };

/** Conventional lockfile path inside a repo. */
export const DEFAULT_LOCKFILE_NAME = "tai.lock";

/**
 * Reproducibility manifest for installed resources. Lives at the project root
 * (or wherever the CLI's `--lockfile` flag points). Same role as
 * `package-lock.json`: pins the exact bytes a fresh `tai install --frozen`
 * should resolve to.
 *
 * Hand-editing is supported — the file is line-stable JSON sorted by
 * `kind:id` so diffs are minimal.
 */
export class Lockfile {
  constructor(private readonly path: string, private state: LockfileShape) {}

  static read(path: string): Lockfile {
    if (!existsSync(path)) return new Lockfile(path, { ...EMPTY, entries: [] });
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockfileShape>;
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      return new Lockfile(path, { version: 1, entries });
    } catch {
      return new Lockfile(path, { ...EMPTY, entries: [] });
    }
  }

  get filePath(): string {
    return this.path;
  }

  list(): LockfileEntry[] {
    return [...this.state.entries];
  }

  get(kind: ResourceKind, id: string): LockfileEntry | undefined {
    return this.state.entries.find((e) => e.kind === kind && e.id === id);
  }

  upsert(entry: Omit<LockfileEntry, "installedAt"> & { installedAt?: string }): void {
    const installedAt = entry.installedAt ?? new Date().toISOString();
    this.state.entries = this.state.entries.filter((e) => !(e.kind === entry.kind && e.id === entry.id));
    this.state.entries.push({ ...entry, installedAt });
    this.sortEntries();
  }

  /** Convenience: record an entry directly from a Resource record. */
  upsertResource(res: Resource): void {
    this.upsert({
      kind: res.manifest.kind,
      id: res.manifest.id,
      version: res.manifest.version,
      manifestHash: hashManifest(res.manifest),
      uri: res.origin.uri,
    });
  }

  remove(kind: ResourceKind, id: string): boolean {
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((e) => !(e.kind === kind && e.id === id));
    return this.state.entries.length !== before;
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const json = JSON.stringify(this.state, null, 2);
    writeFileSync(this.path, `${json}\n`, "utf8");
  }

  private sortEntries(): void {
    this.state.entries.sort((a, b) => {
      const ka = `${a.kind}:${a.id}`;
      const kb = `${b.kind}:${b.id}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
}

/** Resolve the conventional lockfile path next to a working directory. */
export function defaultLockfilePath(cwd: string = process.cwd()): string {
  return resolve(cwd, DEFAULT_LOCKFILE_NAME);
}
