/**
 * Unit tests for the Slack channel. Network calls to Slack are out of scope —
 * those run only against a real workspace (see README for the manual smoke
 * test). What we cover here is the pure logic that doesn't need Slack:
 * message splitting and channel-factory registration.
 */
import { describe, expect, it } from "vitest";
import { channelFactoryRegistry } from "@tailored-ai/core";
import { _splitMessageForTests as splitMessage } from "../channel.js";
// Side-effect import to register the factory.
import "../index.js";

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

describe("registration side-effect", () => {
  it('registers itself as the "slack" channel factory', () => {
    expect(channelFactoryRegistry.get("slack")).toBeDefined();
  });
});
