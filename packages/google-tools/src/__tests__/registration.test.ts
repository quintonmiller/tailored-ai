import { createPluginContext } from "@tailored-ai/core";
import type { ToolFactory } from "@tailored-ai/core";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

/**
 * Captures the factories the plugin registered into a PluginContext so the
 * per-factory behavior tests can call them directly.
 */
function captureFactories(): Map<string, ToolFactory> {
  const ctx = createPluginContext();
  const captured = new Map<string, ToolFactory>();
  vi.spyOn(ctx.tools, "register").mockImplementation((id: string, factory: ToolFactory) => {
    captured.set(id, factory);
  });
  plugin(ctx);
  return captured;
}

describe("@tailored-ai/google-tools register(ctx) contract", () => {
  it("default export is a plugin function", () => {
    expect(typeof plugin).toBe("function");
  });

  it("registers a tool factory for gmail", () => {
    expect(captureFactories().has("gmail")).toBe(true);
  });

  it("registers a tool factory for google_calendar", () => {
    expect(captureFactories().has("google_calendar")).toBe(true);
  });

  it("registers a tool factory for google_drive", () => {
    expect(captureFactories().has("google_drive")).toBe(true);
  });

  it("gmail factory returns empty array when config is disabled", () => {
    const factory = captureFactories().get("gmail")!;
    expect(factory({ tools: {} } as never, {} as never)).toEqual([]);
  });

  it("google_calendar factory warns and returns empty when enabled but account is missing", () => {
    const factory = captureFactories().get("google_calendar")!;
    const tools = factory({ tools: { google_calendar: { enabled: true } } } as never, {} as never);
    expect(tools).toEqual([]);
  });

  it("gmail factory constructs the tool when config is fully populated", () => {
    const factory = captureFactories().get("gmail")!;
    const tools = factory(
      { tools: { gmail: { enabled: true, account: "user@example.com" } } } as never,
      {} as never,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("gmail");
  });
});
