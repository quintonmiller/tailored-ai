import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { loadExternalAgents } from "../external-agents.js";
import { AgentRegistry } from "../resources/agent.js";
import type { Resource, ResourceManifest, ResourceOrigin } from "../resources/interface.js";
import type { ResourceLoader } from "../resources/loader.js";
import type { AgentRuntime } from "../runtime.js";

function makeRuntimeStub(registry: AgentRegistry): AgentRuntime {
  return { getAgentRegistry: () => registry } as unknown as AgentRuntime;
}

function makeLoaderStub(loads: Record<string, Resource | Error>): ResourceLoader {
  return {
    load: async (uri: string) => {
      const v = loads[uri];
      if (!v) throw new Error(`no fixture for ${uri}`);
      if (v instanceof Error) throw v;
      return v;
    },
  } as unknown as ResourceLoader;
}

function fakeAgentResource(id: string, data: Record<string, unknown> = {}): Resource {
  const manifest: ResourceManifest = {
    kind: "agent",
    id,
    version: "1.0.0",
    description: `agent ${id}`,
    data,
  };
  const origin: ResourceOrigin = {
    scheme: "npm",
    uri: `npm:fake/${id}`,
    loadedAt: 0,
  };
  return { manifest, origin, body: null };
}

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    agent: { defaultProvider: "openai" },
    providers: { openai: { apiKey: "k", baseUrl: "u", defaultModel: "m" } },
    ...overrides,
  }) as unknown as AgentConfig;

describe("loadExternalAgents", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("returns an empty array when externalAgents is undefined", async () => {
    const registry = new AgentRegistry();
    const out = await loadExternalAgents(baseConfig(), makeRuntimeStub(registry), makeLoaderStub({}));
    expect(out).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it("registers a successfully loaded agent into the runtime registry", async () => {
    const registry = new AgentRegistry();
    const uri = "npm:fake/researcher";
    const loader = makeLoaderStub({
      [uri]: fakeAgentResource("researcher", { model: "claude-opus", temperature: 0.4 }),
    });
    const out = await loadExternalAgents(
      baseConfig({ externalAgents: [uri] } as never),
      makeRuntimeStub(registry),
      loader,
    );
    expect(out).toEqual([{ uri, ok: true, agentId: "researcher" }]);
    const def = registry.get("researcher");
    expect(def).toBeDefined();
    expect(def?.model).toBe("claude-opus");
    expect(def?.temperature).toBe(0.4);
  });

  it("continues past failures and reports them in the result", async () => {
    const registry = new AgentRegistry();
    const okUri = "npm:fake/writer";
    const badUri = "npm:fake/missing";
    const loader = makeLoaderStub({
      [okUri]: fakeAgentResource("writer"),
      [badUri]: new Error("fetch failed"),
    });
    const out = await loadExternalAgents(
      baseConfig({ externalAgents: [badUri, okUri] } as never),
      makeRuntimeStub(registry),
      loader,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ uri: badUri, ok: false, error: "fetch failed" });
    expect(out[1]).toEqual({ uri: okUri, ok: true, agentId: "writer" });
    expect(registry.get("writer")).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`failed to load ${badUri}`));
  });

  it("rejects manifests whose kind is not 'agent'", async () => {
    const registry = new AgentRegistry();
    const uri = "npm:fake/skill";
    const loader = makeLoaderStub({
      [uri]: {
        manifest: { kind: "skill", id: "fake/skill", version: "1.0.0", data: {} } as ResourceManifest,
        origin: { scheme: "npm", uri, loadedAt: 0 },
        body: null,
      },
    });
    const out = await loadExternalAgents(
      baseConfig({ externalAgents: [uri] } as never),
      makeRuntimeStub(registry),
      loader,
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toMatch(/expected manifest.kind="agent"/);
    expect(registry.list()).toEqual([]);
  });

  it("skips invalid entries (non-string)", async () => {
    const registry = new AgentRegistry();
    const out = await loadExternalAgents(
      baseConfig({ externalAgents: [{} as unknown as string, ""] } as never),
      makeRuntimeStub(registry),
      makeLoaderStub({}),
    );
    expect(out).toHaveLength(2);
    expect(out.every((r) => !r.ok)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("invalid entry"));
  });
});
