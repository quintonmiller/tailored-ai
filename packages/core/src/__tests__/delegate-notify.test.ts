/**
 * Delegation outcomes: knowing a sub-agent failed, and hearing when it finished.
 *
 * Both from one live incident. An EA delegated a lookup synchronously; the
 * sub-agent ran out of tool rounds and `delegate` reported `success: true` with
 * the stall marker as its output, so the EA could not tell "answered" from "gave
 * up" and silently retried. The retry went async, succeeded in 49 seconds, and
 * nobody was told — the EA had promised a person a follow-up it had no mechanism
 * to make. The result sat unread for 51 minutes, and the registry's one-hour TTL
 * put it 9 minutes from being evicted unread.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTask, startTask } from "../agent/tasks.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Resolve after the microtask queue drains, so the .then() handlers have run. */
const settled = () => new Promise((r) => setTimeout(r, 5));

describe("startTask — completion hook", () => {
  it("fires on success, with the finished record", async () => {
    const seen: string[] = [];

    const info = startTask(
      "look up a restaurant",
      async () => "no events tonight",
      (done) => {
        seen.push(`${done.status}:${done.result}`);
      },
    );
    await settled();

    expect(seen).toEqual(["completed:no events tonight"]);
    expect(getTask(info.id)?.status).toBe("completed");
  });

  it("fires on failure too, so a dead delegation is not silent", async () => {
    const seen: string[] = [];

    startTask(
      "look something up",
      async () => {
        throw new Error("provider unreachable");
      },
      (done) => {
        seen.push(`${done.status}:${done.error}`);
      },
    );
    await settled();

    expect(seen).toEqual(["failed:provider unreachable"]);
  });

  it("still records the result when the notifier throws", async () => {
    // The result is the only thing recoverable afterwards. A broken notifier
    // must not take it down with it.
    const info = startTask(
      "x",
      async () => "the answer",
      () => {
        throw new Error("delivery exploded");
      },
    );
    await settled();

    expect(getTask(info.id)?.status).toBe("completed");
    expect(getTask(info.id)?.result).toBe("the answer");
  });

  it("still records the result when the notifier rejects", async () => {
    const info = startTask(
      "x",
      async () => "the answer",
      async () => {
        throw new Error("delivery exploded later");
      },
    );
    await settled();

    expect(getTask(info.id)?.result).toBe("the answer");
  });

  it("runs the task exactly as before when no hook is given", async () => {
    const info = startTask("x", async () => "done");
    await settled();

    expect(getTask(info.id)?.status).toBe("completed");
  });

  it("does not fire the hook before the record is updated", async () => {
    // Otherwise a notifier reading the record it was handed sees "running".
    let statusAtNotify: string | undefined;

    startTask(
      "x",
      async () => "r",
      (done) => {
        statusAtNotify = done.status;
      },
    );
    await settled();

    expect(statusAtNotify).toBe("completed");
  });
});

// --- DelegateTool: does the caller learn what happened? ------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import { DelegateTool } from "../tools/delegate.js";
import type { Tool, ToolContext } from "../tools/interface.js";

const noopTool: Tool = {
  name: "probe",
  description: "does nothing",
  parameters: { type: "object", properties: {} },
  execute: async () => ({ success: true, output: "ok" }),
};

/** `stall: true` never stops calling tools, so the loop hits its round cap. */
function provider(stall: boolean): AIProvider {
  let n = 0;
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(): Promise<ChatResponse> {
      n++;
      if (!stall && n > 1) {
        return { content: "the answer", usage: { input: 0, output: 0 }, finishReason: "stop" };
      }
      return {
        content: null,
        toolCalls: [{ id: `tc_${n}`, name: "probe", arguments: {} }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  } as unknown as AIProvider;
}

function harness(stall: boolean) {
  const db: Database.Database = initDatabase(":memory:");
  const home = mkdtempSync(join(tmpdir(), "tai-deleg-"));
  const config = {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: {
      defaultProvider: "openai_compatible",
      maxToolRounds: 2,
      maxHistoryTokens: 4000,
      temperature: 0.3,
      extraInstructions: "",
    },
    agents: { researcher: { tools: ["probe"], maxToolRounds: 2 } },
    channels: {},
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./c", kbDirectory: "./k" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
    workflows: { directory: "./w" },
    tasks: { backend: "native" as const },
  } as unknown as AgentConfig;

  const runtime = new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: join(home, "c"),
      kbDir: join(home, "k"),
      createTools: () => [noopTool],
      createProvider: () => ({ provider: provider(stall), model: "x" }),
    },
    () => config,
    config,
  );

  const delivered: Array<{ to: string; from: string; body: string }> = [];
  runtime.deliverAgentMessage = async (to, from, body) => {
    delivered.push({ to, from, body });
    return "";
  };

  const tool = new DelegateTool({
    getConfig: () => runtime.getConfig(),
    db: runtime.db,
    getTools: () => runtime.getResolvableTools(),
    contextDir: runtime.contextDir,
    kbDir: runtime.kbDir,
    runtime,
  });

  return {
    tool,
    delivered,
    cleanup: () => {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const ctx = (agentName?: string): ToolContext =>
  ({ sessionId: "s1", workingDirectory: "/", env: {}, agentName }) as ToolContext;

describe("delegate — a stalled sub-agent is not a success", () => {
  it("reports failure when the sub-agent runs out of tool rounds", async () => {
    const { tool, cleanup } = harness(true);

    const res = await tool.execute({ agent: "researcher", task: "look it up" }, ctx("quinton-executive-assistant"));

    // The live bug: success:true with the stall marker as output, so the caller
    // retried instead of reporting the problem.
    expect(res.success).toBe(false);
    expect(res.error).toContain("did not finish");
    expect(res.error).toContain("maxToolRounds");
    cleanup();
  });

  it("still reports success when the sub-agent actually answers", async () => {
    const { tool, cleanup } = harness(false);

    const res = await tool.execute({ agent: "researcher", task: "look it up" }, ctx("quinton-executive-assistant"));

    expect(res.success).toBe(true);
    cleanup();
  });
});

describe("delegate — async tells the truth about follow-up", () => {
  it("without notify, says nobody will tell you and names the way to collect it", async () => {
    const { tool, cleanup } = harness(false);

    const res = await tool.execute(
      { agent: "researcher", task: "look it up", async: true },
      ctx("quinton-executive-assistant"),
    );

    expect(res.output).toContain("Nobody will tell you");
    expect(res.output).toContain("task_status");
    expect(res.output).toContain("do not promise anyone a follow-up");
    cleanup();
  });

  it("with notify, delivers the result to the delegating agent", async () => {
    const { tool, delivered, cleanup } = harness(false);

    const res = await tool.execute(
      { agent: "researcher", task: "look it up", async: true, notify: true },
      ctx("quinton-executive-assistant"),
    );
    expect(res.output).toContain("You will be sent the result");
    await new Promise((r) => setTimeout(r, 80));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toBe("quinton-executive-assistant");
    expect(delivered[0].from).toBe("researcher");
    expect(delivered[0].body).toContain("has finished");
    cleanup();
  });

  it("says so when notify was asked for but there is nobody to notify", async () => {
    const { tool, delivered, cleanup } = harness(false);

    const res = await tool.execute({ agent: "researcher", task: "x", async: true, notify: true }, ctx(undefined));
    await new Promise((r) => setTimeout(r, 80));

    expect(delivered).toHaveLength(0);
    expect(res.output).toContain("no agent identity");
    cleanup();
  });
});
