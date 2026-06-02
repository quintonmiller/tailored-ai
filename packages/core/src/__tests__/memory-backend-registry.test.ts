import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { MemoryBackend } from "../memory/interface.js";
import { resolveMemoryBackend } from "../memory/registry.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import { registerCoreBuiltins } from "../plugin-context.js";
import { Registries } from "../registries.js";
import type { AgentRuntime } from "../runtime.js";

function seeded(): Registries {
  const r = new Registries();
  registerCoreBuiltins(r.asPluginContext());
  return r;
}

function fakeRuntime(
  registries: Registries,
  memory: { backend?: Record<string, unknown> } = {},
  db?: Database.Database,
): AgentRuntime {
  const cfg = { memory } as unknown as AgentConfig;
  return { getConfig: () => cfg, db, registries } as unknown as AgentRuntime;
}

describe("memory backend registry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("ships 'builtin' as a registered factory after registerCoreBuiltins", () => {
    expect(seeded().memoryBackends.has("builtin")).toBe(true);
  });

  it("defaults to 'builtin' when memory.backend.provider is unset", async () => {
    const db = initDatabase(":memory:");
    const rt = fakeRuntime(seeded(), {}, db);
    const backend = await resolveMemoryBackend(rt);
    expect(backend.id).toBe("builtin");
    expect(backend).toBeInstanceOf(SqliteMemoryBackend);
    db.close();
  });

  it("resolves an explicit provider id registered through ctx", async () => {
    const registries = seeded();
    const fake: MemoryBackend = {
      id: "test-plugin",
      write: async () => ({ id: "x" }),
      query: async () => [],
    };
    registries.asPluginContext().memoryBackends.register("test-plugin", () => fake);
    const rt = fakeRuntime(registries, { backend: { provider: "test-plugin" } });
    const backend = await resolveMemoryBackend(rt);
    expect(backend).toBe(fake);
  });

  it("throws with the known-factory list when the provider id is unknown", async () => {
    const rt = fakeRuntime(seeded(), { backend: { provider: "does-not-exist" } });
    await expect(resolveMemoryBackend(rt)).rejects.toThrow(/does-not-exist/);
    await expect(resolveMemoryBackend(rt)).rejects.toThrow(/Known:/);
  });

  it("passes the per-provider config slice to the factory", async () => {
    const registries = seeded();
    const seen: Record<string, unknown>[] = [];
    registries.asPluginContext().memoryBackends.register("test-plugin", (_runtime, slice) => {
      seen.push(slice);
      return { id: "test-plugin", write: async () => ({ id: "x" }), query: async () => [] };
    });
    const rt = fakeRuntime(registries, {
      backend: {
        provider: "test-plugin",
        "test-plugin": { url: "https://memory.example", token: "abc" },
      },
    });
    await resolveMemoryBackend(rt);
    expect(seen).toEqual([{ url: "https://memory.example", token: "abc" }]);
  });

  it("treats a non-object slice as empty config", async () => {
    const registries = seeded();
    let received: Record<string, unknown> | undefined;
    registries.asPluginContext().memoryBackends.register("test-plugin", (_runtime, slice) => {
      received = slice;
      return { id: "test-plugin", write: async () => ({ id: "x" }), query: async () => [] };
    });
    const rt = fakeRuntime(registries, {
      backend: { provider: "test-plugin", "test-plugin": "not-an-object" },
    });
    await resolveMemoryBackend(rt);
    expect(received).toEqual({});
  });
});
