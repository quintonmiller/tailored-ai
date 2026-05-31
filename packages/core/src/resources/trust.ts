import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
    this.path = path ?? resolve(homedir(), ".tailored-ai/trust.json");
    this.state = this.load();
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
 * Stable hash of a manifest. We strip the `trust` block before hashing so a
 * signature can sit alongside the hash without invalidating it.
 */
export function hashManifest(manifest: ResourceManifest): string {
  const { trust: _trust, ...rest } = manifest;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return createHash("sha256").update(canonical).digest("hex");
}
