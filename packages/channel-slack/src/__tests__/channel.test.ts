/**
 * Unit tests for the Slack channel. Live Slack calls are out of scope —
 * those run only against a real workspace (see README for the manual smoke
 * test). We cover the pure logic that doesn't need Slack (message
 * splitting) and run the shared channel contract suite from
 * `@tailored-ai/core/testing` against a Bolt-mocked channel.
 */
import type { AgentRuntime } from "@tailored-ai/core";
import { initDatabase } from "@tailored-ai/core";
import { runChannelContractSuite } from "@tailored-ai/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlackChannel, _splitMessageForTests as splitMessage } from "../channel.js";
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
 * with an in-memory `client.chat.postMessage` so the contract suite can
 * assert that `send()` reached the wire.
 */
type SlackMessageHandler = (arg: { message: unknown; client: FakeBoltClient }) => void | Promise<void>;

interface FakeUpload {
  channel_id?: string;
  filename?: string;
  bytes: number;
}

interface FakeBoltClient {
  chat: { postMessage: (args: { channel: string; text: string; thread_ts?: string }) => Promise<unknown> };
  conversations: { open: (args: { users: string }) => Promise<{ channel: { id: string } }> };
  auth: { test: () => Promise<{ user_id: string }> };
  files: {
    uploadV2: (args: { channel_id?: string; filename?: string; file: Buffer; thread_ts?: string }) => Promise<unknown>;
  };
}

interface FakeBoltApp {
  client: FakeBoltClient;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  message: (handler: SlackMessageHandler) => void;
  __sent: { target: string; content: string }[];
  __uploads: FakeUpload[];
  __handler?: SlackMessageHandler;
  __dmOpens: string[];
}

const fakeApps: FakeBoltApp[] = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

vi.mock("@slack/bolt", () => {
  class App {
    client: FakeBoltClient;
    __sent: { target: string; content: string }[] = [];
    __uploads: FakeUpload[] = [];
    __handler?: SlackMessageHandler;
    __dmOpens: string[] = [];

    constructor() {
      this.client = {
        chat: {
          postMessage: async ({ channel, text }) => {
            this.__sent.push({ target: channel, content: text });
            return { ok: true };
          },
        },
        files: {
          uploadV2: async ({ channel_id, filename, file }) => {
            this.__uploads.push({ channel_id, filename, bytes: file.length });
            return { ok: true };
          },
        },
        conversations: {
          open: async ({ users }) => {
            this.__dmOpens.push(users);
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
 * it finishes routing — we stub just enough that `send()` round-trips
 * through the fake Bolt client without hitting real loop code.
 */
function buildRuntimeStub(): AgentRuntime {
  return {
    findOrCreateSession: () => ({ id: "stub-session" }),
    resolveHooks: () => ({ beforeRun: [], afterRun: [] }),
    getTools: () => [],
    getProjectByName: () => null,
    // A deployment with no media configured — the common case, and the one
    // where outbound delivery must still work exactly as it did before.
    getMediaStore: () => undefined,
    // The send path reads `media.delivery` to decide attach-vs-link. An empty
    // config is the default (`auto`), which is what these tests assert.
    getConfig: () => ({}),
    // Real, in-memory: the reply path reads the message record to find what
    // media the turn produced, and a stub that cannot be queried would make
    // this suite pass for the wrong reason.
    db: initDatabase(":memory:"),
    makeSessionKey: ({
      channelId,
      userId,
      project,
    }: {
      channelId: string;
      userId: string;
      project?: { id: string };
    }) => (project ? `${channelId}:${project.id}:${userId}` : `${channelId}:${userId}`),
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

function appFor(_channel: SlackChannel): FakeBoltApp {
  // The SlackChannel pushes the most recently constructed App onto fakeApps.
  // The channel test harness builds one channel per test, so the last entry
  // belongs to the channel under test.
  const app = fakeApps.at(-1);
  if (!app) throw new Error("expected a fake Bolt App to be tracked");
  return app;
}

runChannelContractSuite<SlackChannel>({
  name: "slack",
  plugin,
  harness: {
    build: () => buildSlackChannel(),
    drainSent: (channel) => appFor(channel).__sent.splice(0),
  },
});

/**
 * Outbound media — the transport-specific half of P5b.
 *
 * The ladder itself is tested once in core (`surface-render.test.ts`). What is
 * proved here is only what Slack does with the ladder's output: text goes
 * through `chat.postMessage`, bytes go through `files.uploadV2`, and a
 * reference the store has lost degrades instead of throwing.
 */
describe("Slack outbound media", () => {
  const REF = {
    id: "b".repeat(64),
    mimeType: "image/png",
    bytes: 4,
    name: "chart.png",
  };

  function channelWithStore(store: unknown): SlackChannel {
    const runtime = buildRuntimeStub();
    (runtime as unknown as { getMediaStore: () => unknown }).getMediaStore = () => store;
    return new SlackChannel({
      runtime,
      config: { enabled: true, token: "xoxb-test", appToken: "xapp-test", respondToDMs: true, respondToMentions: true },
    });
  }

  it("posts the text and uploads the bytes", async () => {
    const bytes = Buffer.from("PNG!");
    const channel = channelWithStore({ get: async () => ({ ref: REF, bytes }), urlFor: () => undefined });

    await channel.send("C-ROOM", {
      parts: [
        { type: "text", text: "here it is" },
        { type: "media", media: REF },
      ],
    });

    const app = fakeApps.at(-1)!;
    expect(app.__sent).toEqual([{ target: "C-ROOM", content: "here it is" }]);
    expect(app.__uploads).toEqual([{ channel_id: "C-ROOM", filename: "chart.png", bytes: 4 }]);
  });

  it("still delivers the text when the blob has been swept", async () => {
    // Retention deleting an old screenshot must not silence the sentence that
    // described it.
    const channel = channelWithStore({ get: async () => undefined, urlFor: () => undefined });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await channel.send("C-ROOM", {
      parts: [
        { type: "text", text: "described it" },
        { type: "media", media: REF },
      ],
    });

    const app = fakeApps.at(-1)!;
    expect(app.__sent).toEqual([{ target: "C-ROOM", content: "described it" }]);
    expect(app.__uploads).toEqual([]);
  });

  it("degrades to a link, not silence, when there is no store at all", async () => {
    const channel = channelWithStore(undefined);

    await channel.send("C-ROOM", { parts: [{ type: "media", media: { ...REF, url: "https://cdn.test/c.png" } }] });

    const app = fakeApps.at(-1)!;
    expect(app.__uploads).toEqual([]);
    expect(app.__sent).toHaveLength(1);
    expect(app.__sent[0].content).toContain("https://cdn.test/c.png");
  });

  it("sends a plain string exactly as before", async () => {
    const channel = channelWithStore(undefined);
    await channel.send("C-ROOM", "just words");
    const app = fakeApps.at(-1)!;
    expect(app.__sent).toEqual([{ target: "C-ROOM", content: "just words" }]);
    expect(app.__uploads).toEqual([]);
  });
});
