/**
 * `GET /api/state/*` — reading world state over HTTP.
 *
 * The routes go through the same service an agent's tool does, so these tests
 * check the HTTP shape and the one difference that matters: a person through
 * the API sees every scope, where an agent sees only its own, its rooms', and
 * global.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
    expect(json.types).toEqual([expect.objectContaining({ name: "plan", scope: "agent", canWrite: true })]);
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
    expect(unknown.json.error).toBe('There is no state type called "plans". Types you can use: plan.');
    expect((await get("/api/state/plan?where=not-json")).status).toBe(400);
  });
});
