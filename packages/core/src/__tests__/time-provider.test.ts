import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentConfig, DEFAULT_CONFIG } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { createPluginContext } from "../plugin-context.js";
import type { AIProvider } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import { resolveTimeProvider } from "../time/provider.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function config(time: NonNullable<AgentConfig["time"]>): AgentConfig {
  return { ...structuredClone(DEFAULT_CONFIG), time };
}

describe("time provider resolution", () => {
  it("lets a plugin supply the current instant and default timezone", () => {
    const ctx = createPluginContext();
    ctx.timeProviders.register("fixed-provider-test", () => ({
      now: () => new Date("2030-01-02T03:04:05.000Z"),
      timeZone: () => "Pacific/Honolulu",
    }));

    const time = resolveTimeProvider(config({ provider: "fixed-provider-test" }));

    expect(time.now().toISOString()).toBe("2030-01-02T03:04:05.000Z");
    expect(time.timeZone()).toBe("Pacific/Honolulu");
    expect(time.timeZoneSource).toBe("provider");
  });

  it("gives an explicit configured timezone precedence over the provider", () => {
    const ctx = createPluginContext();
    ctx.timeProviders.register("zone-precedence-test", () => ({
      now: () => new Date(0),
      timeZone: () => "Pacific/Honolulu",
    }));

    const time = resolveTimeProvider(config({ provider: "zone-precedence-test", timezone: "America/Los_Angeles" }));

    expect(time.timeZone()).toBe("America/Los_Angeles");
    expect(time.timeZoneSource).toBe("config");
  });

  it("rejects an invalid configured timezone clearly", () => {
    expect(() => resolveTimeProvider(config({ provider: "system", timezone: "Mars/Olympus_Mons" }))).toThrow(
      /Invalid time\.timezone/,
    );
  });

  it("re-resolves provider and timezone on runtime reload", () => {
    const ctx = createPluginContext();
    ctx.timeProviders.register("reload-clock-a", () => ({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      timeZone: () => "UTC",
    }));
    ctx.timeProviders.register("reload-clock-b", () => ({
      now: () => new Date("2040-01-01T00:00:00.000Z"),
      timeZone: () => "America/Los_Angeles",
    }));

    let active = config({ provider: "reload-clock-a" });
    const db = initDatabase(":memory:");
    databases.push(db);
    const provider: AIProvider = {
      name: "fake",
      chat: async () => ({ message: { role: "assistant", content: "" } }),
    } as never;
    const runtime = new AgentRuntime(
      {
        configPath: "/dev/null",
        db,
        contextDir: "/tmp",
        kbDir: "/tmp",
        createTools: () => [],
        createProvider: () => ({ provider, model: "fake" }),
      },
      () => active,
      active,
    );

    expect(runtime.getTimeProvider().now().getUTCFullYear()).toBe(2030);
    active = config({ provider: "reload-clock-b" });
    runtime.reload();

    expect(runtime.getTimeProvider().now().getUTCFullYear()).toBe(2040);
    expect(runtime.getTimeProvider().timeZone()).toBe("America/Los_Angeles");
  });
});
