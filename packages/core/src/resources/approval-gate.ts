import type { ApprovalHandler } from "../approval.js";
import { createApprovalRequestId } from "../approval.js";
import type { Resource, ResourceManifest, ResourcePermissions } from "./interface.js";
import { hashManifest, TrustStore } from "./trust.js";

export interface ApprovalGateOptions {
  trust?: TrustStore;
  /** When set, prompts the user on install. Without it, untrusted installs are auto-denied. */
  handler?: ApprovalHandler;
  /** Override sessionId on approval prompts. Used in logs/UI. */
  sessionId?: string;
}

export interface InstallDecision {
  /** True if the install proceeds. */
  approved: boolean;
  /** Permissions to grant. Always a subset of (resource.permissions, callerHeld). */
  grantedPermissions: ResourcePermissions;
  /** Why the install was approved or denied — surfaced to the agent. */
  reason: string;
  /** True if this came from a stored decision (no prompt). */
  cached: boolean;
}

/**
 * Gates resource installation. Order of decisions, top to bottom:
 *
 *  1. **Stored decision (same hash)** — cached approve, no prompt.
 *  2. **Trusted publisher** — manifest is signed by a key in TrustStore.
 *  3. **No handler available** — deny (defaults to safe).
 *  4. **Prompt** — pass through the ApprovalHandler. On approval, record.
 *
 * Permission narrowing: if the caller is itself running with a restricted
 * permission set (e.g. an agent installing a sub-resource), the requested
 * permissions are clamped to the intersection of `manifest.permissions`
 * and `callerPermissions`. This prevents privilege escalation through
 * agent-authored installs.
 */
export class ApprovalGate {
  private trust: TrustStore;
  private handler?: ApprovalHandler;
  private sessionId: string;

  constructor(opts: ApprovalGateOptions = {}) {
    this.trust = opts.trust ?? new TrustStore();
    this.handler = opts.handler;
    this.sessionId = opts.sessionId ?? "system";
  }

  setHandler(handler: ApprovalHandler | undefined): void {
    this.handler = handler;
  }

  getTrustStore(): TrustStore {
    return this.trust;
  }

  /**
   * Decide whether the given resource may be installed. Caller-supplied
   * `callerPermissions` cap the permissions the resource is allowed to
   * declare; pass `null` for an unrestricted caller (e.g. the user via CLI).
   */
  async decide(input: {
    resource: Resource;
    callerPermissions?: ResourcePermissions | null;
    /** Optional reason override for the prompt. */
    reasonHint?: string;
  }): Promise<InstallDecision> {
    const { manifest } = input.resource;
    const requested = manifest.permissions ?? {};
    const granted = clampPermissions(requested, input.callerPermissions ?? null);
    const hash = hashManifest(manifest);

    // 1. Stored decision for the same hash → auto-approve with previously granted perms.
    const prior = this.trust.getTrustedResource(manifest.kind, manifest.id, hash);
    if (prior) {
      return {
        approved: true,
        grantedPermissions: prior.grantedPermissions,
        reason: `cached approval from ${prior.trustedAt}`,
        cached: true,
      };
    }

    // 2. Trusted publisher (signed manifest) → auto-approve with clamped perms.
    if (manifest.trust?.signedBy && this.trust.isPublisherTrusted(manifest.trust.signedBy)) {
      this.trust.approveResource(manifest, input.resource.origin.uri, granted);
      return {
        approved: true,
        grantedPermissions: granted,
        reason: `trusted publisher ${manifest.trust.publisher ?? manifest.trust.signedBy}`,
        cached: false,
      };
    }

    // 3. No handler → safe default is deny.
    if (!this.handler) {
      return {
        approved: false,
        grantedPermissions: {},
        reason: "no approval handler configured; default deny for untrusted resource",
        cached: false,
      };
    }

    // 4. Prompt the user.
    const response = await this.handler.requestApproval({
      requestId: createApprovalRequestId(),
      toolName: "resource_install",
      toolArgs: {
        kind: manifest.kind,
        id: manifest.id,
        version: manifest.version,
        origin: input.resource.origin.uri,
        permissions: granted,
        reason: input.reasonHint ?? "untrusted resource — review permissions before approving",
      },
      sessionId: this.sessionId,
      description: describeManifest(manifest, granted),
    });

    if (response.approved) {
      this.trust.approveResource(manifest, input.resource.origin.uri, granted);
      return {
        approved: true,
        grantedPermissions: granted,
        reason: response.reason ?? "user approved",
        cached: false,
      };
    }

    return {
      approved: false,
      grantedPermissions: {},
      reason: response.reason ?? "user denied",
      cached: false,
    };
  }
}

/**
 * Intersect two permission specs. `null` callerPermissions means "no
 * restriction" (e.g. CLI user). Empty arrays mean "no access".
 */
export function clampPermissions(
  requested: ResourcePermissions,
  caller: ResourcePermissions | null,
): ResourcePermissions {
  if (caller === null) return cloneOrDefault(requested);
  const out: ResourcePermissions = {};
  for (const key of ["network", "filesystem", "tools", "env"] as const) {
    const req = requested[key];
    const cap = caller[key];
    if (!req || req.length === 0) continue;
    if (!cap) {
      // Caller didn't grant this category at all → drop.
      continue;
    }
    if (cap.includes("*")) {
      out[key] = [...req];
      continue;
    }
    out[key] = req.filter((entry) => cap.some((c) => permissionEntryAllowed(c, entry)));
  }
  return out;
}

function permissionEntryAllowed(capability: string, requested: string): boolean {
  if (capability === requested) return true;
  if (capability.endsWith("/*")) {
    const prefix = capability.slice(0, -2);
    return requested.startsWith(prefix);
  }
  return false;
}

function cloneOrDefault(p: ResourcePermissions): ResourcePermissions {
  const out: ResourcePermissions = {};
  for (const key of ["network", "filesystem", "tools", "env"] as const) {
    if (p[key]) out[key] = [...p[key]!];
  }
  return out;
}

function describeManifest(manifest: ResourceManifest, granted: ResourcePermissions): string {
  const parts = [
    `Install ${manifest.kind}/${manifest.id}@${manifest.version}`,
    manifest.description ? `— ${manifest.description}` : "",
  ].filter(Boolean);
  const permLines: string[] = [];
  for (const k of ["network", "filesystem", "tools", "env"] as const) {
    const v = granted[k];
    if (v && v.length > 0) permLines.push(`  ${k}: ${v.join(", ")}`);
  }
  if (permLines.length === 0) permLines.push("  (none)");
  return `${parts.join(" ")}\nPermissions granted:\n${permLines.join("\n")}`;
}
