/**
 * Stopping the server with pages open.
 *
 * A browser with the world open holds event streams (`/api/state/events`,
 * `/api/interfaces/events`), which never finish by themselves, and a plain
 * `server.close()` waits for every connection: `tai stop` waited 30 seconds
 * and was killed. These run a real server on a real port, with real
 * keep-alive connections, because that is where it went wrong.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase } from "@tailored-ai/core";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../index.js";
import { OpenStreams, type Stoppable, stopServer, untilEnded } from "../streams.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
  };
}

/** Open a stream and read until its first event: it is open, and the server knows it. */
async function open(url: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(url);
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  return reader;
}

/** Read on until the stream ends: true once it has, false if it is still going after `ms`. */
async function endsWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read().catch(() => ({ done: true as const, value: undefined })),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (next === null) return false;
    if (next.done) return true;
  }
  return false;
}

let db: ReturnType<typeof initDatabase>;
let tmpDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "stop-streams-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("stopping the server", () => {
  it("stops within a second or two with a page's event streams open, and ends them for the page", async () => {
    const cfg = buildConfig();
    const runtime = new AgentRuntime(
      {
        configPath: join(tmpDir, "config.yaml"),
        db,
        contextDir: join(tmpDir, "context"),
        kbDir: join(tmpDir, "kb"),
        createTools: () => [],
        createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
      },
      () => cfg,
      cfg,
    );
    const { start, stop } = createServer({ runtime });
    const server = start();
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // What the world keeps open: every change to world state, and every change to a card.
    const state = await open(`${base}/api/state/events`);
    const cards = await open(`${base}/api/interfaces/events`);

    const began = Date.now();
    await stop();
    const took = Date.now() - began;

    expect(took).toBeLessThan(1500);
    // The page sees its streams end, rather than a connection hanging open on a server that has gone.
    expect(await endsWithin(state, 500)).toBe(true);
    expect(await endsWithin(cards, 500)).toBe(true);
    // Stopped is stopped: a second stop has nothing to do.
    await stop();
  });

  it("gives a response that isn't a tracked stream a short grace, then closes its connection", async () => {
    const app = new Hono();
    // A long-lived response the tracker doesn't know about: a plugin's own stream, say.
    app.get(
      "/forever",
      () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("hi")) })),
    );
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    const reader = await open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/forever`);

    const began = Date.now();
    await stopServer(server as Stoppable, new OpenStreams(), 300);
    const took = Date.now() - began;

    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500);
    expect(await endsWithin(reader, 500)).toBe(true);
  });

  it("ends a stream that opens while the server is stopping, and tells each stream it has ended", async () => {
    const app = new Hono();
    const streams = new OpenStreams();
    const ran: string[] = [];
    app.get("/s", (c) =>
      streams.sse(c, async (stream, ended) => {
        ran.push("open");
        await stream.writeSSE({ data: "hi" });
        await untilEnded(ended);
        ran.push("ended");
      }),
    );
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    const reader = await open(`http://127.0.0.1:${(server.address() as AddressInfo).port}/s`);
    expect(streams.size).toBe(1);

    await stopServer(server as Stoppable, streams, 2000);

    expect(ran).toEqual(["open", "ended"]);
    expect(streams.size).toBe(0);
    expect(await endsWithin(reader, 500)).toBe(true);
    // One asked for after the end never runs.
    const late = await app.fetch(new Request("http://t/s"));
    expect(await late.text()).toBe("");
    expect(ran).toEqual(["open", "ended"]);
  });
});
