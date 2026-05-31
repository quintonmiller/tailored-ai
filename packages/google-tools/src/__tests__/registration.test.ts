import { toolFactoryRegistry } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";

// Importing the package's index runs the side-effect registrations.
import "../index.js";

describe("@tailored-ai/google-tools side-effect registrations", () => {
  it("registers a tool factory for gmail", () => {
    expect(toolFactoryRegistry.has("gmail")).toBe(true);
  });

  it("registers a tool factory for google_calendar", () => {
    expect(toolFactoryRegistry.has("google_calendar")).toBe(true);
  });

  it("registers a tool factory for google_drive", () => {
    expect(toolFactoryRegistry.has("google_drive")).toBe(true);
  });

  it("factory returns empty array when config is disabled", () => {
    const factory = toolFactoryRegistry.get("gmail");
    if (!factory) throw new Error("gmail factory missing");
    const tools = factory({ tools: {} } as never, {});
    expect(tools).toEqual([]);
  });

  it("factory warns and returns empty when enabled but account is missing", () => {
    const factory = toolFactoryRegistry.get("google_calendar");
    if (!factory) throw new Error("google_calendar factory missing");
    const tools = factory({ tools: { google_calendar: { enabled: true } } } as never, {});
    expect(tools).toEqual([]);
  });

  it("factory constructs the tool when config is fully populated", () => {
    const factory = toolFactoryRegistry.get("gmail");
    if (!factory) throw new Error("gmail factory missing");
    const tools = factory({ tools: { gmail: { enabled: true, account: "user@example.com" } } } as never, {});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("gmail");
  });
});
