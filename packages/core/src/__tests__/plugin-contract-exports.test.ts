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
  Guardrail,
  GuardrailContext,
  GuardrailFactory,
  GuardrailVerdict,
  MemoryBackend,
  MemoryBackendFactory,
  MemoryContent,
  MemoryFragment,
  MemoryHint,
  MemoryQueryContext,
  ProviderFactory,
  ProviderFactoryResult,
  TaskBackendFactory,
  TimeProvider,
  TimeProviderFactory,
  Tool,
  ToolContext,
  ToolFactory,
  ToolFactoryContext,
  ToolResult,
  UiProvider,
  UiProviderFactory,
  WatcherKind,
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

describe("plugin contract — public register* helpers", () => {
  it("registerToolFactory is exported", () => {
    expect(typeof core.registerToolFactory).toBe("function");
  });

  it("registerChannelFactory is exported", () => {
    expect(typeof core.registerChannelFactory).toBe("function");
  });

  it("registerProviderFactory is exported", () => {
    expect(typeof core.registerProviderFactory).toBe("function");
  });

  it("registerEmbeddingFactory is exported", () => {
    expect(typeof core.registerEmbeddingFactory).toBe("function");
  });

  it("registerTaskBackendFactory is exported", () => {
    expect(typeof core.registerTaskBackendFactory).toBe("function");
  });

  it("registerUiProviderFactory is exported", () => {
    expect(typeof core.registerUiProviderFactory).toBe("function");
  });

  it("time provider registration and contract are reachable from the barrel", () => {
    const factory: TimeProviderFactory = () => {
      const provider: TimeProvider = { now: () => new Date(0), timeZone: () => "UTC" };
      return provider;
    };
    expect(typeof factory).toBe("function");
    expect(typeof core.registerTimeProviderFactory).toBe("function");
    expect(typeof core.resolveTimeProvider).toBe("function");
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

  it("registerMemoryBackendFactory is exported", () => {
    expect(typeof core.registerMemoryBackendFactory).toBe("function");
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

describe("plugin contract — guardrails", () => {
  it("a plugin can write a guardrail and register it from the barrel", () => {
    const factory: GuardrailFactory = (options) => ({
      id: "no-shouting",
      check(text: string, ctx: GuardrailContext): GuardrailVerdict {
        const limit = Number(options.maxCaps ?? 3);
        const caps = (text.match(/[A-Z]/g) ?? []).length;
        return caps > limit ? { ok: false, reason: `${ctx.agent} shouted` } : { ok: true };
      },
    });
    const guard: Guardrail = factory({ maxCaps: 1 });
    const dispose = core.registerGuardrail("no-shouting", factory);
    try {
      expect(core.guardrailRegistry.has("no-shouting")).toBe(true);
      expect(guard.check("HELLO", { agent: "a", surface: "room" })).toEqual({ ok: false, reason: "a shouted" });
    } finally {
      dispose();
    }
    expect(core.guardrailRegistry.has("no-shouting")).toBe(false);
  });
});

describe("plugin contract — world state", () => {
  it("a plugin can register a state provider and a type, and both go away when disposed", async () => {
    const ctx = core.createPluginContext({});
    const store = new Map<string, core.StateRecord>();
    const provider: core.StateProvider = {
      id: "memory",
      async get(ref) {
        return store.get(`${ref.type}/${ref.id}`) ?? null;
      },
      async query(q) {
        return [...store.values()].filter((r) => r.type === q.type);
      },
      async put(write) {
        const previous = store.get(`${write.type}/${write.id}`);
        const at = new Date(0).toISOString();
        const record: core.StateRecord = {
          type: write.type,
          id: write.id,
          scope: write.scope,
          data: write.data,
          version: (previous?.version ?? 0) + 1,
          createdAt: previous?.createdAt ?? at,
          updatedAt: at,
          updatedBy: write.actor,
        };
        store.set(`${write.type}/${write.id}`, record);
        return previous ? { record, previous } : { record };
      },
    };
    const disposeProvider = ctx.stateProviders.register("memory", () => provider);
    const disposeType = ctx.stateTypes.register({ name: "bookmark", provider: "memory" });
    try {
      const service = new core.StateService({ getConfig: () => ({ state: { backend: "sqlite" } }) });
      const caller: core.StateCaller = { actor: { kind: "plugin", name: "bookmarks" } };
      await service.put(caller, { type: "bookmark", id: "tai", data: { url: "https://example.com" } });
      expect(store.get("bookmark/tai")?.data).toEqual({ url: "https://example.com" });
    } finally {
      disposeProvider();
      disposeType();
    }
    expect(core.stateProviderRegistry.has("memory")).toBe(false);
    expect(core.stateTypeRegistry.has("bookmark")).toBe(false);
  });
});

describe("plugin contract — interface component kinds", () => {
  it("a plugin can add a kind through its context, and it goes away when disposed", () => {
    const ctx = core.createPluginContext({});
    const dispose = ctx.componentKinds.register({
      kind: "rating",
      description: "Rate something out of five.",
      schema: { type: "object", required: ["subject"], properties: { subject: { type: "string" } } },
      defaultActions: () => [{ id: "r5", label: "5", effect: { kind: "reply" } }],
      fallback: (props) => `Rate ${String(props.subject)}.`,
    });
    try {
      const spec = core.buildComponent({ kind: "rating", id: "r-1", props: { subject: "the hotel" } });
      expect(spec.fallback).toBe("[rating r-1] Rate the hotel.");
    } finally {
      dispose();
    }
    expect(core.componentKindRegistry.has("rating")).toBe(false);
  });
});

describe("plugin contract — watcher kinds", () => {
  it("a plugin can bring a kind through its context, and a runner can find it the same way", () => {
    const ctx = core.createPluginContext({});
    const page: WatcherKind<{ url: string }, { hash: string }> = {
      kind: "page_hash",
      description: "Whether a page's text changed.",
      schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
      defaultEvery: "1h",
      minEvery: "15m",
      check: (_config, previous) => ({
        snapshot: { hash: "b" },
        ...(previous && previous.hash !== "b" ? { change: "The page changed." } : {}),
      }),
    };
    const dispose = ctx.watcherKinds.register(page);
    try {
      expect(ctx.watcherKinds.get("page_hash")).toBe(page);
      expect(core.validateWatchConfig(page, { url: "https://example.com" })).toEqual([]);
      expect(core.watchInterval(page, "5m")).toEqual({ ms: 15 * 60_000, raisedFrom: 5 * 60_000 });
      expect(core.watcherResult({ snapshot: { hash: "b" }, change: "The page changed." }, { hash: "a" }).change).toBe(
        "The page changed.",
      );
    } finally {
      dispose();
    }
    expect(core.watcherKindRegistry.has("page_hash")).toBe(false);
  });
});
