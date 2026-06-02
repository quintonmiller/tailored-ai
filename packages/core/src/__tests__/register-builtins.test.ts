import { describe, expect, it } from "vitest";
import {
  Registries,
  registerBuiltinMemoryBackend,
  registerBuiltinOptionalTools,
  registerBuiltinProviders,
  registerBuiltinTaskBackends,
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

  it("registerBuiltinProviders registers openai/openai_compatible/anthropic + embeddings", () => {
    const ctx = makeRecordingContext();
    registerBuiltinProviders(ctx);
    expect(ctx.calls.providers.sort()).toEqual(["anthropic", "openai", "openai_compatible"]);
    expect(ctx.calls.embeddings).toEqual(["openai_compatible"]);
  });

  it("registerBuiltinTaskBackends registers native/github/beans/beads", () => {
    const ctx = makeRecordingContext();
    registerBuiltinTaskBackends(ctx);
    expect(ctx.calls.taskBackends.sort()).toEqual(["beads", "beans", "github", "native"]);
  });

  it("registerCoreBuiltins aggregates everything", () => {
    const ctx = makeRecordingContext();
    registerCoreBuiltins(ctx);
    expect(ctx.calls.tools.sort()).toEqual(["browser_mediator", "trusted_actions"]);
    expect(ctx.calls.channels).toEqual(["discord"]);
    expect(ctx.calls.memoryBackends).toEqual(["builtin"]);
    expect(ctx.calls.providers.sort()).toEqual(["anthropic", "openai", "openai_compatible"]);
    expect(ctx.calls.embeddings).toEqual(["openai_compatible"]);
    expect(ctx.calls.taskBackends.sort()).toEqual(["beads", "beans", "github", "native"]);
  });
});

describe("Registries bundle", () => {
  it("starts empty and accumulates registrations through asPluginContext", () => {
    const registries = new Registries();
    expect(registries.tools.list()).toEqual([]);
    registries.asPluginContext().tools.register("foo", () => []);
    expect(registries.tools.has("foo")).toBe(true);
  });

  it("registerCoreBuiltins seeds providers + memory + tools + channels + tasks", () => {
    const registries = new Registries();
    registerCoreBuiltins(registries.asPluginContext());
    expect(registries.providers.list().sort()).toEqual(["anthropic", "openai", "openai_compatible"]);
    expect(registries.memoryBackends.has("builtin")).toBe(true);
    expect(registries.taskBackends.list().sort()).toEqual(["beads", "beans", "github", "native"]);
    expect(registries.channels.has("discord")).toBe(true);
    expect(registries.tools.list().sort()).toEqual(["browser_mediator", "trusted_actions"]);
  });

  it("two Registries are isolated — no cross-contamination", () => {
    const a = new Registries();
    const b = new Registries();
    a.asPluginContext().tools.register("only-a", () => []);
    expect(a.tools.has("only-a")).toBe(true);
    expect(b.tools.has("only-a")).toBe(false);
  });
});
