/**
 * What happens when a tool call needs approval and nothing can ask.
 *
 * Cron, rooms, the task watcher and webhooks all run without an approval
 * handler. That branch used to be an empty block with a comment, so a policy of
 * `approve` quietly became `auto` in exactly the places nobody was watching —
 * the config said one thing and the deployment did another.
 *
 * It is still permissive by default, deliberately: flipping it would stop
 * autonomous runs that have worked for months. What changed is that it says so,
 * and that a deployment can now ask for the strict behaviour.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import type { PermissionsConfig } from "../approval.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";

let db: Database.Database;
let ran: number;

beforeEach(() => {
  db = initDatabase(":memory:");
  ran = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/**
 * A distinct tool name per test. `warnNoApprover` fires once per tool per
 * process — correct, since this is a property of how the deployment is wired
 * rather than of the turn — but it makes a shared name order-dependent.
 */
let toolName = "purchase";

const dangerousTool = (): Tool => ({
  name: toolName,
  description: "spends money",
  parameters: { type: "object", properties: {} },
  async execute(_args: Record<string, unknown>, _ctx: ToolContext) {
    ran++;
    return { success: true, output: "bought" };
  },
});

/** Calls the dangerous tool once, then answers. */
function makeProvider() {
  let count = 0;
  const provider: AIProvider = {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(): Promise<ChatResponse> {
      count++;
      if (count > 1) {
        return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      }
      return {
        content: null,
        toolCalls: [{ id: "tc_1", name: toolName, arguments: {} }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  };
  return provider;
}

const permissions = (noHandlerAction?: "auto" | "reject"): PermissionsConfig =>
  ({
    defaultMode: "auto",
    timeoutMs: 0,
    timeoutAction: "reject",
    tools: { [toolName]: { mode: "approve" } },
    ...(noHandlerAction ? { noHandlerAction } : {}),
  }) as PermissionsConfig;

const run = (perms: PermissionsConfig) =>
  runAgentLoop("go", {
    provider: makeProvider(),
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [dangerousTool()],
    extraInstructions: "",
    maxToolRounds: 4,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    permissions: perms,
    // No approvalHandler — this is the headless path.
  });

describe("runAgentLoop — approval with no approver", () => {
  it("still runs the call by default, preserving existing autonomous runs", async () => {
    toolName = "purchase_default";
    await run(permissions());

    expect(ran).toBe(1);
  });

  it("says so rather than passing in silence", async () => {
    toolName = "purchase_warns";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await run(permissions());

    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("purchase_warns");
    expect(said).toContain("no approver");
    expect(said).toContain("noHandlerAction");
  });

  it("refuses the call when the deployment asks it to", async () => {
    toolName = "purchase_reject";
    await run(permissions("reject"));

    expect(ran).toBe(0);
  });

  it("tells the agent why, so it can do something else", async () => {
    toolName = "purchase_explains";
    const provider = makeProvider();
    const seen: string[] = [];
    const recording: AIProvider = {
      ...provider,
      async chat(params) {
        for (const m of params.messages) {
          if (m.role === "tool" && typeof m.content === "string") seen.push(m.content);
        }
        return provider.chat(params);
      },
    };

    await runAgentLoop("go", {
      provider: recording,
      session: newSession(db, "fake-model", "fake"),
      db,
      tools: [dangerousTool()],
      extraInstructions: "",
      maxToolRounds: 4,
      maxHistoryTokens: 5000,
      temperature: 0.3,
      permissions: permissions("reject"),
    });

    expect(seen.join("\n")).toContain("needs approval");
  });

  it("does not gate a tool the policy allows", async () => {
    toolName = "purchase_ungated";
    const perms = {
      defaultMode: "auto",
      timeoutMs: 0,
      timeoutAction: "reject",
      tools: {},
      noHandlerAction: "reject",
    } as unknown as PermissionsConfig;

    await run(perms);

    expect(ran).toBe(1);
  });
});
