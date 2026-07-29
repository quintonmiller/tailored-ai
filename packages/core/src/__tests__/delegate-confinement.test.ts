/**
 * What a delegated sub-agent inherits.
 *
 * `delegate` used to hand-build its `AgentLoopOptions`, carrying 13 of the ~25
 * fields `runtime.buildLoopOptions` sets — and none of the confinement ones. A
 * sub-agent got no sandbox, no `workingDirectoryBoundary`, and no agent name.
 *
 * That mattered because `delegate` is a meta tool appended to *every* agent
 * regardless of its `tools:` list, and the reference deployment runs
 * `permissions.defaultMode: auto`. So any agent could call
 * `delegate(agent="coder", …)` and run coder's `write`/`exec` on the host,
 * with coder's `sandbox: docker` silently inert — the same hole as #280,
 * reachable by a different route.
 *
 * These tests assert the boundary reaches the *tool*, not merely that an
 * option was set, because the option existing is not the property we want.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../agent/session.js";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import { DelegateTool } from "../tools/delegate.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

let db: Database.Database;
/** Every ToolContext the sub-agent's tool was called with. */
let seen: ToolContext[];
/**
 * A fresh home per test. The runtime migrates `agents:` from config into
 * `<contextDir>/../authored-resources` on construction, so a shared directory
 * makes the second test read the first one's manifests — the runtime reported
 * "drift detected" and resynced. Order-dependent tests hide exactly the kind of
 * inheritance bug this file exists to catch.
 */
let home: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  seen = [];
  home = mkdtempSync(join(tmpdir(), "tai-delegate-"));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

/** Records the context it is handed, so we can assert on what reached it. */
const probeTool: Tool = {
  name: "probe",
  description: "records its tool context",
  parameters: { type: "object", properties: {} },
  async execute(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    seen.push(context);
    return { success: true, output: "ok" };
  },
};

/** Calls `probe` once, then answers — enough to reach the tool layer. */
function probingProvider(): AIProvider {
  let calls = 0;
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(): Promise<ChatResponse> {
      calls++;
      if (calls > 1) {
        return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      }
      return {
        content: null,
        toolCalls: [{ id: "tc_1", name: "probe", arguments: {} }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  } as unknown as AIProvider;
}

function makeConfig(agents: Record<string, unknown>): AgentConfig {
  return {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: {
      defaultProvider: "openai_compatible",
      maxToolRounds: 3,
      maxHistoryTokens: 4000,
      temperature: 0.3,
      extraInstructions: "",
    },
    agents,
    channels: {},
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
    workflows: { directory: "./workflows" },
    tasks: { backend: "native" as const },
  } as unknown as AgentConfig;
}

function makeRuntime(config: AgentConfig): AgentRuntime {
  return new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: join(home, "context"),
      kbDir: join(home, "kb"),
      createTools: () => [probeTool],
      createProvider: () => ({ provider: probingProvider(), model: "x" }),
    },
    () => config,
    config,
  );
}

function makeDelegate(runtime: AgentRuntime): DelegateTool {
  return new DelegateTool({
    getConfig: () => runtime.getConfig(),
    db: runtime.db,
    getTools: () => runtime.getResolvableTools(),
    contextDir: runtime.contextDir,
    kbDir: runtime.kbDir,
    runtime,
  });
}

const callerCtx = (): ToolContext => ({ sessionId: "caller-session", workingDirectory: "/", env: {} }) as ToolContext;

describe("delegate — the sub-agent inherits its own confinement", () => {
  it("applies the target agent's declared fileBoundary", async () => {
    const config = makeConfig({
      contained: { fileBoundary: join(home, "allowed"), tools: ["probe"] },
    });
    const runtime = makeRuntime(config);

    await makeDelegate(runtime).execute({ agent: "contained", task: "go" }, callerCtx());

    expect(seen).toHaveLength(1);
    // The whole point: a sub-agent granted `write` is confined to where the
    // agent it is running as was declared to work.
    expect(seen[0].workingDirectoryBoundary).toBe(join(home, "allowed"));
  });

  it("attributes the run to the agent it is running as, not to nobody", async () => {
    const config = makeConfig({ contained: { tools: ["probe"] } });
    const runtime = makeRuntime(config);

    await makeDelegate(runtime).execute({ agent: "contained", task: "go" }, callerCtx());

    // Without this, every delegated write was attributed to no agent, which is
    // what made the memory-tool global-write warning unable to name a culprit.
    expect(seen[0].agentName).toBe("contained");
  });

  it("does not silently drop a boundary the target never declared", async () => {
    const config = makeConfig({ unbounded: { tools: ["probe"] } });
    const runtime = makeRuntime(config);

    await makeDelegate(runtime).execute({ agent: "unbounded", task: "go" }, callerCtx());

    // Absent, not empty-string: an empty boundary reads as "confined to
    // nowhere" in some checks and "unconfined" in others.
    expect(seen[0].workingDirectoryBoundary).toBeUndefined();
  });
});

describe("buildLoopOptions — includeMetaTools", () => {
  it("omits meta tools when asked, so a sub-agent gets no admin and no second delegate", () => {
    const config = makeConfig({ contained: { tools: ["probe"] } });
    const runtime = makeRuntime(config);
    runtime.setMetaTools([
      { name: "admin", description: "d", parameters: {}, execute: async () => ({ success: true, output: "" }) },
      { name: "delegate", description: "d", parameters: {}, execute: async () => ({ success: true, output: "" }) },
    ]);
    const session = newSession(db, "x", "openai_compatible", "s1");

    const withMeta = runtime.buildLoopOptions({ session, agentName: "contained" });
    const without = runtime.buildLoopOptions({ session, agentName: "contained", includeMetaTools: false });

    expect(withMeta.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["admin", "delegate"]));
    expect(without.tools.map((t) => t.name)).not.toContain("admin");
    expect(without.tools.map((t) => t.name)).not.toContain("delegate");
    // Its own tools are untouched — this narrows the appended set, not the agent.
    expect(without.tools.map((t) => t.name)).toContain("probe");
  });

  it("still honours a meta tool the agent named in its own tools list", () => {
    // Otherwise this would quietly revoke a capability the config granted on
    // purpose — a guard breaking the thing it was meant to leave alone.
    const config = makeConfig({ privileged: { tools: ["probe", "admin"] } });
    const runtime = makeRuntime(config);
    runtime.setMetaTools([
      { name: "admin", description: "d", parameters: {}, execute: async () => ({ success: true, output: "" }) },
    ]);
    const session = newSession(db, "x", "openai_compatible", "s1");

    const without = runtime.buildLoopOptions({ session, agentName: "privileged", includeMetaTools: false });

    expect(without.tools.map((t) => t.name)).toContain("admin");
  });
});
