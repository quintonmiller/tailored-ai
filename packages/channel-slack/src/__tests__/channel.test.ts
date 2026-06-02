/**
 * Unit tests for the Slack channel. Network calls to Slack are out of scope —
 * those run only against a real workspace (see README for the manual smoke
 * test). What we cover here is the pure logic that doesn't need Slack:
 * message splitting and the register(ctx) contract.
 */
import { createPluginContext } from "@tailored-ai/core";
import { describe, expect, it, vi } from "vitest";
import { _splitMessageForTests as splitMessage } from "../channel.js";
import plugin from "../index.js";

describe("splitMessage", () => {
  it("returns a single chunk when below the limit", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("splits a long message on newline boundaries when possible", () => {
    const long = `${"a".repeat(2900)}\n${"b".repeat(500)}`;
    const chunks = splitMessage(long);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/^a+$/);
    expect(chunks[1]).toMatch(/^b+$/);
  });

  it("falls back to a hard split when there is no good boundary", () => {
    const long = "x".repeat(7000);
    const chunks = splitMessage(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(long);
  });
});

describe("register(ctx) contract", () => {
  it("default export is a plugin function", () => {
    expect(typeof plugin).toBe("function");
  });

  it('registers "slack" into the channels namespace when invoked with a context', () => {
    const ctx = createPluginContext();
    // createPluginContext bridges to the legacy module-scope registry while
    // the runtime-owned registries migration (PR-C) is still in flight.
    // Once that lands, this test can move to a fresh Registries instance.
    const channelsRegister = vi.spyOn(ctx.channels, "register");
    plugin(ctx);
    expect(channelsRegister).toHaveBeenCalledWith("slack", expect.any(Function));
  });
});
