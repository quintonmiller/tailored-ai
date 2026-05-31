import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentResourceSource,
  ManifestError,
  ResourceLoader,
  ResourceRegistry,
  validateManifest,
} from "../resources/index.js";

function makeManifestDir(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tai-res-"));
  writeFileSync(join(dir, "manifest.yaml"), content, "utf8");
  return dir;
}

describe("validateManifest", () => {
  it("accepts a minimal manifest", () => {
    const m = validateManifest({ kind: "tool", id: "my-org/foo", version: "1.0.0" });
    expect(m.kind).toBe("tool");
    expect(m.id).toBe("my-org/foo");
    expect(m.version).toBe("1.0.0");
  });

  it("defaults version when omitted", () => {
    const m = validateManifest({ kind: "prompt", id: "scratch" });
    expect(m.version).toBe("0.0.0");
  });

  it("rejects an unknown kind", () => {
    expect(() => validateManifest({ kind: "bogus", id: "x", version: "1.0.0" })).toThrow(ManifestError);
  });

  it("rejects bad id shape", () => {
    expect(() => validateManifest({ kind: "tool", id: "Bad Name", version: "1.0.0" })).toThrow(ManifestError);
  });

  it("validates permissions arrays", () => {
    const m = validateManifest({
      kind: "tool",
      id: "x",
      version: "1.0.0",
      permissions: { network: ["api.example.com"], tools: ["read"] },
    });
    expect(m.permissions?.network).toEqual(["api.example.com"]);
    expect(() => validateManifest({ kind: "tool", id: "x", version: "1.0.0", permissions: { network: [1] } })).toThrow(
      ManifestError,
    );
  });

  it("parses dependencies", () => {
    const m = validateManifest({
      kind: "skill",
      id: "x",
      version: "1.0.0",
      dependencies: [{ ref: "tool:read", range: "^1" }],
    });
    expect(m.dependencies?.[0].ref).toBe("tool:read");
  });
});

describe("ResourceRegistry", () => {
  let registry: ResourceRegistry;

  beforeEach(() => {
    registry = new ResourceRegistry();
  });

  function fakeResource(kind: any, id: string, version: string) {
    return {
      manifest: { kind, id, version },
      origin: { scheme: "file" as const, uri: `file:///${id}`, loadedAt: Date.now() },
      body: { tag: `${id}@${version}` },
    };
  }

  it("registers and retrieves by active version", () => {
    registry.register(fakeResource("tool", "foo", "1.0.0"));
    const got = registry.get({ kind: "tool", id: "foo" });
    expect(got?.manifest.version).toBe("1.0.0");
  });

  it("returns latest as active when multiple versions registered", () => {
    registry.register(fakeResource("tool", "foo", "1.0.0"));
    registry.register(fakeResource("tool", "foo", "1.1.0"));
    expect(registry.get({ kind: "tool", id: "foo" })?.manifest.version).toBe("1.1.0");
    expect(registry.get({ kind: "tool", id: "foo", version: "1.0.0" })?.manifest.version).toBe("1.0.0");
  });

  it("setActiveVersion pins lookups", () => {
    registry.register(fakeResource("tool", "foo", "1.0.0"));
    registry.register(fakeResource("tool", "foo", "1.1.0"));
    registry.setActiveVersion({ kind: "tool", id: "foo", version: "1.0.0" });
    expect(registry.get({ kind: "tool", id: "foo" })?.manifest.version).toBe("1.0.0");
  });

  it("emits register/replace/unregister events", () => {
    const events: string[] = [];
    registry.on((e) => events.push(`${e.type}:${e.id}@${e.version}`));
    registry.register(fakeResource("tool", "foo", "1.0.0"));
    registry.register(fakeResource("tool", "foo", "1.0.0")); // replacement
    registry.unregister({ kind: "tool", id: "foo", version: "1.0.0" });
    expect(events).toEqual(["registered:foo@1.0.0", "replaced:foo@1.0.0", "unregistered:foo@1.0.0"]);
  });

  it("unregistering active version reassigns active", () => {
    registry.register(fakeResource("tool", "foo", "1.0.0"));
    registry.register(fakeResource("tool", "foo", "1.1.0"));
    registry.unregister({ kind: "tool", id: "foo", version: "1.1.0" });
    expect(registry.get({ kind: "tool", id: "foo" })?.manifest.version).toBe("1.0.0");
  });

  it("listens across kinds", () => {
    registry.register(fakeResource("tool", "a", "1.0.0"));
    registry.register(fakeResource("provider", "b", "1.0.0"));
    expect(registry.list("tool").length).toBe(1);
    expect(registry.list("provider").length).toBe(1);
    expect(registry.list().length).toBe(2);
  });
});

describe("ResourceLoader (file://)", () => {
  it("loads a manifest from disk and runs the resolver", async () => {
    const dir = makeManifestDir(`kind: prompt\nid: my/test\nversion: 1.2.3\nentrypoint: ./prompt.md\n`);
    writeFileSync(join(dir, "prompt.md"), "hello world");
    const loader = new ResourceLoader({
      resolvers: {
        prompt: async ({ rootPath, manifest }) => {
          return { text: `${manifest.id}@${manifest.version} from ${rootPath}` };
        },
      },
    });
    const res = await loader.load(`file://${dir}`);
    expect(res.manifest.kind).toBe("prompt");
    expect(res.manifest.id).toBe("my/test");
    expect(res.origin.scheme).toBe("file");
    expect((res.body as any).text).toContain("my/test@1.2.3");
  });

  it("accepts a bare absolute path as file://", async () => {
    const dir = makeManifestDir(`kind: tool\nid: bare/path\nversion: 0.1.0\n`);
    const loader = new ResourceLoader();
    const res = await loader.load(dir);
    expect(res.manifest.id).toBe("bare/path");
    expect(res.origin.scheme).toBe("file");
  });

  it("throws when manifest is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tai-res-empty-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    const loader = new ResourceLoader();
    await expect(loader.load(`file://${dir}`)).rejects.toThrow(/no SKILL\.md or manifest\.yaml/);
  });
});

describe("AgentResourceSource", () => {
  it("round-trips a published manifest via the loader", async () => {
    const agent = new AgentResourceSource();
    const loader = new ResourceLoader({ sources: [agent] });
    const uri = agent.publish({
      sessionId: "sess-1",
      manifest: { kind: "tool", id: "ephemeral/foo", version: "1.0.0" },
      rootPath: "/tmp/agent-foo",
    });
    expect(uri).toBe("agent://sess-1/tool:ephemeral/foo@1.0.0");
    const res = await loader.load(uri);
    expect(res.manifest.id).toBe("ephemeral/foo");
    expect(res.origin.authoringSessionId).toBe("sess-1");
  });

  it("revoke removes the entry", async () => {
    const agent = new AgentResourceSource();
    const loader = new ResourceLoader({ sources: [agent] });
    const uri = agent.publish({
      sessionId: "s",
      manifest: { kind: "prompt", id: "p", version: "1.0.0" },
      rootPath: "/tmp/p",
    });
    expect(agent.revoke(uri)).toBe(true);
    await expect(loader.load(uri)).rejects.toThrow(/not found/);
  });
});
