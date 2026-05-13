import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApprovalGate,
  AgentRuntime,
  ResourceAdminTool,
  TrustStore,
  hashManifest,
} from "../index.js";
import { initDatabase } from "../db/schema.js";
import type { AgentConfig } from "../config.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import type { AIProvider } from "../providers/interface.js";

function fakeTools(): Tool[] {
  return [
    {
      name: "memory",
      description: "fake memory",
      parameters: { type: "object", properties: {} },
      async execute(): Promise<ToolResult> {
        return { success: true, output: "" };
      },
    },
  ];
}

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: false,
    async chat() {
      return { content: "", usage: { input: 0, output: 0 }, finishReason: "stop" as const };
    },
  };
}

function buildRuntime(): AgentRuntime {
  const cfg = {
    agent: {
      defaultProvider: "openai_compatible",
      temperature: 0.3,
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      extraInstructions: "",
    },
    providers: { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } },
    agents: {},
    tools: {},
  } as unknown as AgentConfig;

  const tmp = mkdtempSync(join(tmpdir(), "tai-resadmin-"));
  const db = initDatabase(":memory:");

  return new AgentRuntime(
    {
      configPath: join(tmp, "config.yaml"),
      db,
      contextDir: join(tmp, "context"),
      kbDir: join(tmp, "kb"),
      createTools: () => fakeTools(),
      createProvider: () => ({ provider: fakeProvider(), model: "m" }),
    },
    () => cfg,
    cfg,
  );
}

function ctx(sessionId = "s1"): ToolContext {
  return {
    sessionId,
    workingDirectory: process.cwd(),
    env: process.env as Record<string, string>,
  };
}

describe("ResourceAdminTool", () => {
  it("creates an agent-authored skill and surfaces it in list", async () => {
    const runtime = buildRuntime();
    const tool = new ResourceAdminTool({ runtime });

    const created = await tool.execute(
      {
        action: "create",
        manifest: {
          kind: "skill",
          id: "agent-org/composer",
          version: "1.0.0",
          description: "Agent-authored skill",
          data: { instructions: "Be composer-like." },
        },
      },
      ctx(),
    );
    expect(created.success).toBe(true);
    expect(created.output).toContain("agent-org/composer");

    // Skill registry now contains it.
    const skill = runtime.getSkillRegistry().get("agent-org/composer");
    expect(skill?.instructions).toBe("Be composer-like.");

    // list reflects the new resource.
    const listed = await tool.execute({ action: "list", kind: "skill" }, ctx());
    expect(listed.output).toContain("agent-org/composer");
  });

  it("install denies untrusted https resources when no handler is wired", async () => {
    const runtime = buildRuntime();
    // Use a trust store at a temp path to avoid leaking into ~/.tailored-ai
    const trust = new TrustStore(join(mkdtempSync(join(tmpdir(), "trust-")), "trust.json"));
    const gate = new ApprovalGate({ trust }); // no handler
    const tool = new ResourceAdminTool({ runtime, approvalGate: gate });

    // Stub the loader to return a fake fetched resource — easier than running a fake HTTP server.
    (tool as any).loader = {
      addSource: () => {},
      getSource: () => undefined,
      load: async (uri: string) => ({
        manifest: { kind: "tool", id: "remote/sketchy", version: "1.0.0" },
        origin: { scheme: "https", uri, loadedAt: Date.now() },
        body: null,
      }),
    };

    const result = await tool.execute(
      { action: "install", uri: "https://example.com/sketchy" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("install denied");
  });

  it("install approves when trust store has a matching cached entry", async () => {
    const runtime = buildRuntime();
    const trust = new TrustStore(join(mkdtempSync(join(tmpdir(), "trust-")), "trust.json"));
    const gate = new ApprovalGate({ trust });
    const tool = new ResourceAdminTool({ runtime, approvalGate: gate });

    const cachedManifest = {
      kind: "prompt" as const,
      id: "cached/checklist",
      version: "1.0.0",
    };
    // Pre-approve.
    trust.approveResource(cachedManifest, "https://example.com/c", {});

    (tool as any).loader = {
      addSource: () => {},
      getSource: () => undefined,
      load: async (uri: string) => ({
        manifest: cachedManifest,
        origin: { scheme: "https", uri, loadedAt: Date.now() },
        body: null,
      }),
    };

    const result = await tool.execute(
      { action: "install", uri: "https://example.com/c" },
      ctx(),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("cached");
    // Verify it was correctly hashed.
    expect(hashManifest(cachedManifest)).toBe(hashManifest(cachedManifest));
  });

  it("delete removes a registered resource", async () => {
    const runtime = buildRuntime();
    const tool = new ResourceAdminTool({ runtime });

    await tool.execute(
      {
        action: "create",
        manifest: { kind: "prompt", id: "tmp/p", version: "1.0.0", data: { text: "hello" } },
      },
      ctx(),
    );
    expect(runtime.getPromptRegistry().get("tmp/p")).toBe("hello");
    const inspect = await tool.execute({ action: "inspect", kind: "prompt", id: "tmp/p" }, ctx());
    expect(inspect.success).toBe(true);

    const del = await tool.execute({ action: "delete", kind: "prompt", id: "tmp/p" }, ctx());
    expect(del.success).toBe(true);

    const inspect2 = await tool.execute({ action: "inspect", kind: "prompt", id: "tmp/p" }, ctx());
    expect(inspect2.success).toBe(false);
  });

  it("rejects unknown actions clearly", async () => {
    const runtime = buildRuntime();
    const tool = new ResourceAdminTool({ runtime });
    const r = await tool.execute({ action: "explode" }, ctx());
    expect(r.success).toBe(false);
    expect(r.error).toContain("unknown action");
  });
});
