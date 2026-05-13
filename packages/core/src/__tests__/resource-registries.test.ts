import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  ToolRegistry,
} from "../resources/index.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import type { AIProvider } from "../providers/interface.js";

function fakeTool(name: string, output = "ok"): Tool {
  let destroyed = 0;
  return {
    name,
    description: `fake tool ${name}`,
    parameters: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output };
    },
    async destroy() {
      destroyed += 1;
    },
    // expose destroyed count for asserts
    // @ts-expect-error attaching test-only property
    _destroyed: () => destroyed,
  };
}

function fakeProvider(id: string): AIProvider {
  return {
    id,
    name: `fake-${id}`,
    supportsTools: false,
    async chat() {
      return { content: "ok", usage: { input: 1, output: 1 }, finishReason: "stop" as const };
    },
  };
}

describe("ToolRegistry", () => {
  it("registers built-ins and lists them", () => {
    const reg = new ToolRegistry();
    reg.registerBuiltin(fakeTool("read"));
    reg.registerBuiltin(fakeTool("write"));
    expect(reg.list().length).toBe(2);
    expect(reg.getByName("read")?.name).toBe("read");
  });

  it("getByName scans across versions/origins", () => {
    const reg = new ToolRegistry();
    reg.registerBuiltin(fakeTool("greet", "hi"));
    expect(reg.getByName("greet")).toBeDefined();
  });

  it("rejects non-tool resources", () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "provider", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: fakeTool("x") as unknown as Tool,
      }),
    ).toThrow(/expected manifest\.kind="tool"/);
  });

  it("destroyAll calls destroy() on every tool", async () => {
    const reg = new ToolRegistry();
    const t = fakeTool("a");
    reg.registerBuiltin(t);
    await reg.destroyAll();
    // @ts-expect-error attaching test-only property
    expect(t._destroyed()).toBe(1);
  });

  it("listWithManifests pairs tool + manifest", () => {
    const reg = new ToolRegistry();
    reg.registerBuiltin(fakeTool("memory"));
    const items = reg.listWithManifests();
    expect(items[0].manifest.kind).toBe("tool");
    expect(items[0].tool.name).toBe("memory");
    expect(items[0].origin.uri).toContain("builtin:tool/memory");
  });
});

describe("ProviderRegistry", () => {
  it("registers built-in providers and looks them up by id", () => {
    const reg = new ProviderRegistry();
    reg.registerBuiltin({ id: "openai", provider: fakeProvider("openai"), defaultModel: "gpt-4" });
    reg.registerBuiltin({ id: "anthropic", provider: fakeProvider("anthropic"), defaultModel: "claude-3" });
    expect(reg.get("openai")?.defaultModel).toBe("gpt-4");
    expect(reg.list().map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
  });

  it("rejects mis-kinded resources", () => {
    const reg = new ProviderRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: { provider: fakeProvider("p"), defaultModel: "m" },
      }),
    ).toThrow(/expected manifest\.kind="provider"/);
  });
});
