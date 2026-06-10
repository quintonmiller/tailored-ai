import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../index.js";

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let chat: ReturnType<typeof vi.fn>;
let cfg: AgentConfig;

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
    agents: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    briefing: { enabled: false, prompt: "Brief me.", ttlMinutes: 30 },
  } as AgentConfig;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "briefing-routes-"));
  db = initDatabase(":memory:");
  cfg = buildConfig();
  chat = vi.fn(async () => ({
    content: "Good morning. Nothing needs you.",
    usage: { input: 0, output: 0 },
    finishReason: "stop" as const,
  }));
  const provider: AIProvider = { id: "fake", name: "fake", supportsTools: true, chat };
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
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method: string, path: string) {
  const res = await app.fetch(new Request(`http://t${path}`, { method }));
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json as Record<string, unknown> };
}

describe("briefing HTTP routes", () => {
  it("returns { enabled: false } with no provider call when disabled", async () => {
    const res = await call("GET", "/api/briefing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(chat).not.toHaveBeenCalled();
  });

  it("POST /refresh is also a no-op when disabled", async () => {
    const res = await call("POST", "/api/briefing/refresh");
    expect(res.body).toEqual({ enabled: false });
    expect(chat).not.toHaveBeenCalled();
  });

  it("generates once and serves a fresh cache without a second provider call", async () => {
    cfg.briefing = { enabled: true, prompt: "Brief me.", ttlMinutes: 30 };

    const first = await call("GET", "/api/briefing");
    expect(first.status).toBe(200);
    expect(first.body.enabled).toBe(true);
    expect(first.body.content).toContain("Good morning");
    expect(first.body.stale).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);

    // Second GET hits the fresh cache — no new provider call.
    const second = await call("GET", "/api/briefing");
    expect(second.body.generatedAt).toBe(first.body.generatedAt);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("POST /refresh regenerates even when the cache is fresh", async () => {
    cfg.briefing = { enabled: true, prompt: "Brief me.", ttlMinutes: 30 };

    await call("GET", "/api/briefing");
    expect(chat).toHaveBeenCalledTimes(1);

    const refreshed = await call("POST", "/api/briefing/refresh");
    expect(refreshed.body.enabled).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("regenerates when the cache goes stale (ttl 0)", async () => {
    cfg.briefing = { enabled: true, prompt: "Brief me.", ttlMinutes: 0 };

    await call("GET", "/api/briefing");
    await call("GET", "/api/briefing");
    // ttl 0 → every GET is stale → regenerated each time.
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent GETs into one provider call", async () => {
    cfg.briefing = { enabled: true, prompt: "Brief me.", ttlMinutes: 30 };
    // Make the provider call slow so both requests overlap.
    let resolveChat: (v: { content: string; usage: { input: number; output: number }; finishReason: "stop" }) => void;
    chat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveChat = resolve;
        }),
    );

    const p1 = call("GET", "/api/briefing");
    const p2 = call("GET", "/api/briefing");
    // Let both handlers reach the inflight guard.
    await new Promise((r) => setTimeout(r, 10));
    resolveChat!({ content: "shared", usage: { input: 0, output: 0 }, finishReason: "stop" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.body.content).toBe("shared");
    expect(r2.body.content).toBe("shared");
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
