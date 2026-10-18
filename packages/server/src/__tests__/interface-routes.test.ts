/**
 * `/api/interfaces` — a component's state, and a person answering it.
 *
 * A `reply` answer comes back as the text the chat sends as the person's next
 * message; an `event` answer is announced on the runtime bus. A second answer,
 * or one to a component that does not exist, gets a status and a sentence.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  buildComponent,
  initDatabase,
  interfaceStoreFor,
} from "@tailored-ai/core";
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

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "interface-routes-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
  const cfg = buildConfig();
  runtime = new AgentRuntime(
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

function send(kind: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const spec = buildComponent({ kind, props, ...extra });
  interfaceStoreFor(db).create(spec, "planner", "s1");
  return spec;
}

async function call(path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(
      `http://t${path}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    ),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("/api/interfaces", () => {
  it("reports several components' state at once", async () => {
    const a = send("confirm", { summary: "A?" });
    const b = send("confirm", { summary: "B?" });
    const { status, json } = await call(`/api/interfaces?ids=${a.id},${b.id},c-missing`);
    expect(status).toBe(200);
    expect((json.components as { id: string; status: string }[]).map((c) => [c.id, c.status]).sort()).toEqual(
      [
        [a.id, "open"],
        [b.id, "open"],
      ].sort(),
    );
  });

  it("answers a choice with the text the chat sends next, then refuses a second answer", async () => {
    const c = send("choice", { question: "Which day?", options: ["Monday", "Tuesday"] });
    const first = await call(`/api/interfaces/${c.id}/respond`, { actionId: "option-1" });
    expect(first).toEqual({ status: 200, json: { effect: "reply", reply: "Monday" } });

    const second = await call(`/api/interfaces/${c.id}/respond`, { actionId: "option-2" });
    expect(second).toEqual({ status: 409, json: { error: "This has already been answered." } });

    const state = await call(`/api/interfaces/${c.id}`);
    expect(state.json).toMatchObject({ status: "answered", response: { actionId: "option-1", by: "owner" } });
  });

  it("announces an event action on the runtime bus", async () => {
    const seen: unknown[] = [];
    runtime.events.on("interface.action", (p) => {
      seen.push(p);
    });
    const card = send(
      "card",
      { title: "Disk full" },
      { actions: [{ label: "Page me", effect: "event", name: "escalate" }] },
    );
    const res = await call(`/api/interfaces/${card.id}/respond`, { actionId: "a1" });
    expect(res).toEqual({ status: 200, json: { effect: "event" } });
    expect(seen).toEqual([expect.objectContaining({ componentId: card.id, name: "escalate", agent: "planner" })]);
  });

  it("answers 404 for a component that does not exist and 400 without an action", async () => {
    expect((await call("/api/interfaces/c-nope")).status).toBe(404);
    expect((await call("/api/interfaces/c-nope/respond", { actionId: "x" })).status).toBe(404);
    const c = send("confirm", { summary: "Go?" });
    expect((await call(`/api/interfaces/${c.id}/respond`, {})).status).toBe(400);
  });
});
