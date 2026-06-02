/**
 * Tests for the centralized SSRF/egress policy (#57). Network-level
 * tests use IP-literal URLs so DNS doesn't enter the picture. The
 * DNS-resolution path is exercised separately by mocking `node:dns`.
 */

import { describe, expect, it } from "vitest";
import { EgressDeniedError, EgressPolicy } from "../security/egress-policy.js";

describe("EgressPolicy — IP-literal denials", () => {
  const policy = new EgressPolicy();

  it("blocks loopback IPv4", async () => {
    await expect(policy.check("http://127.0.0.1/foo")).rejects.toThrow(EgressDeniedError);
    await expect(policy.check("http://127.1.2.3:8080/")).rejects.toThrow(/loopback/);
  });

  it("blocks loopback IPv6", async () => {
    await expect(policy.check("http://[::1]/")).rejects.toThrow(/loopback/);
  });

  it("blocks RFC1918 IPv4 (10/8, 172.16/12, 192.168/16)", async () => {
    await expect(policy.check("http://10.0.0.1/")).rejects.toThrow(/RFC1918/);
    await expect(policy.check("http://172.16.0.1/")).rejects.toThrow(/RFC1918/);
    await expect(policy.check("http://172.31.255.255/")).rejects.toThrow(/RFC1918/);
    await expect(policy.check("http://192.168.1.1/")).rejects.toThrow(/RFC1918/);
  });

  it("does not block 172.15 or 172.32 (outside RFC1918)", async () => {
    // These are public — the regex must not over-match.
    // 172.15.x.x and 172.32.x.x are not RFC1918, so should not throw on
    // the RFC1918 check. (They may still throw if some other classifier
    // catches them; assert via the not-RFC1918 negation.)
    await expect(policy.check("http://172.15.0.1/")).resolves.toBeUndefined();
    await expect(policy.check("http://172.32.0.1/")).resolves.toBeUndefined();
  });

  it("blocks link-local (169.254/16)", async () => {
    await expect(policy.check("http://169.254.0.1/")).rejects.toThrow(/link-local/);
  });

  it("blocks AWS/GCP IMDSv1 at 169.254.169.254", async () => {
    await expect(policy.check("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/metadata/);
  });

  it("blocks IPv6 ULA (fc00::/7)", async () => {
    await expect(policy.check("http://[fd12:3456:789a::1]/")).rejects.toThrow(/ULA/);
    await expect(policy.check("http://[fc00::1]/")).rejects.toThrow(/ULA/);
  });

  it("blocks IPv6 link-local (fe80::/10)", async () => {
    await expect(policy.check("http://[fe80::1]/")).rejects.toThrow(/link-local/);
  });

  it("blocks carrier-grade NAT 100.64/10", async () => {
    await expect(policy.check("http://100.64.0.1/")).rejects.toThrow(/carrier-grade/);
  });

  it("blocks unspecified addresses", async () => {
    await expect(policy.check("http://0.0.0.0/")).rejects.toThrow(/unspecified/);
  });

  it("blocks non-http(s) protocols", async () => {
    await expect(policy.check("file:///etc/passwd")).rejects.toThrow(/protocol/);
    await expect(policy.check("ftp://10.0.0.1/")).rejects.toThrow(/protocol/);
  });

  it("rejects malformed URLs", async () => {
    await expect(policy.check("not a url")).rejects.toThrow(/malformed/);
  });
});

describe("EgressPolicy — IP-literal allows", () => {
  it("allows public IPv4", async () => {
    const policy = new EgressPolicy();
    await expect(policy.check("https://8.8.8.8/")).resolves.toBeUndefined();
  });

  it("allows public IPv6", async () => {
    const policy = new EgressPolicy();
    await expect(policy.check("https://[2001:4860:4860::8888]/")).resolves.toBeUndefined();
  });
});

describe("EgressPolicy — config overrides", () => {
  it("`disabled: true` short-circuits all checks", async () => {
    const policy = new EgressPolicy({ disabled: true });
    await expect(policy.check("http://10.0.0.1/")).resolves.toBeUndefined();
    await expect(policy.check("http://169.254.169.254/")).resolves.toBeUndefined();
    await expect(policy.check("file:///etc/passwd")).resolves.toBeUndefined();
  });

  it("`allowPrivateNetworks: true` lets RFC1918 and loopback through but still blocks metadata", async () => {
    const policy = new EgressPolicy({ allowPrivateNetworks: true });
    await expect(policy.check("http://10.0.0.1/")).resolves.toBeUndefined();
    await expect(policy.check("http://127.0.0.1:8080/")).resolves.toBeUndefined();
    await expect(policy.check("http://169.254.169.254/")).rejects.toThrow(/metadata/);
  });

  it("`allowMetadataEndpoints: true` lets metadata IPs through (but not other private)", async () => {
    const policy = new EgressPolicy({ allowMetadataEndpoints: true });
    await expect(policy.check("http://169.254.169.254/")).resolves.toBeUndefined();
    await expect(policy.check("http://10.0.0.1/")).rejects.toThrow(/RFC1918/);
  });

  it("denyHosts wins over allowHosts", async () => {
    const policy = new EgressPolicy({
      allowHosts: ["evil.example.com"],
      denyHosts: ["evil.example.com"],
    });
    await expect(policy.check("https://evil.example.com/")).rejects.toThrow(/denyHosts/);
  });

  it("allowHosts bypasses IP checks (operator owns the risk)", async () => {
    // 10.0.0.1 would normally be blocked, but allowing the literal IP
    // string via allowHosts should let it through.
    const policy = new EgressPolicy({ allowHosts: ["10.0.0.1"] });
    await expect(policy.check("http://10.0.0.1/")).resolves.toBeUndefined();
  });

  it("allowHosts matches subdomains with `.suffix`", async () => {
    const policy = new EgressPolicy({ allowHosts: ["example.com"] }, async () => ["8.8.8.8"]);
    await expect(policy.check("https://api.example.com/")).resolves.toBeUndefined();
    await expect(policy.check("https://example.com/")).resolves.toBeUndefined();
  });
});

describe("EgressPolicy — DNS resolution", () => {
  it("denies a hostname that resolves to a private IP", async () => {
    const policy = new EgressPolicy({}, async () => ["10.0.0.1"]);
    await expect(policy.check("https://internal.example.com/")).rejects.toThrow(/RFC1918/);
  });

  it("denies a hostname that resolves to ANY private IP (any-of)", async () => {
    // One leg public, one leg private — block. Otherwise an attacker
    // can multi-A-record their way past us.
    const policy = new EgressPolicy({}, async () => ["8.8.8.8", "10.0.0.1"]);
    await expect(policy.check("https://mixed.example.com/")).rejects.toThrow(/RFC1918/);
  });

  it("treats DNS failure as a pass-through (let fetch surface the real error)", async () => {
    const policy = new EgressPolicy({}, async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(policy.check("https://nope.invalid/")).resolves.toBeUndefined();
  });

  it("allows a hostname that resolves to a public IP", async () => {
    const policy = new EgressPolicy({}, async () => ["8.8.8.8"]);
    await expect(policy.check("https://example.com/")).resolves.toBeUndefined();
  });
});
