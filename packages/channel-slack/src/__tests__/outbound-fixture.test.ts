/**
 * Slack drop-in outbound delivery fixture — the last acceptance item of #66.
 *
 * `outbound-registry.test.ts` (in core) proves the registry mechanics with a
 * FAKE notifier and a prototype-shaped runtime. This file closes the loop with
 * the REAL `@tailored-ai/channel-slack` channel: it registers an actual
 * `SlackChannel` via `runtime.registerOutbound()` and proves that the
 * channel-neutral resolution path — `resolveOutbound()` (defaultChannel),
 * `getOutbound("slack")`, and `getOwnerId("slack")` — routes a delivery to
 * Slack's transport with **zero Discord-specific code**.
 *
 * The point: a non-Discord channel drops into the same outbound path cron,
 * autopilot, and the workflow engine resolve through, purely via the registry
 * + `config.defaultChannel`. Bolt is mocked so `send()` / `sendDM()` are
 * observable without hitting a real workspace.
 */
import type { AgentRuntime, OutboundNotifier } from "@tailored-ai/core";
import { AgentRuntime as AgentRuntimeClass } from "@tailored-ai/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlackChannel } from "../channel.js";

interface FakeBoltClient {
  chat: { postMessage: (args: { channel: string; text: string }) => Promise<unknown> };
  conversations: { open: (args: { users: string }) => Promise<{ channel: { id: string } }> };
  auth: { test: () => Promise<{ user_id: string }> };
}

interface FakeBoltApp {
  client: FakeBoltClient;
  __sent: { target: string; content: string }[];
  __dmOpens: string[];
}

const fakeApps: FakeBoltApp[] = [];

beforeEach(() => {
  fakeApps.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

vi.mock("@slack/bolt", () => {
  class App {
    client: FakeBoltClient;
    __sent: { target: string; content: string }[] = [];
    __dmOpens: string[] = [];

    constructor() {
      this.client = {
        chat: {
          postMessage: async ({ channel, text }) => {
            this.__sent.push({ target: channel, content: text });
            return { ok: true };
          },
        },
        conversations: {
          open: async ({ users }) => {
            this.__dmOpens.push(users);
            return { channel: { id: `D-${users}` } };
          },
        },
        auth: { test: async () => ({ user_id: "U-BOT" }) },
      };
      fakeApps.push(this as unknown as FakeBoltApp);
    }
    async start() {}
    async stop() {}
    message() {}
  }
  return { App, LogLevel: { WARN: 0 } };
});

/**
 * Prototype-shaped runtime, same approach as core's outbound-registry test:
 * the registry methods only touch `this._outbound` and `getConfig()` (via
 * getPrimaryOwner / getOwnerId). `Object.create` skips field initializers, so
 * seed `_outbound` and stub `getConfig` explicitly. This exercises the REAL
 * registerOutbound / getOutbound / resolveOutbound / getOwnerId / getPrimaryOwner
 * implementations without standing up the full constructor (db, tools, provider).
 */
function makeRuntime(config: unknown): AgentRuntime {
  const r = Object.create(AgentRuntimeClass.prototype) as AgentRuntime;
  (r as unknown as { _outbound: Map<string, OutboundNotifier> })._outbound = new Map();
  (r as unknown as { getConfig: () => unknown }).getConfig = () => config;
  // `getMediaStore()` reads `_config` directly rather than through the stubbed
  // accessor, so seed it as well — same reason `_outbound` is seeded above.
  (r as unknown as { _config: unknown })._config = config;
  return r;
}

function buildSlackChannel(runtime: AgentRuntime): SlackChannel {
  return new SlackChannel({
    runtime,
    config: {
      enabled: true,
      token: "xoxb-test",
      appToken: "xapp-test",
      owner: "U-OWNER",
      respondToDMs: true,
      respondToMentions: true,
    },
  });
}

function appForLast(): FakeBoltApp {
  const app = fakeApps.at(-1);
  if (!app) throw new Error("expected a fake Bolt App to be tracked");
  return app;
}

describe("Slack drop-in outbound delivery (#66)", () => {
  it("satisfies the OutboundNotifier contract: id 'slack' + send + sendDM", () => {
    const slack = buildSlackChannel(makeRuntime({ channels: { slack: {} } }));
    // Structural check — SlackChannel is a drop-in OutboundNotifier.
    const notifier: OutboundNotifier = slack;
    expect(notifier.id).toBe("slack");
    expect(typeof notifier.send).toBe("function");
    expect(typeof notifier.sendDM).toBe("function");
  });

  it("registers via the registry and resolves by exact channel id — no Discord", () => {
    const runtime = makeRuntime({ channels: { slack: { owner: "U-OWNER" } } });
    const slack = buildSlackChannel(runtime);

    runtime.registerOutbound(slack);

    expect(runtime.getOutbound("slack")).toBe(slack);
    expect(runtime.listOutbound().map((n) => n.id)).toEqual(["slack"]);
    expect(runtime.getOutbound("discord")).toBeUndefined();
  });

  it("resolveOutbound() falls back to defaultChannel 'slack' and routes a send to the Slack transport", async () => {
    const runtime = makeRuntime({
      defaultChannel: "slack",
      channels: { slack: { owner: "U-OWNER" } },
    });
    const slack = buildSlackChannel(runtime);
    runtime.registerOutbound(slack);

    // The channel-neutral path: no explicit id, no Discord registered.
    const sink = runtime.resolveOutbound();
    expect(sink).toBe(slack);

    await sink!.send("C-GENERAL", "hello from the registry");

    const sent = appForLast().__sent;
    expect(sent).toEqual([{ target: "C-GENERAL", content: "hello from the registry" }]);
  });

  it("getOwnerId('slack') resolves the configured Slack owner, and sendDM reaches that user", async () => {
    const runtime = makeRuntime({
      defaultChannel: "slack",
      channels: { slack: { owner: "U-OWNER" } },
    });
    const slack = buildSlackChannel(runtime);
    runtime.registerOutbound(slack);

    // Channel-neutral owner resolution defaults to the primary channel.
    expect(runtime.getOwnerId()).toBe("U-OWNER");
    expect(runtime.getOwnerId("slack")).toBe("U-OWNER");
    expect(runtime.getPrimaryOwner()).toMatchObject({ channelId: "slack", userId: "U-OWNER" });

    const owner = runtime.getOwnerId();
    await runtime.resolveOutbound()!.sendDM(owner!, "your task finished");

    const app = appForLast();
    // sendDM opens an IM with the owner, then posts to the opened channel.
    expect(app.__dmOpens).toEqual(["U-OWNER"]);
    expect(app.__sent).toEqual([{ target: "D-U-OWNER", content: "your task finished" }]);
  });
});
