import { describe, expect, it, vi } from "vitest";
import {
  createPluginContext,
  registerBuiltinMemoryBackend,
  registerBuiltinOptionalTools,
  registerCoreBuiltins,
  registerDiscordChannel,
} from "../index.js";
import type { PluginContext } from "../plugin-context.js";

function makeRecordingContext(): PluginContext & { calls: Record<string, string[]> } {
  const calls: Record<string, string[]> = {
    tools: [],
    channels: [],
    providers: [],
    embeddings: [],
    memoryBackends: [],
    taskBackends: [],
    uiProviders: [],
  };
  return {
    calls,
    tools: { register: (id) => calls.tools.push(id) as never },
    channels: { register: (id) => calls.channels.push(id) as never },
    providers: { register: (id) => calls.providers.push(id) as never },
    embeddings: { register: (id) => calls.embeddings.push(id) as never },
    memoryBackends: { register: (id) => calls.memoryBackends.push(id) as never },
    taskBackends: { register: (id) => calls.taskBackends.push(id) as never },
    uiProviders: { register: (id) => calls.uiProviders.push(id) as never },
  };
}

describe("register* built-in helpers", () => {
  it("registerBuiltinOptionalTools registers the gated tool factories", () => {
    const ctx = makeRecordingContext();
    registerBuiltinOptionalTools(ctx);
    expect(ctx.calls.tools.sort()).toEqual(["browser_mediator", "trusted_actions"]);
  });

  it("registerDiscordChannel registers the discord channel factory", () => {
    const ctx = makeRecordingContext();
    registerDiscordChannel(ctx);
    expect(ctx.calls.channels).toEqual(["discord"]);
  });

  it("registerBuiltinMemoryBackend registers the builtin memory factory", () => {
    const ctx = makeRecordingContext();
    registerBuiltinMemoryBackend(ctx);
    expect(ctx.calls.memoryBackends).toEqual(["builtin"]);
  });

  it("registerCoreBuiltins aggregates all three", async () => {
    const ctx = makeRecordingContext();
    await registerCoreBuiltins(ctx);
    expect(ctx.calls.tools.sort()).toEqual(["browser_mediator", "trusted_actions"]);
    expect(ctx.calls.channels).toEqual(["discord"]);
    expect(ctx.calls.memoryBackends).toEqual(["builtin"]);
  });
});

describe("createPluginContext bridge", () => {
  it("exposes register on every namespace", () => {
    const ctx = createPluginContext();
    expect(typeof ctx.tools.register).toBe("function");
    expect(typeof ctx.channels.register).toBe("function");
    expect(typeof ctx.providers.register).toBe("function");
    expect(typeof ctx.embeddings.register).toBe("function");
    expect(typeof ctx.memoryBackends.register).toBe("function");
    expect(typeof ctx.taskBackends.register).toBe("function");
    expect(typeof ctx.uiProviders.register).toBe("function");
  });

  it("forwards tool registration into the legacy module-scope registry", async () => {
    const ctx = createPluginContext();
    const { toolFactoryRegistry } = await import("../tools/tool-factories.js");
    const before = toolFactoryRegistry.has("ctx-bridge-tool");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctx.tools.register("ctx-bridge-tool", () => []);
    warn.mockRestore();
    expect(before).toBe(false);
    expect(toolFactoryRegistry.has("ctx-bridge-tool")).toBe(true);
    toolFactoryRegistry.unregister("ctx-bridge-tool");
  });
});
