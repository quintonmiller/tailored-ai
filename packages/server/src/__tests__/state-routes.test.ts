/**
 * `GET /api/state/*` — reading world state over HTTP.
 *
 * The routes go through the same service an agent's tool does, so these tests
 * check the HTTP shape and the one difference that matters: a person through
 * the API sees every scope, where an agent sees only its own, its rooms', and
 * global.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase, type StateCaller } from "@tailored-ai/core";
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
    state: {
      backend: "sqlite",
      types: [
        {
          name: "plan",
          scope: "agent",
          schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        },
        {
          name: "task",
          schema: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" }, done: { type: "boolean" } },
          },
        },
      ],
    },
  };
}

const planner: StateCaller = { actor: { kind: "agent", name: "planner" } };

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "state-routes-"));
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

async function get(path: string) {
  const res = await app.fetch(new Request(`http://t${path}`));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/state", () => {
  it("lists types with whether a person may write them", async () => {
    const { status, json } = await get("/api/state/types");
    expect(status).toBe(200);
    expect(json.types).toEqual([
      expect.objectContaining({ name: "plan", scope: "agent", canWrite: true }),
      expect.objectContaining({ name: "task", canWrite: true }),
    ]);
  });

  it("shows a person a record in an agent's private scope, which other agents cannot see", async () => {
    const service = runtime.getStateService();
    await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });

    const list = await get("/api/state/plan");
    expect(list.status).toBe(200);
    expect((list.json.records as { id: string; scope: string }[]).map((r) => [r.id, r.scope])).toEqual([
      ["trip", "agent:planner"],
    ]);
    expect(await service.get({ actor: { kind: "agent", name: "reviewer" } }, { type: "plan", id: "trip" })).toBeNull();
  });

  it("filters, reads one record, and returns its history", async () => {
    const service = runtime.getStateService();
    await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
    await service.patch(planner, { type: "plan", id: "trip" }, { name: "Trip to Lisbon" });
    await service.put(planner, { type: "plan", id: "other", data: { name: "Other" } });

    const filtered = await get(
      `/api/state/plan?where=${encodeURIComponent(JSON.stringify({ name: "Trip to Lisbon" }))}`,
    );
    expect((filtered.json.records as { id: string }[]).map((r) => r.id)).toEqual(["trip"]);

    const one = await get("/api/state/plan/trip");
    expect(one.json).toMatchObject({ id: "trip", version: 2, data: { name: "Trip to Lisbon" } });

    const history = await get("/api/state/plan/trip/history");
    expect((history.json.changes as { op: string }[]).map((c) => c.op)).toEqual(["update", "create"]);
  });

  it("answers 404 for a missing record and 400 for an unknown type or malformed filter", async () => {
    expect((await get("/api/state/plan/nope")).status).toBe(404);
    const unknown = await get("/api/state/plans");
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe('There is no state type called "plans". Types you can use: plan, task.');
    expect((await get("/api/state/plan?where=not-json")).status).toBe(400);
  });
});

async function send(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("writing state over HTTP", () => {
  it("creates, replaces, changes and deletes a record, as the owner", async () => {
    const created = await send("POST", "/api/state/task", { id: "t1", data: { title: "Buy milk" } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: "t1",
      scope: "global",
      version: 1,
      updatedBy: { kind: "user", name: "owner" },
    });

    const replaced = await send("PUT", "/api/state/task/t1", { data: { title: "Buy oat milk" }, expectedVersion: 1 });
    expect(replaced.json).toMatchObject({ version: 2, data: { title: "Buy oat milk" } });

    const changed = await send("PATCH", "/api/state/task/t1", { changes: { done: true } });
    expect(changed.json).toMatchObject({ version: 3, data: { title: "Buy oat milk", done: true } });

    // Only while nobody has changed it since the version given.
    expect((await send("DELETE", "/api/state/task/t1?expectedVersion=2")).status).toBe(409);
    expect((await send("DELETE", "/api/state/task/t1?expectedVersion=two")).status).toBe(400);
    expect((await get("/api/state/task/t1")).status).toBe(200);
    expect((await send("DELETE", "/api/state/task/t1?expectedVersion=3")).status).toBe(200);
    expect((await get("/api/state/task/t1")).status).toBe(404);
    expect((await send("DELETE", "/api/state/task/t1")).status).toBe(404);

    const history = await get("/api/state/task/t1/history");
    expect((history.json.changes as { op: string; source?: unknown }[]).map((c) => [c.op, c.source])).toEqual([
      ["delete", { surface: "http" }],
      ["update", { surface: "http" }],
      ["update", { surface: "http" }],
      ["create", { surface: "http" }],
    ]);
  });

  it("generates an id when a create leaves it out", async () => {
    const created = await send("POST", "/api/state/task", { data: { title: "Call the bank" } });
    expect(created.status).toBe(201);
    expect(typeof created.json.id).toBe("string");
  });

  it("refuses a stale write and a create over an existing id with 409", async () => {
    await send("POST", "/api/state/task", { id: "t1", data: { title: "One" } });
    const again = await send("POST", "/api/state/task", { id: "t1", data: { title: "Two" } });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("task/t1 already exists (version 1).");

    const stale = await send("PATCH", "/api/state/task/t1", { changes: { done: true }, expectedVersion: 5 });
    expect(stale.status).toBe(409);
    expect((await get("/api/state/task/t1")).json).toMatchObject({ version: 1, data: { title: "One" } });
  });

  it("says what is wrong with a write that does not fit the type", async () => {
    const missing = await send("POST", "/api/state/task", { data: { done: true } });
    expect(missing.status).toBe(400);
    expect(String(missing.json.error)).toContain("title");
    expect((await send("POST", "/api/state/task", { title: "no data" })).status).toBe(400);
    expect((await send("PATCH", "/api/state/task/t1", { done: true })).status).toBe(400);
  });
});

describe("GET /api/state/events", () => {
  /** Open the stream and collect `change` events until `count` arrive or time runs out. */
  async function watch(path: string, act: () => Promise<void>, count: number) {
    const abort = new AbortController();
    const res = await app.fetch(new Request(`http://t${path}`, { signal: abort.signal }));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const changes: Record<string, unknown>[] = [];
    let buffer = "";
    let ready = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && changes.length < count) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 200),
        ),
      ]);
      if (value) buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event === "ready" && !ready) {
          ready = true;
          await act();
        }
        if (event === "change" && data) changes.push(JSON.parse(data));
      }
      if (done && !value && !ready) break;
    }
    abort.abort();
    await reader.cancel().catch(() => {});
    return { status: res.status, ready, changes };
  }

  it("streams each change as it happens, filtered by type", async () => {
    const service = runtime.getStateService();
    const { status, ready, changes } = await watch(
      "/api/state/events?type=task",
      async () => {
        await service.put(planner, { type: "plan", id: "trip", data: { name: "Trip" } });
        await send("POST", "/api/state/task", { id: "t1", data: { title: "Buy milk" } });
        await send("PATCH", "/api/state/task/t1", { changes: { done: true } });
      },
      2,
    );
    expect(status).toBe(200);
    expect(ready).toBe(true);
    expect(changes.map((c) => [c.type, c.id, c.op, c.version])).toEqual([
      ["task", "t1", "create", 1],
      ["task", "t1", "update", 2],
    ]);
  });

  it("keeps streaming after a config reload clears the runtime's bus", async () => {
    writeFileSync(
      join(tmpDir, "config.yaml"),
      [
        "providers:",
        "  openai_compatible: { baseUrl: x, defaultModel: fake }",
        "state:",
        "  backend: sqlite",
        "  types:",
        "    - { name: task }",
      ].join("\n"),
    );
    const { changes } = await watch(
      "/api/state/events",
      async () => {
        await runtime.reload();
        await send("POST", "/api/state/task", { id: "after-reload", data: { title: "Still here" } });
      },
      1,
    );
    expect(changes.map((c) => c.id)).toEqual(["after-reload"]);
  });
});
