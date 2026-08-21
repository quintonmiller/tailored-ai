/**
 * Tests for ChannelLifecycleManager — the reconciler that #58 introduced
 * to stop hot-reload from leaving duplicate plugin channel listeners or
 * silently restarting already-running channels.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_ONLY_SURFACE } from "../channels/capabilities.js";
import type { Channel, IncomingMessage } from "../channels/interface.js";
import { ChannelLifecycleManager } from "../channels/lifecycle.js";
import { channelFactoryRegistry } from "../channels/registry.js";
import type { AgentRuntime } from "../runtime.js";

class FakeChannel implements Channel {
  readonly id: string;
  readonly type = "fake";
  readonly capabilities = TEXT_ONLY_SURFACE;
  connected = false;
  constructor(id: string) {
    this.id = id;
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  onMessage(_h: (msg: IncomingMessage) => void): void {}
  async send(_t: string, _c: string): Promise<void> {}
}

function fakeRuntime(channelsBlock: Record<string, Record<string, unknown>>): AgentRuntime {
  return { getConfig: () => ({ channels: channelsBlock }) } as unknown as AgentRuntime;
}

describe("ChannelLifecycleManager", () => {
  // Capture the factory calls so we can assert restart vs no-op.
  const factoryCalls: string[] = [];
  const channelInstances = new Map<string, FakeChannel>();
  const disconnectSpies = new Map<string, ReturnType<typeof vi.fn>>();

  beforeEach(() => {
    factoryCalls.length = 0;
    channelInstances.clear();
    disconnectSpies.clear();

    for (const id of ["alpha", "beta"]) {
      channelFactoryRegistry.register(id, async (_runtime, _cfg) => {
        factoryCalls.push(id);
        const ch = new FakeChannel(id);
        channelInstances.set(id, ch);
        const disconnect = vi.fn(async () => ch.disconnect());
        disconnectSpies.set(id, disconnect);
        await ch.connect();
        return { channel: ch, disconnect };
      });
    }
  });

  afterEach(() => {
    // Best-effort cleanup — the registry is module-global today.
    for (const id of ["alpha", "beta"]) {
      channelFactoryRegistry.unregister?.(id);
    }
  });

  it("starts only enabled channels on initial reconcile", async () => {
    const mgr = new ChannelLifecycleManager();
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: true }, beta: { enabled: false } }));
    expect(factoryCalls).toEqual(["alpha"]);
    expect(mgr.list().map((c) => c.name)).toEqual(["alpha"]);
  });

  it("is a no-op when reconciled twice with the same config (no duplicate listeners)", async () => {
    const mgr = new ChannelLifecycleManager();
    const cfg = fakeRuntime({ alpha: { enabled: true } });
    await mgr.reconcile(cfg);
    await mgr.reconcile(cfg);
    // Factory ran exactly once — the second reconcile must NOT spin up a
    // second alpha instance.
    expect(factoryCalls).toEqual(["alpha"]);
    expect(mgr.get("alpha")).toBeDefined();
  });

  it("stops channels that are removed from the config", async () => {
    const mgr = new ChannelLifecycleManager();
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: true } }));
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: false } }));
    expect(disconnectSpies.get("alpha")).toHaveBeenCalledOnce();
    expect(mgr.get("alpha")).toBeUndefined();
  });

  it("starts newly-enabled channels without restarting already-running ones", async () => {
    const mgr = new ChannelLifecycleManager();
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: true } }));
    // Initial state: alpha running once.
    expect(factoryCalls).toEqual(["alpha"]);

    // Enabling beta should leave alpha untouched and only invoke beta's factory.
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: true }, beta: { enabled: true } }));
    expect(factoryCalls).toEqual(["alpha", "beta"]);
    expect(disconnectSpies.get("alpha")).not.toHaveBeenCalled();
  });

  it("restarts a channel when its config block changes", async () => {
    const mgr = new ChannelLifecycleManager();
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: true, token: "v1" } }));
    // Capture the v1 disconnect mock before reconcile overwrites the map
    // entry with the v2 instance's disconnect.
    const v1Disconnect = disconnectSpies.get("alpha")!;
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: true, token: "v2" } }));
    // Token changed → v1 disconnected, v2 started.
    expect(v1Disconnect).toHaveBeenCalledOnce();
    expect(factoryCalls).toEqual(["alpha", "alpha"]);
  });

  it("stopAll disconnects every running channel", async () => {
    const mgr = new ChannelLifecycleManager();
    await mgr.reconcile(fakeRuntime({ alpha: { enabled: true }, beta: { enabled: true } }));
    const alphaDisc = disconnectSpies.get("alpha")!;
    const betaDisc = disconnectSpies.get("beta")!;
    await mgr.stopAll();
    expect(alphaDisc).toHaveBeenCalledOnce();
    expect(betaDisc).toHaveBeenCalledOnce();
    expect(mgr.list()).toEqual([]);
  });

  it("survives a factory throwing during reconcile", async () => {
    channelFactoryRegistry.register("crash", async () => {
      throw new Error("boom");
    });
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mgr = new ChannelLifecycleManager();
      await mgr.reconcile(fakeRuntime({ alpha: { enabled: true }, crash: { enabled: true } }));
      expect(mgr.get("alpha")).toBeDefined();
      expect(mgr.get("crash")).toBeUndefined();
      expect(consoleErr).toHaveBeenCalled();
    } finally {
      channelFactoryRegistry.unregister?.("crash");
      consoleErr.mockRestore();
    }
  });
});
