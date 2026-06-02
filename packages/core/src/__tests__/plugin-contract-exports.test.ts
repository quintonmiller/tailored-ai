/**
 * Compile-time guard that the plugin contract types and registration helpers
 * are exported from the package barrel. A plugin author should be able to
 * import everything below from "@tailored-ai/core" without reaching into
 * internal paths. If you remove or rename any of these symbols, this test
 * will fail to compile — that's the signal to bump the major and update
 * the migration notes.
 */
import { describe, expect, it } from "vitest";
import type {
  ChannelFactory,
  EmbeddingFactory,
  ProviderFactory,
  ProviderFactoryResult,
  TaskBackendFactory,
  Tool,
  ToolContext,
  ToolFactory,
  ToolFactoryContext,
  ToolResult,
  UiProvider,
  UiProviderFactory,
  MemoryBackend,
  MemoryBackendFactory,
  MemoryContent,
  MemoryHint,
  MemoryQueryContext,
  MemoryFragment,
} from "../index.js";
import * as core from "../index.js";

describe("plugin contract — public type exports", () => {
  it("ToolContext shape is reachable from the barrel", () => {
    const ctx: ToolContext = {
      sessionId: "test",
      workingDirectory: "/tmp",
      env: {},
    };
    expect(ctx.sessionId).toBe("test");
  });

  it("ToolFactoryContext shape is reachable from the barrel", () => {
    const ctx: ToolFactoryContext = { custom: "value" };
    expect(ctx.custom).toBe("value");
  });

  it("Tool / ToolResult shapes are reachable from the barrel", () => {
    const result: ToolResult = { success: true, output: "ok" };
    const tool: Tool = {
      name: "noop",
      description: "no-op",
      parameters: {},
      async execute() {
        return result;
      },
    };
    expect(tool.name).toBe("noop");
  });

  it("ProviderFactory / ProviderFactoryResult shapes are reachable", () => {
    const result: ProviderFactoryResult = {
      provider: {} as ProviderFactoryResult["provider"],
      model: "test-model",
    };
    const _factory: ProviderFactory = () => result;
    expect(result.model).toBe("test-model");
  });

  it("EmbeddingFactory shape is reachable", () => {
    const _factory: EmbeddingFactory = () => undefined;
    expect(typeof _factory).toBe("function");
  });

  it("ChannelFactory shape is reachable", () => {
    const _factory: ChannelFactory = async () => undefined;
    expect(typeof _factory).toBe("function");
  });

  it("TaskBackendFactory shape is reachable", () => {
    const _factory: TaskBackendFactory = (() => ({})) as unknown as TaskBackendFactory;
    expect(typeof _factory).toBe("function");
  });

  it("ToolFactory shape is reachable and returns Tool[]", () => {
    const factory: ToolFactory = () => [];
    expect(factory({} as never, {} as never)).toEqual([]);
  });
});

describe("plugin contract — PluginContext + Registries surface", () => {
  it("Registries class is exported", () => {
    expect(typeof core.Registries).toBe("function");
  });

  it("registerCoreBuiltins is exported", () => {
    expect(typeof core.registerCoreBuiltins).toBe("function");
  });

  it("registerBuiltinOptionalTools is exported", () => {
    expect(typeof core.registerBuiltinOptionalTools).toBe("function");
  });

  it("registerDiscordChannel is exported", () => {
    expect(typeof core.registerDiscordChannel).toBe("function");
  });

  it("registerBuiltinMemoryBackend is exported", () => {
    expect(typeof core.registerBuiltinMemoryBackend).toBe("function");
  });

  it("registerBuiltinProviders is exported", () => {
    expect(typeof core.registerBuiltinProviders).toBe("function");
  });

  it("registerBuiltinTaskBackends is exported", () => {
    expect(typeof core.registerBuiltinTaskBackends).toBe("function");
  });

  it("resolveUiProvider is exported", () => {
    expect(typeof core.resolveUiProvider).toBe("function");
  });

  it("UiProvider / UiProviderFactory types are reachable from the barrel", () => {
    const factory: UiProviderFactory = () => {
      const ui: UiProvider = { id: "test", staticDir: "/tmp" };
      return ui;
    };
    expect(typeof factory).toBe("function");
  });

  it("resolveMemoryBackend is exported", () => {
    expect(typeof core.resolveMemoryBackend).toBe("function");
  });

  it("MemoryBackend / MemoryBackendFactory + supporting types are reachable from the barrel", () => {
    const factory: MemoryBackendFactory = () => {
      const backend: MemoryBackend = {
        id: "test",
        write: async (_c: MemoryContent, _h?: MemoryHint) => ({ id: "x" }),
        query: async (_ctx: MemoryQueryContext): Promise<MemoryFragment[]> => [],
      };
      return backend;
    };
    expect(typeof factory).toBe("function");
  });

  it("loadPlugins is exported", () => {
    expect(typeof core.loadPlugins).toBe("function");
  });
});
