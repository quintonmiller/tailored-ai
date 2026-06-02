import { Registries } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";

import plugin from "../index.js";

function loadPlugin() {
  const registries = new Registries();
  plugin(registries.asPluginContext());
  return registries;
}

describe("@tailored-ai/google-tools register(ctx)", () => {
  it("registers a tool factory for gmail", () => {
    expect(loadPlugin().tools.has("gmail")).toBe(true);
  });

  it("registers a tool factory for google_calendar", () => {
    expect(loadPlugin().tools.has("google_calendar")).toBe(true);
  });

  it("registers a tool factory for google_drive", () => {
    expect(loadPlugin().tools.has("google_drive")).toBe(true);
  });

  it("factory returns empty array when config is disabled", () => {
    const registries = loadPlugin();
    const factory = registries.tools.get("gmail");
    if (!factory) throw new Error("gmail factory missing");
    const tools = factory({ tools: {} } as never, {});
    expect(tools).toEqual([]);
  });

  it("factory warns and returns empty when enabled but account is missing", () => {
    const registries = loadPlugin();
    const factory = registries.tools.get("google_calendar");
    if (!factory) throw new Error("google_calendar factory missing");
    const tools = factory({ tools: { google_calendar: { enabled: true } } } as never, {});
    expect(tools).toEqual([]);
  });

  it("factory constructs the tool when config is fully populated", () => {
    const registries = loadPlugin();
    const factory = registries.tools.get("gmail");
    if (!factory) throw new Error("gmail factory missing");
    const tools = factory({ tools: { gmail: { enabled: true, account: "user@example.com" } } } as never, {});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("gmail");
  });
});
