import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
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
    agents: {
      researcher: {
        description: "research stuff",
        tools: ["web_search"],
      },
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
let configPath: string;
let originalCwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "agents-routes-"));
  process.env.HOME = tmpDir;
  process.chdir(tmpDir);
  db = initDatabase(":memory:");
  const cfg = buildConfig();
  configPath = join(tmpDir, "config.yaml");
  // Seed the YAML so writeRawConfigPath has a file to round-trip.
  writeFileSync(
    configPath,
    YAML.stringify({
      agents: { researcher: { description: "research stuff", tools: ["web_search"] } },
    }),
    "utf-8",
  );
  runtime = new AgentRuntime(
    {
      configPath,
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
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

describe("agents HTTP routes (DUX4)", () => {
  it("GET /api/agents returns configured agents", async () => {
    const res = await call("GET", "/api/agents");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ researcher: { description: "research stuff" } });
  });

  it("POST /api/agents writes a new agent to config.yaml", async () => {
    const res = await call("POST", "/api/agents", {
      name: "coder",
      definition: { description: "writes code", instructions: "be helpful", temperature: 0.2 },
    });
    expect(res.status).toBe(201);
    const yaml = YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(yaml.agents.coder).toEqual({
      description: "writes code",
      instructions: "be helpful",
      temperature: 0.2,
    });
  });

  it("POST /api/agents rejects duplicate names", async () => {
    const res = await call("POST", "/api/agents", {
      name: "researcher",
      definition: { description: "dupe" },
    });
    expect(res.status).toBe(409);
  });

  it("POST /api/agents rejects invalid names", async () => {
    const res = await call("POST", "/api/agents", {
      name: "bad name!",
      definition: { description: "x" },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/agents/:name shallow-merges definition fields", async () => {
    const res = await call("PATCH", "/api/agents/researcher", {
      definition: { temperature: 0.7 },
    });
    expect(res.status).toBe(200);
    const yaml = YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(yaml.agents.researcher).toMatchObject({
      description: "research stuff",
      tools: ["web_search"],
      temperature: 0.7,
    });
  });

  it("PATCH /api/agents/:name returns 404 for unknown agents", async () => {
    const res = await call("PATCH", "/api/agents/nope", { definition: { temperature: 0.1 } });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/agents/:name removes the entry from config.yaml", async () => {
    const res = await call("DELETE", "/api/agents/researcher");
    expect(res.status).toBe(200);
    const yaml = YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(yaml.agents?.researcher).toBeUndefined();
  });

  it("DELETE /api/agents/:name returns 404 for unknown agents", async () => {
    const res = await call("DELETE", "/api/agents/nope");
    expect(res.status).toBe(404);
  });

  it("GET /api/skills returns an empty list when no skills are installed", async () => {
    const res = await call("GET", "/api/skills");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skills: [] });
  });

  it("GET /api/skills returns installed skills sorted by id", async () => {
    runtime.getSkillRegistry().registerBuiltin({
      id: "zebra/test",
      description: "z desc",
      version: "1.0.0",
      definition: { instructions: "z body", toolRefs: ["web_search"] },
    });
    runtime.getSkillRegistry().registerBuiltin({
      id: "alpha/test",
      description: "a desc",
      definition: { instructions: "a body" },
    });
    const res = await call("GET", "/api/skills");
    expect(res.status).toBe(200);
    const body = res.body as { skills: Array<{ id: string; toolRefs: string[] }> };
    expect(body.skills.map((s) => s.id)).toEqual(["alpha/test", "zebra/test"]);
    expect(body.skills[1]?.toolRefs).toEqual(["web_search"]);
  });

  it("PATCH /api/agents/:name accepts skills + skillLoading and round-trips through config.yaml", async () => {
    const res = await call("PATCH", "/api/agents/researcher", {
      definition: { skills: ["alpha/test"], skillLoading: "progressive" },
    });
    expect(res.status).toBe(200);
    const yaml = YAML.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    expect(yaml.agents.researcher).toMatchObject({
      description: "research stuff",
      tools: ["web_search"],
      skills: ["alpha/test"],
      skillLoading: "progressive",
    });
  });
});
