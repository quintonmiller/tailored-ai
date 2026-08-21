/**
 * `POST /api/media` and `GET /api/media/:id`.
 *
 * Upload is a separate step from sending, on purpose: the chat route already
 * streams SSE, and multipart-plus-SSE on one endpoint is a worse shape than two
 * clean ones. It also means re-sending the same screenshot costs one upload,
 * because the store is content-addressed and hands back the id it already had.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

/** PNG signature plus an IHDR, so the store's byte sniffing has something real. */
function pngBytes(): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(64, 16);
  buf.writeUInt32BE(32, 20);
  return buf;
}

let db: ReturnType<typeof initDatabase>;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let originalHome: string | undefined;

function buildConfig(mediaDir: string): AgentConfig {
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
    media: { dir: mediaDir },
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

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "media-routes-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
  const cfg = buildConfig(join(tmpDir, "media"));
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
  app = createServer({ runtime }).app;
});

afterEach(() => {
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function upload(bytes: Buffer, name = "shot.png", type = "image/png") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type }));
  const res = await app.fetch(new Request("http://t/api/media", { method: "POST", body: form }));
  return { res, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/media", () => {
  it("stores an upload and returns a content-addressed reference", async () => {
    const { res, json } = await upload(pngBytes());
    expect(res.status).toBe(200);
    expect(json.id).toMatch(/^[0-9a-f]{64}$/);
    expect(json.mimeType).toBe("image/png");
    expect(json.name).toBe("shot.png");
  });

  it("reads dimensions from the bytes", async () => {
    const { json } = await upload(pngBytes());
    expect(json.width).toBe(64);
    expect(json.height).toBe(32);
  });

  it("ignores a lying Content-Type and trusts the bytes", async () => {
    // The browser's declared type is a claim, not evidence — and it is the part
    // an attacker controls.
    const { json } = await upload(pngBytes(), "not-really.txt", "text/plain");
    expect(json.mimeType).toBe("image/png");
  });

  it("gives the same id to the same bytes uploaded twice", async () => {
    const first = await upload(pngBytes());
    const second = await upload(pngBytes());
    expect(first.json.id).toBe(second.json.id);
  });

  it("rejects a request with no file field", async () => {
    const form = new FormData();
    const res = await app.fetch(new Request("http://t/api/media", { method: "POST", body: form }));
    expect(res.status).toBe(400);
  });

  it("rejects a body that is not multipart", async () => {
    const res = await app.fetch(
      new Request("http://t/api/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/media/:id", () => {
  it("serves the exact bytes with the resolved type", async () => {
    const original = pngBytes();
    const { json } = await upload(original);
    const res = await app.fetch(new Request(`http://t/api/media/${json.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
  });

  it("marks the response immutable, since a content address cannot change", async () => {
    const { json } = await upload(pngBytes());
    const res = await app.fetch(new Request(`http://t/api/media/${json.id}`));
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("forbids content-type sniffing", async () => {
    // A stored blob must never be reinterpreted as something executable.
    const { json } = await upload(pngBytes());
    const res = await app.fetch(new Request(`http://t/api/media/${json.id}`));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a malformed id before it reaches the store", async () => {
    const res = await app.fetch(new Request("http://t/api/media/..%2F..%2Fetc%2Fpasswd"));
    expect(res.status).toBe(400);
  });

  it("404s an id the store does not hold", async () => {
    const res = await app.fetch(new Request(`http://t/api/media/${"0".repeat(64)}`));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat with media", () => {
  it("accepts a message carrying only media", async () => {
    // Requiring text would repeat the Slack bug this work exists to fix.
    const { json } = await upload(pngBytes());
    const res = await app.fetch(
      new Request("http://t/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "", mediaIds: [json.id] }),
      }),
    );
    expect(res.status).not.toBe(400);
  });

  it("still rejects a message with neither text nor media", async () => {
    const res = await app.fetch(
      new Request("http://t/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "  " }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
