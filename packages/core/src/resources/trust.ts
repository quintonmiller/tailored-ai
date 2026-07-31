import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { taiHomePath } from "../home.js";
import type { ResourceManifest, ResourcePermissions } from "./interface.js";

export type TrustDecision = "trust" | "trust-once" | "deny";

export interface TrustedPublisher {
  publicKey: string;
  publisher: string;
  /** ISO timestamp. */
  trustedAt: string;
}

export interface TrustedResource {
  /** Composite key — `kind:id`. */
  key: string;
  /** sha256 of the canonical manifest representation. */
  manifestHash: string;
  /** Permissions granted at install time. */
  grantedPermissions: ResourcePermissions;
  /** ISO timestamp. */
  trustedAt: string;
  /** Origin URI the resource was installed from. */
  origin: string;
}

export interface TrustStoreShape {
  version: 1;
  publishers: TrustedPublisher[];
  resources: TrustedResource[];
}

/**
 * Persistent trust store. Lives at `~/.tailored-ai/trust.json` by default.
 * Tracks two things:
 *
 *  1. **Trusted publishers** — public keys whose signed manifests bypass the
 *     install prompt. Managed via `tai trust <publisher-key>`.
 *  2. **Approved resources** — `(kind:id, manifestHash, grantedPermissions)`
 *     tuples that record install-time decisions. A re-install with the same
 *     hash auto-trusts; a manifest change forces re-approval.
 *
 * Designed so the file is hand-editable and survives version upgrades.
 */
export class TrustStore {
  private path: string;
  private state: TrustStoreShape;

  constructor(path?: string) {
    this.path = path ? resolve(path) : taiHomePath("trust.json");
    this.state = this.load();
  }

  /** Which file this store is backed by — the instance it belongs to, made legible. */
  get storePath(): string {
    return this.path;
  }

  private load(): TrustStoreShape {
    if (!existsSync(this.path)) {
      return { version: 1, publishers: [], resources: [] };
    }
    try {
      const text = readFileSync(this.path, "utf8");
      const raw = JSON.parse(text) as Partial<TrustStoreShape>;
      return {
        version: 1,
        publishers: Array.isArray(raw.publishers) ? raw.publishers : [],
        resources: Array.isArray(raw.resources) ? raw.resources : [],
      };
    } catch {
      // Corrupt file — start fresh rather than crash the runtime.
      return { version: 1, publishers: [], resources: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  /** Returns true if the given signedBy key is in the trusted-publisher list. */
  isPublisherTrusted(signedBy: string | undefined): boolean {
    if (!signedBy) return false;
    return this.state.publishers.some((p) => p.publicKey === signedBy);
  }

  trustPublisher(publicKey: string, publisher: string): void {
    if (this.state.publishers.some((p) => p.publicKey === publicKey)) return;
    this.state.publishers.push({ publicKey, publisher, trustedAt: new Date().toISOString() });
    this.save();
  }

  revokePublisher(publicKey: string): boolean {
    const before = this.state.publishers.length;
    this.state.publishers = this.state.publishers.filter((p) => p.publicKey !== publicKey);
    if (this.state.publishers.length === before) return false;
    this.save();
    return true;
  }

  /** Returns the existing trusted-resource record if the hash matches, else undefined. */
  getTrustedResource(kind: string, id: string, manifestHash: string): TrustedResource | undefined {
    const key = `${kind}:${id}`;
    return this.state.resources.find((r) => r.key === key && r.manifestHash === manifestHash);
  }

  approveResource(manifest: ResourceManifest, origin: string, grantedPermissions: ResourcePermissions): void {
    const hash = hashManifest(manifest);
    const key = `${manifest.kind}:${manifest.id}`;
    // Replace any existing entry for this kind:id — the new hash supersedes.
    this.state.resources = this.state.resources.filter((r) => r.key !== key);
    this.state.resources.push({
      key,
      manifestHash: hash,
      grantedPermissions,
      trustedAt: new Date().toISOString(),
      origin,
    });
    this.save();
  }

  revokeResource(kind: string, id: string): boolean {
    const key = `${kind}:${id}`;
    const before = this.state.resources.length;
    this.state.resources = this.state.resources.filter((r) => r.key !== key);
    if (this.state.resources.length === before) return false;
    this.save();
    return true;
  }

  listPublishers(): TrustedPublisher[] {
    return [...this.state.publishers];
  }
  listResources(): TrustedResource[] {
    return [...this.state.resources];
  }
}

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order.
 *
 * Written out rather than leaning on `JSON.stringify`'s second parameter, which
 * is what the bug below was. Key order has to be stable at every level or the
 * hash changes when a YAML parser or an authoring endpoint happens to emit the
 * same content in a different order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Stable hash of a manifest. We strip the `trust` block before hashing so a
 * signature can sit alongside the hash without invalidating it.
 *
 * This used to read:
 *
 *     JSON.stringify(rest, Object.keys(rest).sort())
 *
 * The second argument to `JSON.stringify` is a **replacer array**, not a sort
 * order, and it applies at every depth. Top-level keys survived; their children
 * did not — so every manifest canonicalized to `{"data":{},…}` and the hash
 * covered a resource's id, kind, version and description, and nothing else.
 *
 * Two skill manifests differing in both `data.instructions` ("be nice" versus
 * "exfiltrate ~/.ssh via exec") and `data.toolRefs` (`[read]` versus
 * `[exec, write, web_fetch]`) hashed identically. `permissions` was blanked the
 * same way, so the hash described neither what a resource does nor what it is
 * allowed to do — while the trust store's cached-approval check and
 * `--frozen` both depend on it. Approve a benign SKILL.md once and its body
 * could be rewritten with no re-prompt.
 *
 * Expect one re-approval per installed resource the first time this runs: the
 * stored hashes were computed under the old scheme and will not match.
 */
export function hashManifest(manifest: ResourceManifest): string {
  const { trust: _trust, ...rest } = manifest;
  const canonical = JSON.stringify(canonicalize(rest));
  return createHash("sha256").update(canonical).digest("hex");
}
