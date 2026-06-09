/**
 * Coverage for the runtime outbound-notifier registry (#66) — the
 * channel-id-keyed lookup that replaces hand-injecting the single Discord
 * notifier into cron / autopilot / task-watcher.
 */

import { describe, expect, it } from "vitest";
import type { OutboundNotifier } from "../channels/outbound.js";
import { AgentRuntime } from "../runtime.js";

const fakeNotifier = (id: string): OutboundNotifier => ({
  id,
  send: async () => {},
  sendDM: async () => {},
});

/**
 * Prototype-shaped runtime: the registry methods only touch `this._outbound`
 * (and getPrimaryOwner → getConfig for resolveOutbound). Object.create skips
 * field initializers, so seed `_outbound` and stub getConfig explicitly.
 */
const makeRuntime = (config: unknown = { channels: {} }): AgentRuntime => {
  const r = Object.create(AgentRuntime.prototype) as AgentRuntime;
  (r as unknown as { _outbound: Map<string, OutboundNotifier> })._outbound = new Map();
  (r as unknown as { getConfig: () => unknown }).getConfig = () => config;
  return r;
};

describe("outbound registry", () => {
  it("registers and resolves a notifier by its id", () => {
    const r = makeRuntime();
    const discord = fakeNotifier("discord");
    r.registerOutbound(discord);
    expect(r.getOutbound("discord")).toBe(discord);
  });

  it("returns undefined for an unregistered channel", () => {
    const r = makeRuntime();
    expect(r.getOutbound("slack")).toBeUndefined();
  });

  it("replaces the entry when the same id re-registers (reconnect)", () => {
    const r = makeRuntime();
    const first = fakeNotifier("discord");
    const second = fakeNotifier("discord");
    r.registerOutbound(first);
    r.registerOutbound(second);
    expect(r.getOutbound("discord")).toBe(second);
    expect(r.listOutbound()).toHaveLength(1);
  });

  it("unregisters a channel (disconnect)", () => {
    const r = makeRuntime();
    r.registerOutbound(fakeNotifier("discord"));
    r.unregisterOutbound("discord");
    expect(r.getOutbound("discord")).toBeUndefined();
    expect(r.listOutbound()).toEqual([]);
  });

  it("lists all registered notifiers", () => {
    const r = makeRuntime();
    r.registerOutbound(fakeNotifier("discord"));
    r.registerOutbound(fakeNotifier("slack"));
    expect(
      r
        .listOutbound()
        .map((n) => n.id)
        .sort(),
    ).toEqual(["discord", "slack"]);
  });
});

describe("resolveOutbound", () => {
  it("uses an explicit channel id when given", () => {
    const r = makeRuntime({ channels: { discord: {}, slack: {} } });
    const slack = fakeNotifier("slack");
    r.registerOutbound(fakeNotifier("discord"));
    r.registerOutbound(slack);
    expect(r.resolveOutbound("slack")).toBe(slack);
  });

  it("falls back to the primary channel (defaultChannel) when no id is given", () => {
    const r = makeRuntime({ defaultChannel: "slack", channels: { discord: {}, slack: {} } });
    const slack = fakeNotifier("slack");
    r.registerOutbound(fakeNotifier("discord"));
    r.registerOutbound(slack);
    expect(r.resolveOutbound()).toBe(slack);
  });

  it("returns undefined when the resolved channel has no live notifier", () => {
    const r = makeRuntime({ defaultChannel: "slack", channels: { slack: {} } });
    // slack is the primary channel but never connected/registered
    expect(r.resolveOutbound()).toBeUndefined();
  });
});
