/**
 * Unit tests for the Slack channel. Live Slack calls are out of scope —
 * those run only against a real workspace (see README for the manual smoke
 * test). We cover the pure logic that doesn't need Slack (message
 * splitting) and run the shared channel contract suite from
 * `@tailored-ai/core/testing` against a Bolt-mocked channel.
 */
import type { AgentRuntime, IncomingMessage } from "@tailored-ai/core";
import { runChannelContractSuite } from "@tailored-ai/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _splitMessageForTests as splitMessage, SlackChannel } from "../channel.js";
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

/**
 * Bolt is mocked at the module level — every `new App({...})` returns a fake
 * with an in-memory `client.chat.postMessage` and a `message(handler)` hook
 * the contract suite drives via `emitIncoming`.
 */
type SlackMessageHandler = (arg: { message: unknown; client: FakeBoltClient }) => void | Promise<void>;

interface FakeBoltClient {
  chat: { postMessage: (args: { channel: string; text: string; thread_ts?: string }) => Promise<unknown> };
  conversations: { open: (args: { users: string }) => Promise<{ channel: { id: string } }> };
  auth: { test: () => Promise<{ user_id: string }> };
}

interface FakeBoltApp {
  client: FakeBoltClient;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  message: (handler: SlackMessageHandler) => void;
  __sent: { target: string; content: string }[];
  __handler?: SlackMessageHandler;
  __dmOpens: string[];
}

const fakeApps: FakeBoltApp[] = [];

beforeEach(() => {
  // The stub runtime returns a partial loopOpts that crashes inside
  // runAgentLoop after the observer fires. That's by design — the contract
  // suite only asserts on observer invocation — but it logs to console.error
  // via the channel's own try/catch. Silence it here to keep test output
  // readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

vi.mock("@slack/bolt", () => {
  class App {
    client: FakeBoltClient;
    __sent: { target: string; content: string }[] = [];
    __handler?: SlackMessageHandler;
    __dmOpens: string[] = [];

    constructor() {
      const self = this;
      this.client = {
        chat: {
          postMessage: async ({ channel, text }) => {
            self.__sent.push({ target: channel, content: text });
            return { ok: true };
          },
        },
        conversations: {
          open: async ({ users }) => {
            self.__dmOpens.push(users);
            return { channel: { id: `D-${users}` } };
          },
        },
        auth: {
          test: async () => ({ user_id: "U-BOT" }),
        },
      };
      fakeApps.push(this as unknown as FakeBoltApp);
    }
    async start() {}
    async stop() {}
    message(handler: SlackMessageHandler) {
      this.__handler = handler;
    }
  }
  return { App, LogLevel: { WARN: 0 } };
});

/**
 * Minimal AgentRuntime stub. The Slack handler calls into the runtime once
 * it finishes routing — we stub just enough that runAgentLoop is a no-op so
 * the messageHandler observer still fires under the contract suite.
 */
function buildRuntimeStub(): AgentRuntime {
  return {
    findOrCreateSession: () => ({ id: "stub-session" }),
    resolveHooks: () => ({ beforeRun: [], afterRun: [] }),
    getTools: () => [],
    getProjectByName: () => null,
    buildLoopOptions: () => ({
      provider: {
        chat: async () => ({ message: { role: "assistant", content: "" }, toolCalls: [] }),
      },
      tools: [],
      systemPrompt: "",
      maxIterations: 1,
    }),
  } as unknown as AgentRuntime;
}

function buildSlackChannel(): SlackChannel {
  return new SlackChannel({
    runtime: buildRuntimeStub(),
    config: {
      enabled: true,
      token: "xoxb-test",
      appToken: "xapp-test",
      respondToDMs: true,
      respondToMentions: true,
    },
  });
}

function appFor(channel: SlackChannel): FakeBoltApp {
  // The SlackChannel pushes the most recently constructed App onto fakeApps.
  // The channel test harness builds one channel per test, so the last entry
  // belongs to the channel under test.
  const app = fakeApps.at(-1);
  if (!app) throw new Error("expected a fake Bolt App to be tracked");
  return app;
  void channel;
}

runChannelContractSuite<SlackChannel>({
  name: "slack",
  plugin,
  harness: {
    build: () => buildSlackChannel(),
    emitIncoming: async (channel, msg: IncomingMessage) => {
      const app = appFor(channel);
      if (!app.__handler) throw new Error("SlackChannel did not register a Bolt message handler in connect()");
      // Route as a DM regardless of the contract message — SlackChannel
      // re-derives `isMention` from raw text (looking for `<@U-BOT>`), so a
      // contract-shaped IncomingMessage with isMention=true but no bot tag
      // in the body would be filtered out on the mention path.
      // Fire-and-forget: the handler proceeds into runAgent after invoking
      // messageHandler, and the stub runtime's no-op runAgentLoop returns
      // promptly. Any downstream error is swallowed since the test asserts
      // only on the observer invocation.
      void app.__handler({
        message: {
          user: msg.authorId,
          text: msg.content,
          channel: msg.channelId,
          channel_type: "im",
          ts: msg.id,
        },
        client: app.client,
      });
      // Yield long enough for the handler's leading awaits (auth.test) to
      // resolve and call messageHandler before the assertion runs.
      await new Promise((r) => setImmediate(r));
    },
    drainSent: (channel) => appFor(channel).__sent.splice(0),
  },
});
