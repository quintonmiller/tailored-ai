/**
 * The web transport for live sessions: start a session, post a turn, read the
 * reply back as it streams — what was heard, the words, and the audio a
 * sentence at a time — and end it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  type ChatParams,
  initDatabase,
  speechToTextRegistry,
  textToSpeechRegistry,
} from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../index.js";

const reply = "Sure thing. I noted the plants for tomorrow.";
const provider: AIProvider = {
  id: "fake",
  name: "fake",
  supportsTools: true,
  chat: async () => ({ content: reply, usage: { input: 0, output: 0 }, finishReason: "stop" }),
  async *chatStream(_params: ChatParams) {
    for (const piece of reply.match(/.{1,6}/g) ?? []) yield { type: "delta" as const, content: piece };
    yield {
      type: "done" as const,
      response: { content: reply, usage: { input: 0, output: 0 }, finishReason: "stop" as const },
    };
  },
};

function buildConfig(live: boolean): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 1000,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    agents: { talker: { instructions: "You help plan the day." } },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    live: { enabled: live, stt: { provider: "fake-stt" }, tts: { provider: "fake-tts", voice: "af_heart" } },
  } as AgentConfig;
}

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let originalHome: string | undefined;

function setup(live = true) {
  const cfg = buildConfig(live);
  runtime = new AgentRuntime(
    {
      configPath: join(tmpDir, "config.yaml"),
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: () => [],
      createProvider: () => ({ provider, model: "fake" }),
    },
    () => cfg,
    cfg,
  );
  app = createServer({ runtime }).app;
}

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "live-routes-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
  speechToTextRegistry.register("fake-stt", () => ({
    transcribe: async (audio: Buffer) => ({ text: `heard ${audio.length} bytes` }),
  }));
  textToSpeechRegistry.register("fake-tts", () => ({
    synthesize: async (text: string) => ({ bytes: Buffer.from(`audio:${text}`), mimeType: "audio/mpeg" }),
  }));
  setup();
});

afterEach(() => {
  speechToTextRegistry.unregister("fake-stt");
  textToSpeechRegistry.unregister("fake-tts");
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function json(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Post a turn and collect its events in order. */
async function turn(id: string, body: string | Uint8Array, type: string) {
  const res = await app.fetch(
    new Request(`http://t/api/live/sessions/${id}/turn`, { method: "POST", headers: { "Content-Type": type }, body }),
  );
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => ({
      event: /^event: (.*)$/m.exec(frame)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "null"),
    }));
  return { status: res.status, events };
}

describe("/api/live/sessions", () => {
  it("starts a session for an agent, with its limits", async () => {
    const res = await json("POST", "/api/live/sessions", { agent: "talker" });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ agent: "talker", transport: "web", turns: 0, limits: { maxTurns: 200 } });
  });

  it("refuses to start when live sessions are off, and says how to turn them on", async () => {
    setup(false);
    const res = await json("POST", "/api/live/sessions", {});
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("live.enabled: true");
  });

  it("streams a recorded turn back: what was heard, the words, then the audio a sentence at a time", async () => {
    const id = (await json("POST", "/api/live/sessions", { agent: "talker" })).json.id as string;
    const { status, events } = await turn(id, new Uint8Array([1, 2, 3, 4]), "audio/webm;codecs=opus");
    expect(status).toBe(200);
    expect(events[0]).toEqual({ event: "transcript", data: { text: "heard 4 bytes" } });
    const audio = events.filter((e) => e.event === "audio").map((e) => e.data);
    expect(audio.map((a) => [a.seq, a.text, a.mimeType, Buffer.from(a.data, "base64").toString()])).toEqual([
      [
        0,
        "Sure thing. I noted the plants for tomorrow.",
        "audio/mpeg",
        "audio:Sure thing. I noted the plants for tomorrow.",
      ],
    ]);
    expect(
      events
        .filter((e) => e.event === "text")
        .map((e) => e.data.delta)
        .join(""),
    ).toBe(reply);
    expect(events.at(-1)).toMatchObject({ event: "done", data: { transcript: "heard 4 bytes", reply } });
    expect((await json("GET", `/api/live/sessions/${id}`)).json.turns).toBe(1);
  });

  it("takes a typed turn too", async () => {
    const id = (await json("POST", "/api/live/sessions", {})).json.id as string;
    const { events } = await turn(id, JSON.stringify({ text: "What's on today?" }), "application/json");
    expect(events[0]).toEqual({ event: "transcript", data: { text: "What's on today?" } });
    expect(events.at(-1)?.event).toBe("done");
  });

  it("refuses an empty recording, and any turn once the session has ended", async () => {
    const id = (await json("POST", "/api/live/sessions", {})).json.id as string;
    expect((await turn(id, new Uint8Array(), "audio/webm")).status).toBe(400);
    const ended = await json("DELETE", `/api/live/sessions/${id}`);
    expect(ended.json).toMatchObject({ endReason: "it was ended" });
    const after = await turn(id, new Uint8Array([1]), "audio/webm");
    expect(after.status).toBe(409);
    expect((await json("GET", "/api/live/sessions/nope")).status).toBe(404);
  });
});
