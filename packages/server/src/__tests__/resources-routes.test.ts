import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  };
}

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;
let originalCwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "res-routes-"));
  // Redirect TrustStore's ~/.tailored-ai/trust.json into the tmp dir.
  process.env.HOME = tmpDir;
  process.chdir(tmpDir);
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

function writeSkillFixture(name: string, version = "1.0.0"): string {
  const dir = join(tmpDir, `fixture-${name.replace(/[^a-z0-9]/gi, "-")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.yaml"),
    `kind: skill\nid: ${name}\nversion: ${version}\ndescription: "test skill"\n`,
    "utf8",
  );
  return dir;
}

describe("resources HTTP routes", () => {
  it("GET /api/resources returns an empty list when no lockfile exists", async () => {
    const res = await call("GET", "/api/resources");
    expect(res.status).toBe(200);
    const body = res.body as { resources: unknown[]; lockfilePath: string };
    expect(body.resources).toEqual([]);
    expect(body.lockfilePath).toContain("tai.lock");
  });

  it("POST /api/resources/install returns 409 needs_approval for untrusted source", async () => {
    const dir = writeSkillFixture("acme/widget");
    const res = await call("POST", "/api/resources/install", { uri: dir });
    expect(res.status).toBe(409);
    const body = res.body as { mode: string; resource: { manifest: { id: string } } };
    expect(body.mode).toBe("needs_approval");
    expect(body.resource.manifest.id).toBe("acme/widget");
  });

  it("POST /api/resources/install with approve=true installs + records trust + writes lockfile + registers in runtime", async () => {
    const dir = writeSkillFixture("acme/widget");
    const res = await call("POST", "/api/resources/install", { uri: dir, approve: true });
    expect(res.status).toBe(200);
    const body = res.body as { mode: string };
    expect(body.mode).toBe("approved");

    const list = await call("GET", "/api/resources");
    expect(list.status).toBe(200);
    const listed = (list.body as { resources: Array<{ id: string }> }).resources;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("acme/widget");

    // The skill should now be reachable from the live SkillRegistry — that's
    // what makes it usable from an agent's `skills: [...]` list.
    expect(runtime.getSkillRegistry().get("acme/widget")).toBeDefined();

    // Re-install of the same hash auto-approves (cached).
    const again = await call("POST", "/api/resources/install", { uri: dir });
    expect(again.status).toBe(200);
    expect((again.body as { mode: string }).mode).toBe("cached");
  });

  it("DELETE /api/resources/:kind/:id also unregisters from the runtime", async () => {
    const dir = writeSkillFixture("acme/widget");
    await call("POST", "/api/resources/install", { uri: dir, approve: true });
    expect(runtime.getSkillRegistry().get("acme/widget")).toBeDefined();
    await call("DELETE", "/api/resources/skill/acme/widget");
    expect(runtime.getSkillRegistry().get("acme/widget")).toBeUndefined();
  });

  it("DELETE /api/resources/:kind/:id removes the entry", async () => {
    const dir = writeSkillFixture("acme/widget");
    await call("POST", "/api/resources/install", { uri: dir, approve: true });
    const del = await call("DELETE", "/api/resources/skill/acme/widget");
    expect(del.status).toBe(200);
    const list = await call("GET", "/api/resources");
    expect((list.body as { resources: unknown[] }).resources).toHaveLength(0);
  });

  it("DELETE /api/resources/:kind/:id returns 404 when the entry does not exist", async () => {
    const res = await call("DELETE", "/api/resources/skill/nonexistent/x");
    expect(res.status).toBe(404);
  });

  it("GET /api/resources/:kind/:id returns 404 for unknown resources", async () => {
    const res = await call("GET", "/api/resources/skill/unknown/x");
    expect(res.status).toBe(404);
  });

  it("GET /api/resources/:kind/:id returns the lockfile entry for installed resources", async () => {
    const dir = writeSkillFixture("acme/widget");
    await call("POST", "/api/resources/install", { uri: dir, approve: true });
    const res = await call("GET", "/api/resources/skill/acme/widget");
    expect(res.status).toBe(200);
    const body = res.body as { entry: { kind: string; id: string; version: string } };
    expect(body.entry.kind).toBe("skill");
    expect(body.entry.id).toBe("acme/widget");
    expect(body.entry.version).toBe("1.0.0");
  });

  it("POST /api/resources/install with --frozen accepts a matching hash and rejects a drifted one", async () => {
    const dir = writeSkillFixture("acme/widget", "1.0.0");
    await call("POST", "/api/resources/install", { uri: dir, approve: true });

    const ok = await call("POST", "/api/resources/install", { uri: dir, frozen: true });
    expect(ok.status).toBe(200);
    expect((ok.body as { mode: string }).mode).toBe("frozen");

    // Drift the manifest: bump version, hash changes.
    writeFileSync(
      join(dir, "manifest.yaml"),
      `kind: skill\nid: acme/widget\nversion: 1.0.1\ndescription: "test skill"\n`,
      "utf8",
    );
    const drift = await call("POST", "/api/resources/install", { uri: dir, frozen: true });
    expect(drift.status).toBe(409);
    expect(drift.body as { error: string }).toMatchObject({ error: expect.stringMatching(/hash/) });
  });

  it("POST /api/resources/install rejects missing uri", async () => {
    const res = await call("POST", "/api/resources/install", {});
    expect(res.status).toBe(400);
  });

  it("GET /api/registry/search returns empty results when no query", async () => {
    const res = await call("GET", "/api/registry/search");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it("GET /api/trust starts empty", async () => {
    const res = await call("GET", "/api/trust");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publishers: [], resources: [] });
  });

  it("POST /api/trust/publisher adds and DELETE removes a publisher", async () => {
    const post = await call("POST", "/api/trust/publisher", {
      publicKey: "k1",
      publisher: "Alice",
    });
    expect(post.status).toBe(200);

    const list = await call("GET", "/api/trust");
    expect((list.body as { publishers: Array<{ publicKey: string }> }).publishers).toHaveLength(1);

    const del = await call("DELETE", "/api/trust/publisher/k1");
    expect(del.status).toBe(200);

    const list2 = await call("GET", "/api/trust");
    expect((list2.body as { publishers: unknown[] }).publishers).toHaveLength(0);
  });

  it("POST /api/trust/publisher rejects missing fields", async () => {
    const res = await call("POST", "/api/trust/publisher", { publicKey: "k1" });
    expect(res.status).toBe(400);
  });

  it("useApprovalQueue routes through /api/approvals and completes on approve", async () => {
    const dir = writeSkillFixture("queue/widget");
    const installPromise = call("POST", "/api/resources/install", {
      uri: dir,
      useApprovalQueue: true,
    });

    // The install request stays open until the approval resolves. Wait for the
    // request to land in the queue.
    let pending: Array<{ requestId: string; toolName: string }> = [];
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      const list = await call("GET", "/api/approvals");
      pending = (list.body as typeof pending) ?? [];
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("resource_install");

    const resolved = await call("POST", `/api/approvals/${pending[0].requestId}`, {
      approved: true,
    });
    expect(resolved.status).toBe(200);

    const installRes = await installPromise;
    expect(installRes.status).toBe(200);
    expect((installRes.body as { mode: string }).mode).toBe("approved");
  });

  it("authoring round-trips a skill through POST/GET/DELETE and registers it in the runtime", async () => {
    const post = await call("POST", "/api/authored/skill", {
      id: "myorg/reviewer",
      version: "1.0.0",
      description: "Reviews PRs",
      data: { instructions: "Be terse and direct.", toolRefs: ["read", "write"] },
    });
    expect(post.status).toBe(200);

    const list = await call("GET", "/api/authored?kind=skill");
    const listed = (list.body as { resources: Array<{ id: string }> }).resources;
    expect(listed.map((r) => r.id)).toContain("myorg/reviewer");

    expect(runtime.getSkillRegistry().get("myorg/reviewer")).toBeDefined();

    const del = await call("DELETE", "/api/authored/skill/myorg/reviewer");
    expect(del.status).toBe(200);

    const list2 = await call("GET", "/api/authored?kind=skill");
    expect((list2.body as { resources: unknown[] }).resources).toHaveLength(0);
    expect(runtime.getSkillRegistry().get("myorg/reviewer")).toBeUndefined();
  });

  it("authoring round-trips an agent through POST/GET/DELETE and registers it", async () => {
    const post = await call("POST", "/api/authored/agent", {
      id: "team/authored-bot",
      version: "1.0.0",
      description: "Authored via HTTP",
      data: {
        instructions: "Be terse.",
        tools: ["read"],
        temperature: 0.4,
      },
    });
    expect(post.status).toBe(200);

    expect(runtime.getAgentRegistry().get("team/authored-bot")?.instructions).toBe("Be terse.");

    const list = await call("GET", "/api/authored?kind=agent");
    const ids = (list.body as { resources: Array<{ id: string }> }).resources.map((r) => r.id);
    expect(ids).toContain("team/authored-bot");

    const del = await call("DELETE", "/api/authored/agent/team/authored-bot");
    expect(del.status).toBe(200);
    expect(runtime.getAgentRegistry().get("team/authored-bot")).toBeUndefined();
  });

  it("authoring rejects unsafe ids", async () => {
    const res = await call("POST", "/api/authored/prompt", {
      id: "../etc/passwd",
      data: { text: "hi" },
    });
    expect(res.status).toBe(400);
  });

  it("authoring rejects unsupported kinds", async () => {
    const res = await call("POST", "/api/authored/notakind", { id: "x" });
    expect(res.status).toBe(400);
  });

  it("useApprovalQueue returns 403 when the approver denies", async () => {
    const dir = writeSkillFixture("queue/denied");
    const installPromise = call("POST", "/api/resources/install", {
      uri: dir,
      useApprovalQueue: true,
    });

    let pending: Array<{ requestId: string }> = [];
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      const list = await call("GET", "/api/approvals");
      pending = (list.body as typeof pending) ?? [];
      if (pending.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(pending).toHaveLength(1);

    await call("POST", `/api/approvals/${pending[0].requestId}`, { approved: false });

    const installRes = await installPromise;
    expect(installRes.status).toBe(403);
    expect((installRes.body as { mode: string }).mode).toBe("denied");
  });
});
