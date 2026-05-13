import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, TrustStore, clampPermissions, hashManifest } from "../resources/index.js";
import type { Resource, ResourceManifest, ResourcePermissions } from "../resources/interface.js";

function manifest(id: string, permissions?: ResourcePermissions, signedBy?: string): ResourceManifest {
  return {
    kind: "tool",
    id,
    version: "1.0.0",
    description: `test tool ${id}`,
    permissions,
    trust: signedBy ? { signedBy } : undefined,
  };
}

function fakeResource(id: string, permissions?: ResourcePermissions, signedBy?: string): Resource {
  return {
    manifest: manifest(id, permissions, signedBy),
    origin: { scheme: "https", uri: `https://example.com/${id}`, loadedAt: Date.now() },
    body: null,
  };
}

function tempTrustPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tai-trust-")), "trust.json");
}

describe("hashManifest", () => {
  it("ignores the trust block so signing doesn't change the hash", () => {
    const a = manifest("my/tool");
    const b = manifest("my/tool", undefined, "ed25519:abc");
    expect(hashManifest(a)).toBe(hashManifest(b));
  });

  it("changes when manifest contents change", () => {
    const a = manifest("my/tool");
    const b = { ...manifest("my/tool"), description: "different" };
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });
});

describe("clampPermissions", () => {
  it("returns requested unchanged when caller is unrestricted", () => {
    const req: ResourcePermissions = { network: ["a"], filesystem: ["/b"] };
    expect(clampPermissions(req, null)).toEqual(req);
  });

  it("intersects against caller capabilities", () => {
    const req: ResourcePermissions = { network: ["api.openai.com", "api.evil.com"] };
    const cap: ResourcePermissions = { network: ["api.openai.com"] };
    expect(clampPermissions(req, cap)).toEqual({ network: ["api.openai.com"] });
  });

  it("expands wildcard caller capabilities", () => {
    const req: ResourcePermissions = { tools: ["read", "write"] };
    const cap: ResourcePermissions = { tools: ["*"] };
    expect(clampPermissions(req, cap)).toEqual({ tools: ["read", "write"] });
  });

  it("matches subpath wildcards", () => {
    const req: ResourcePermissions = { filesystem: ["/data/foo", "/etc/passwd"] };
    const cap: ResourcePermissions = { filesystem: ["/data/*"] };
    expect(clampPermissions(req, cap)).toEqual({ filesystem: ["/data/foo"] });
  });

  it("drops categories the caller doesn't grant", () => {
    const req: ResourcePermissions = { network: ["a"], tools: ["read"] };
    const cap: ResourcePermissions = { tools: ["read"] };
    expect(clampPermissions(req, cap)).toEqual({ tools: ["read"] });
  });
});

describe("TrustStore", () => {
  it("persists trusted publishers across instances", () => {
    const path = tempTrustPath();
    const a = new TrustStore(path);
    a.trustPublisher("ed25519:abc", "Acme Inc.");
    expect(existsSync(path)).toBe(true);

    const b = new TrustStore(path);
    expect(b.isPublisherTrusted("ed25519:abc")).toBe(true);
    expect(b.isPublisherTrusted("ed25519:other")).toBe(false);
  });

  it("records and retrieves approved resources by manifest hash", () => {
    const path = tempTrustPath();
    const store = new TrustStore(path);
    const m = manifest("my/foo", { network: ["x"] });
    store.approveResource(m, "https://example.com/foo", { network: ["x"] });
    const hit = store.getTrustedResource("tool", "my/foo", hashManifest(m));
    expect(hit?.grantedPermissions.network).toEqual(["x"]);

    // Manifest mutation invalidates the trust.
    const m2 = { ...m, description: "changed" };
    expect(store.getTrustedResource("tool", "my/foo", hashManifest(m2))).toBeUndefined();
  });

  it("survives a corrupted file by starting fresh", () => {
    const path = tempTrustPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not json {{{");
    const store = new TrustStore(path);
    expect(store.listPublishers()).toEqual([]);
  });
});

describe("ApprovalGate.decide", () => {
  it("returns cached approval when the same hash was previously trusted", async () => {
    const store = new TrustStore(tempTrustPath());
    const res = fakeResource("cached/tool", { network: ["x"] });
    store.approveResource(res.manifest, res.origin.uri, { network: ["x"] });

    const gate = new ApprovalGate({ trust: store });
    const decision = await gate.decide({ resource: res });
    expect(decision.approved).toBe(true);
    expect(decision.cached).toBe(true);
    expect(decision.grantedPermissions).toEqual({ network: ["x"] });
  });

  it("auto-approves resources signed by a trusted publisher", async () => {
    const store = new TrustStore(tempTrustPath());
    store.trustPublisher("ed25519:pub", "Trusted Co.");
    const res = fakeResource("signed/tool", { network: ["api.example.com"] }, "ed25519:pub");

    const handler = { requestApproval: vi.fn() };
    const gate = new ApprovalGate({ trust: store, handler });

    const decision = await gate.decide({ resource: res });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toContain("trusted publisher");
    expect(handler.requestApproval).not.toHaveBeenCalled();
    // Resource should now be cached too.
    expect(store.getTrustedResource("tool", "signed/tool", hashManifest(res.manifest))).toBeDefined();
  });

  it("denies unsigned/uncached resources when no handler is present", async () => {
    const store = new TrustStore(tempTrustPath());
    const gate = new ApprovalGate({ trust: store });
    const decision = await gate.decide({ resource: fakeResource("untrusted/tool") });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("no approval handler");
  });

  it("prompts via handler when nothing else trusts; records approval", async () => {
    const store = new TrustStore(tempTrustPath());
    const handler = {
      requestApproval: vi.fn(async () => ({ approved: true, responseTimeMs: 1 })),
    };
    const gate = new ApprovalGate({ trust: store, handler });
    const res = fakeResource("prompted/tool", { network: ["api.x"] });

    const decision = await gate.decide({ resource: res });
    expect(decision.approved).toBe(true);
    expect(decision.cached).toBe(false);
    expect(handler.requestApproval).toHaveBeenCalledOnce();
    expect(store.getTrustedResource("tool", "prompted/tool", hashManifest(res.manifest))).toBeDefined();
  });

  it("clamps requested permissions against caller permissions", async () => {
    const store = new TrustStore(tempTrustPath());
    const handler = {
      requestApproval: vi.fn(async () => ({ approved: true, responseTimeMs: 1 })),
    };
    const gate = new ApprovalGate({ trust: store, handler });
    const res = fakeResource("escalate/tool", {
      network: ["api.allowed", "api.forbidden"],
      tools: ["read", "write"],
    });
    const decision = await gate.decide({
      resource: res,
      callerPermissions: { network: ["api.allowed"], tools: ["read"] },
    });
    expect(decision.grantedPermissions).toEqual({
      network: ["api.allowed"],
      tools: ["read"],
    });
  });

  it("propagates a denied response", async () => {
    const store = new TrustStore(tempTrustPath());
    const handler = {
      requestApproval: vi.fn(async () => ({ approved: false, reason: "looks sketchy", responseTimeMs: 1 })),
    };
    const gate = new ApprovalGate({ trust: store, handler });
    const decision = await gate.decide({ resource: fakeResource("denied/tool") });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe("looks sketchy");
  });
});
