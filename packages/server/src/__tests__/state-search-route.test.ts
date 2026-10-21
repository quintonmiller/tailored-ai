/**
 * `GET /api/state/search` — finding records by what they say, over HTTP.
 *
 * The route is the service's search with a person as the caller, so these
 * tests check the HTTP shape, that a person sees every scope, and that the
 * route is not read as a type called "search".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  type EmbeddingProvider,
  initDatabase,
  type StateCaller,
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

/** "stay" and "lisbon" share an axis, so a query can match by meaning with no word in common. */
function fakeEmbedder(): EmbeddingProvider {
  const axes: Record<string, number> = { stay: 0, lisbon: 0, lodging: 0, portugal: 0, dinner: 1, recipe: 1 };
  const embed = (text: string) => {
    const v = new Float32Array(3);
    v[2] = 0.05;
    for (const word of text.toLowerCase().split(/[^a-z]+/)) if (word in axes) v[axes[word]] += 1;
    return v;
  };
  return {
    id: "fake",
    name: "fake",
    defaultModel: "fake-1",
    defaultDim: 3,
    embed: async (inputs) => ({ vectors: inputs.map(embed), model: "fake-1", dim: 3 }),
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
        { name: "doc", title: "title", search: { fields: ["title", "summary"] } },
        { name: "commitment", title: "goal", scope: "agent", search: { fields: ["goal"] } },
        { name: "plan", title: "name" },
      ],
    },
  };
}

const planner: StateCaller = { actor: { kind: "agent", name: "planner" } };
const person: StateCaller = { actor: { kind: "user", name: "owner" } };

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "state-search-route-"));
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
      createEmbedder: () => fakeEmbedder(),
    },
    () => cfg,
    cfg,
  );
  app = createServer({ runtime }).app;
});

afterEach(async () => {
  await runtime.getStateService().close();
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Hit {
  record: { type: string; id: string; scope: string; archivedAt?: string };
  score: number;
  how: string;
}

async function search(query: string) {
  const res = await app.fetch(new Request(`http://t/api/state/search${query}`));
  return { status: res.status, json: (await res.json()) as { hits?: Hit[]; error?: string } };
}

describe("GET /api/state/search", () => {
  beforeEach(async () => {
    const service = runtime.getStateService();
    await service.put(person, { type: "doc", id: "lisbon", data: { title: "Where to stay in Lisbon" } });
    await service.put(person, { type: "doc", id: "dinners", data: { title: "Weeknight dinner recipes" } });
    await service.put(planner, { type: "commitment", id: "trip", data: { goal: "Find a place to stay in Lisbon" } });
    await service.put(person, { type: "plan", id: "p", data: { name: "Stay in Lisbon" } });
    await service.whenIndexed();
  });

  it("ranks by meaning, and shows a person records in an agent's private scope", async () => {
    const { status, json } = await search("?q=lodging%20portugal");
    expect(status).toBe(200);
    const hits = json.hits ?? [];
    expect(
      hits
        .slice(0, 2)
        .map((h) => `${h.record.type}/${h.record.id}`)
        .sort(),
    ).toEqual(["commitment/trip", "doc/lisbon"]);
    expect(hits.find((h) => h.record.id === "trip")?.record.scope).toBe("agent:planner");
    expect(hits.every((h) => h.how === "meaning")).toBe(true);
    // Types without `search` are never returned.
    expect(hits.some((h) => h.record.type === "plan")).toBe(false);
  });

  it("narrows to the types named, and leaves archived records out unless asked", async () => {
    await runtime.getStateService().archive(person, { type: "doc", id: "lisbon" });
    const docs = await search("?q=stay%20lisbon&types=doc");
    expect((docs.json.hits ?? []).map((h) => h.record.id)).not.toContain("lisbon");
    expect((docs.json.hits ?? []).every((h) => h.record.type === "doc")).toBe(true);

    const withArchived = await search("?q=stay%20lisbon&types=doc&includeArchived=1");
    expect(withArchived.json.hits?.[0]).toMatchObject({ record: { id: "lisbon", archivedAt: expect.any(String) } });
  });

  it("answers 400 without a query, or for a type that is not searchable", async () => {
    expect(await search("")).toEqual({ status: 400, json: { error: "Say what to look for with ?q=" } });
    const plan = await search("?q=stay&types=plan");
    expect(plan.status).toBe(400);
    expect(plan.json.error).toBe("plan records are not searchable. Searchable types: commitment, doc.");
  });

  it("caps the number of hits at the limit asked for", async () => {
    const { json } = await search("?q=lisbon&limit=1");
    expect(json.hits).toHaveLength(1);
  });
});
