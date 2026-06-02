/**
 * Centralized SSRF + outbound-HTTP egress policy. Closes #57.
 *
 * Why this exists: `web_fetch`, the workflow `http_request` executor, and
 * the trigger pollers all called out to `fetch` directly with no consistent
 * checks. Anything that resolved to a private IP, link-local, loopback, or
 * cloud metadata endpoint went through unchallenged — a model that's been
 * jailbroken into picking the URL has a straight line to internal services.
 *
 * The policy:
 *   - default-denies loopback, RFC1918, IPv6 ULA (fc00::/7), link-local
 *     (169.254.0.0/16, fe80::/10), and cloud metadata endpoints
 *     (169.254.169.254, fd00:ec2::254, fe80::a9fe:a9fe)
 *   - allows the host to opt back into any subset via `allowPrivateNetworks`
 *     / `allowMetadataEndpoints` (some self-hosted integrations legitimately
 *     target internal hosts)
 *   - honors per-host `allowHosts` / `denyHosts` allow/deny lists
 *   - resolves the URL hostname via DNS before letting the fetch run so a
 *     domain that resolves to 10.0.0.1 is caught the same as a literal
 *     `http://10.0.0.1/...`
 *
 * Known limitation (DNS rebinding): the check resolves DNS once; the fetch
 * resolves separately. A malicious authoritative server could return a
 * public IP to us and a private IP to fetch. A full fix requires fetching
 * with a custom dispatcher pinned to the resolved IP — out of scope here;
 * tracked as a follow-up. The single-resolve check still raises the bar
 * substantially compared to no check at all.
 */

import { lookup as defaultLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Pluggable DNS resolver — defaults to `node:dns/promises.lookup`. Tests
 * inject a fake. Production callers normally leave this alone.
 */
export type EgressLookup = (hostname: string) => Promise<string[]>;

export interface EgressPolicyConfig {
  /**
   * Skip the policy entirely. Off by default. Set this when an operator
   * has acknowledged the risk (e.g. fully air-gapped network).
   */
  disabled?: boolean;
  /**
   * Permit loopback, RFC1918, IPv6 ULA, and link-local destinations.
   * Default false. Self-hosted integrations (Home Assistant on the LAN,
   * a local Ollama server) flip this on intentionally.
   */
  allowPrivateNetworks?: boolean;
  /**
   * Permit cloud metadata endpoints (AWS / GCP / Azure IMDS). Default
   * false — the IMDS is the most common SSRF target.
   */
  allowMetadataEndpoints?: boolean;
  /**
   * Hostnames (or `*.suffix`) that always pass. Matched case-insensitively.
   * Useful for: an intentional internal API target (e.g. `homeassistant.local`)
   * without flipping `allowPrivateNetworks` on for every other host.
   */
  allowHosts?: string[];
  /**
   * Hostnames (or `*.suffix`) that always fail. Honored before allowHosts
   * so a deny entry wins.
   */
  denyHosts?: string[];
}

export class EgressDeniedError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`Egress denied: ${url} (${reason})`);
    this.name = "EgressDeniedError";
  }
}

const METADATA_IPS = new Set<string>([
  "169.254.169.254", // AWS, GCP, Azure (IMDSv1 + IMDSv2)
  "fd00:ec2::254", // AWS IMDS over IPv6
  "fe80::a9fe:a9fe", // Azure link-local IMDS
]);

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export class EgressPolicy {
  private readonly lookup: EgressLookup;
  constructor(
    private readonly config: EgressPolicyConfig = {},
    lookup?: EgressLookup,
  ) {
    this.lookup = lookup ?? (async (hostname: string) => {
      const results = await defaultLookup(hostname, { all: true });
      return results.map((r) => r.address);
    });
  }

  /**
   * Check whether `rawUrl` is allowed under the policy. Throws
   * {@link EgressDeniedError} when blocked. Returns void on pass.
   */
  async check(rawUrl: string): Promise<void> {
    if (this.config.disabled) return;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new EgressDeniedError(rawUrl, "malformed URL");
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      throw new EgressDeniedError(rawUrl, `protocol "${url.protocol}" not allowed`);
    }

    // WHATWG URL keeps IPv6 literals bracketed (`[::1]`). Strip the
    // brackets before IP classification or DNS lookup.
    const hostname = stripIpv6Brackets(url.hostname);
    const lc = hostname.toLowerCase();

    // Deny list wins over allow list.
    if (this.matchesHostList(lc, this.config.denyHosts)) {
      throw new EgressDeniedError(rawUrl, "host on denyHosts");
    }
    // Explicit allow — bypass IP checks (the operator owns the risk).
    if (this.matchesHostList(lc, this.config.allowHosts)) return;

    const ips = await this.resolveIps(hostname);
    // DNS failure isn't a security event — let the fetch fail with the
    // real error message. (No IPs to check; return.)
    if (ips.length === 0) return;

    for (const ip of ips) {
      const block = this.classifyIp(ip);
      if (block) {
        throw new EgressDeniedError(rawUrl, `${block} (resolves to ${ip})`);
      }
    }
  }

  private async resolveIps(hostname: string): Promise<string[]> {
    if (isIP(hostname)) return [hostname];
    try {
      return await this.lookup(hostname);
    } catch {
      return [];
    }
  }

  private classifyIp(ip: string): string | null {
    const isMetadata = METADATA_IPS.has(ip.toLowerCase());
    if (isMetadata && !this.config.allowMetadataEndpoints) {
      return "cloud metadata endpoint";
    }
    // Metadata IPs are also link-local. When the operator opts into
    // metadata, the link-local check below must not re-block them.
    if (isMetadata && this.config.allowMetadataEndpoints) return null;
    if (this.config.allowPrivateNetworks) return null;
    if (isLoopback(ip)) return "loopback";
    if (isLinkLocal(ip)) return "link-local";
    if (isPrivateIpv4(ip)) return "private (RFC1918)";
    if (isCarrierGrade(ip)) return "carrier-grade NAT (100.64/10)";
    if (isPrivateIpv6(ip)) return "private (IPv6 ULA)";
    if (isUnspecified(ip)) return "unspecified address";
    return null;
  }

  private matchesHostList(host: string, list: string[] | undefined): boolean {
    if (!list || list.length === 0) return false;
    return list.some((entry) => {
      const lc = entry.toLowerCase();
      return host === lc || host.endsWith(`.${lc}`);
    });
  }
}

export function createEgressPolicy(config?: EgressPolicyConfig, lookup?: EgressLookup): EgressPolicy {
  return new EgressPolicy(config, lookup);
}

/**
 * Permissive policy used when the host hasn't supplied one. Plumbed into
 * tools that take an EgressPolicy so the default behavior is unchanged
 * for callers that haven't migrated yet. The runtime wires the strict
 * (config-supplied) policy at construction time.
 */
export const PERMISSIVE_EGRESS_POLICY = new EgressPolicy({ disabled: true });

function stripIpv6Brackets(host: string): string {
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

// ─── IP classification helpers ────────────────────────────────────────────

function isLoopback(ip: string): boolean {
  if (ip === "::1") return true;
  if (ip.startsWith("127.")) return true;
  return false;
}

function isLinkLocal(ip: string): boolean {
  if (ip.startsWith("169.254.")) return true;
  const lc = ip.toLowerCase();
  if (lc.startsWith("fe80:") || lc.startsWith("fe80::")) return true;
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  // 172.16.0.0/12 → 172.16-172.31
  const m = /^172\.(\d{1,3})\./.exec(ip);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

function isCarrierGrade(ip: string): boolean {
  // 100.64.0.0/10 → 100.64-100.127
  const m = /^100\.(\d{1,3})\./.exec(ip);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 64 && n <= 127) return true;
  }
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  // fc00::/7 — Unique Local Address
  const lc = ip.toLowerCase();
  if (/^f[cd]/.test(lc)) return true;
  return false;
}

function isUnspecified(ip: string): boolean {
  if (ip === "0.0.0.0") return true;
  if (ip === "::" || ip === "::0") return true;
  return false;
}
