import { TEXT_ONLY_SURFACE } from "@tailored-ai/core";
import { describe, expect, it, vi } from "vitest";
import { isOutboundNotifier, syncOutboundRegistry } from "../outbound-sync.js";

describe("isOutboundNotifier", () => {
  it("accepts a structurally complete outbound channel (id + send + sendDM)", () => {
    const slackish = { id: "slack", send: async () => {}, sendDM: async () => {} };
    expect(isOutboundNotifier(slackish)).toBe(true);
  });

  it("rejects a channel missing sendDM (send-only Channel)", () => {
    const sendOnly = { id: "log", send: async () => {} };
    expect(isOutboundNotifier(sendOnly)).toBe(false);
  });

  it("rejects a non-string id", () => {
    expect(isOutboundNotifier({ id: 7, send: async () => {}, sendDM: async () => {} })).toBe(false);
  });

  it("rejects null / non-objects", () => {
    expect(isOutboundNotifier(null)).toBe(false);
    expect(isOutboundNotifier(undefined)).toBe(false);
    expect(isOutboundNotifier("discord")).toBe(false);
  });
});

function fakeChannel(id: string) {
  return {
    id,
    type: id,
    capabilities: TEXT_ONLY_SURFACE,
    send: async () => {},
    sendDM: async () => {},
    connect: async () => {},
    disconnect: async () => {},
  };
}

function fakeManager(channels: ReturnType<typeof fakeChannel>[]) {
  return { list: () => channels.map((channel) => ({ name: channel.id, channel, disconnect: async () => {} })) };
}

function fakeRuntime() {
  return {
    registerOutbound: vi.fn(),
    unregisterOutbound: vi.fn(),
  };
}

describe("syncOutboundRegistry", () => {
  it("registers a non-discord channel that satisfies OutboundNotifier", () => {
    const runtime = fakeRuntime();
    const manager = fakeManager([fakeChannel("slack")]);
    const registered = new Set<string>();

    syncOutboundRegistry(runtime, manager, registered);

    expect(runtime.registerOutbound).toHaveBeenCalledTimes(1);
    expect(runtime.registerOutbound).toHaveBeenCalledWith(expect.objectContaining({ id: "slack" }));
    expect(registered.has("slack")).toBe(true);
  });

  it("registers multiple channels (discord + slack) by id", () => {
    const runtime = fakeRuntime();
    const manager = fakeManager([fakeChannel("discord"), fakeChannel("slack")]);
    const registered = new Set<string>();

    syncOutboundRegistry(runtime, manager, registered);

    expect(runtime.registerOutbound).toHaveBeenCalledTimes(2);
    expect(registered).toEqual(new Set(["discord", "slack"]));
  });

  it("is idempotent — re-registering does nothing on the second pass", () => {
    const runtime = fakeRuntime();
    const manager = fakeManager([fakeChannel("slack")]);
    const registered = new Set<string>();

    syncOutboundRegistry(runtime, manager, registered);
    syncOutboundRegistry(runtime, manager, registered);

    expect(runtime.registerOutbound).toHaveBeenCalledTimes(1);
  });

  it("unregisters a channel that went away on the next reconcile", () => {
    const runtime = fakeRuntime();
    const registered = new Set<string>();

    // First: slack connected.
    syncOutboundRegistry(runtime, fakeManager([fakeChannel("slack")]), registered);
    expect(registered.has("slack")).toBe(true);

    // Then: slack disconnected (empty manager).
    syncOutboundRegistry(runtime, fakeManager([]), registered);
    expect(runtime.unregisterOutbound).toHaveBeenCalledWith("slack");
    expect(registered.has("slack")).toBe(false);
  });

  it("ignores channels that lack the outbound surface", () => {
    const runtime = fakeRuntime();
    const sendOnly = {
      id: "log",
      type: "log",
      capabilities: TEXT_ONLY_SURFACE,
      send: async () => {},
      connect: async () => {},
      disconnect: async () => {},
    };
    const manager = { list: () => [{ name: "log", channel: sendOnly, disconnect: async () => {} }] };

    syncOutboundRegistry(runtime, manager, new Set());

    expect(runtime.registerOutbound).not.toHaveBeenCalled();
  });
});
